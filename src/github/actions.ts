/**
 * What the automation service asks this app to do.
 *
 * An action is the one place an app *writes* at its vendor, and the rule that
 * makes it safe is the same one the data sources keep: it runs as the member
 * whose credential the context token names, never from an app-wide token. An
 * automation that opens issues opens them as the person who set it up, and
 * stops working when they disconnect — which is what makes revoking mean
 * something.
 *
 * The token carries `action_id`, so a credential minted to fetch a dashboard
 * source cannot be replayed here; the route checks it before this is called.
 *
 * **The answer is an envelope**, and the data sits inside it:
 *
 * ```jsonc
 * { "ok": true, "outputs": { "issue_number": 12, "issue_url": "…" } }
 * ```
 *
 * `ok` says whether the operation did its work — false ends the branch, with a
 * short `reason` for the run log. A condition adds `passed`, which defaults to
 * `ok`. Everything the node declared as an output goes under `outputs`, and
 * anything it did not declare is dropped there rather than carried into the run.
 */

import type { ContextClaims } from "initiative-app-kit";

import { config } from "../config.js";
import { resolveRepository } from "./app.js";
import { credentialFor } from "./oauth.js";
import { workspaceFor } from "./workspace.js";

export interface CreateIssueInput {
  title?: unknown;
  body?: unknown;
  label?: unknown;
  /**
   * Which repository to open it in.
   *
   * An automation names one because an install may cover several, and a run
   * that guessed would open somebody else's issue. Left out where the install
   * covers exactly one, which is the common case and the one worth not making
   * anybody type.
   */
  repository?: unknown;
}

/** Trimmed to what the node's fields declared, so nothing else can ride along. */
function readText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

export async function createIssue(
  claims: ContextClaims,
  input: CreateIssueInput
): Promise<Record<string, unknown>> {
  const account = await credentialFor(claims.connection_refs?.account);
  if (!account) return { ok: false, reason: "not-connected" };

  // The same question the read path asks, answered the same way and from the
  // same place: may this install touch that repository? The credential differs
  // — this writes as the member — and the grant it is checked against does not.
  const where = await resolveRepository(
    await workspaceFor(claims.app_install_id),
    readText(input.repository, 100)
  );
  if ("unavailable" in where) return { ok: false, reason: where.unavailable };

  const title = readText(input.title, 250);
  if (!title) return { ok: false, reason: "no-title" };

  const label = readText(input.label, 50);
  const payload: Record<string, unknown> = { title };
  const body = readText(input.body, 10_000);
  if (body) payload.body = body;
  if (label) payload.labels = [label];

  const response = await fetch(
    `${config.github.apiBase}/repos/${where.owner}/${where.repo}/issues`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.accessToken}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }
  );
  if (!response.ok) return { ok: false, reason: "vendor-error" };

  const issue = (await response.json()) as { number?: number; html_url?: string };
  // Only the outputs the node declared, and under `outputs` rather than beside
  // `ok`. A later node in the automation reads these by name, so returning more
  // would put the vendor's whole object into a run's state — and returning them
  // flat would mean an app could never declare an output called `ok`, `passed`
  // or `reason`, because an envelope field and a data field would be competing
  // for one namespace.
  //
  // The repository is among them because an install may cover several, so
  // "which one did this land in" is a real question downstream.
  return {
    ok: true,
    outputs: {
      issue_number: issue.number,
      issue_url: issue.html_url,
      repository: where.repo,
    },
  };
}
