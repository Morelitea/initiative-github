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
 */

import type { ContextClaims } from "initiative-app-kit";

import { config } from "../config.js";
import { credentialFor } from "./oauth.js";
import { workspaceFor } from "./workspace.js";

export interface CreateIssueInput {
  title?: unknown;
  body?: unknown;
  label?: unknown;
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
  const account = credentialFor(claims.connection_refs?.account);
  if (!account) return { ok: false, reason: "not-connected" };

  const workspace = workspaceFor(claims.app_install_id);
  if (!workspace) return { ok: false, reason: "not-configured" };

  const title = readText(input.title, 250);
  if (!title) return { ok: false, reason: "no-title" };

  const label = readText(input.label, 50);
  const payload: Record<string, unknown> = { title };
  const body = readText(input.body, 10_000);
  if (body) payload.body = body;
  if (label) payload.labels = [label];

  const response = await fetch(
    `${config.github.apiBase}/repos/${workspace.owner}/${workspace.repo}/issues`,
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
  // Only the outputs the node declared. A later node in the automation reads
  // these by name, so returning more would put the vendor's whole object into
  // a run's state.
  return { ok: true, issue_number: issue.number, issue_url: issue.html_url };
}
