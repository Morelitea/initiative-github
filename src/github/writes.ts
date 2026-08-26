/**
 * The write half: acting at GitHub on somebody else's behalf.
 *
 * Everything else this app does at GitHub is a read, and this file is the
 * exception that the permission list pays for. It exists because of where the
 * credential lives: an automation service that held GitHub tokens would be a
 * second place they can leak from and a second thing to reason about when
 * revoking. Keeping them here means an organization's own installation grant is
 * the whole of what any automation can do at GitHub — listed in the
 * organization's settings, scoped to the repositories it picked, and revoked by
 * the button that already lives there.
 *
 * So a caller sends an endpoint id and parameters. It never sees a token,
 * never learns which account acted, and cannot reach anything not in
 * {@link WRITE_ENDPOINTS}.
 *
 * ## Who the write is attributed to
 *
 * The member. Always, with no fallback.
 *
 * A delegation token names the member it acts for by a pairwise subject, which
 * Initiative resolves to one of *this app's own* connection refs — so the app
 * learns "this is the member you know as `ref-abc`", nothing more, and runs the
 * write on that member's own GitHub credential. The comment says who wrote it
 * and GitHub's audit log names a person, which is what somebody reading the
 * repository later needs.
 *
 * When that resolution comes back empty the operation refuses. Running it as
 * the app instead would look like success and would be a different act by a
 * different party — one able to reach whatever the *organization* granted
 * rather than whatever the person whose automation fired may touch.
 *
 * ## Why the set is closed
 *
 * A caller picks from endpoints written here; it never describes a request
 * this app then performs. That is the difference between an integration and a
 * proxy, and it is the whole reason this surface can be exposed at all.
 */

import type { ActorKind, Endpoint } from "initiative-app-kit";

import { isDigits } from "initiative-app-kit";

import { config } from "../config.js";
import { WRITE_IDS } from "../manifest.config.js";
import { resolveRepository } from "./app.js";
import type { StoredWorkspace } from "./workspace.js";

/** What this app could not do, in words a caller can act on. */
export interface OperationFailure {
  /**
   * A marker rather than a duck-typed check.
   *
   * Every step here returns "the thing, or a failure", and the alternative is
   * testing for an `error` key — which a *successful* GitHub body is perfectly
   * entitled to contain. One key that only this file ever sets removes the
   * question.
   */
  readonly failure: true;
  status: number;
  error: string;
}

export interface OperationSuccess {
  actor: ActorKind;
  result: Record<string, unknown>;
}

export type OperationResult = OperationSuccess | OperationFailure;

/** Build one. Always through here, so the marker cannot be forgotten. */
export function fail(status: number, error: string): OperationFailure {
  return { failure: true, status, error };
}

/** Narrow "the thing, or a failure" to the failure. */
export function failed<T extends object>(
  result: T | OperationFailure
): result is OperationFailure {
  return (result as OperationFailure).failure === true;
}

/** A credential and who it belongs to. Resolved once per invocation. */
export interface Actor {
  kind: ActorKind;
  token: string;
}

/**
 * Choose the credential to run on, given what the endpoint permits.
 *
 * The order is the declaration's order, which is why `actors` is a list rather
 * than a set: an endpoint states its preference, and this takes the first one
 * it can actually satisfy. A kind with no supplier is one this app cannot
 * offer, which reads the same as one that produced no credential.
 */
export async function chooseActor(
  endpoint: Endpoint,
  available: Partial<Record<ActorKind, () => Promise<string | null>>>
): Promise<Actor | OperationFailure> {
  for (const kind of endpoint.actors ?? []) {
    const token = await available[kind]?.();
    if (token) return { kind, token };
  }
  // One sentence, because there is one remedy: the member connects their
  // account. Nothing else can stand in for them.
  return fail(
    409,
    "this endpoint runs as the member, and no connected GitHub account could " +
      "be resolved for them"
  );
}

/** A string parameter, trimmed, or undefined. */
function text(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

/** An integer parameter, or undefined. `1` and `"1"` both count. */
function count(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && isDigits(value)) return Number(value);
  return undefined;
}

/** A list-of-strings parameter. A bare string counts as a list of one. */
function list(params: Record<string, unknown>, key: string): string[] {
  const value = params[key];
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * One call to GitHub's REST API, as the chosen actor.
 *
 * Errors are turned into a status and a sentence rather than thrown. GitHub's
 * own message is passed through — it is written for whoever is holding the
 * credential and is usually the most useful thing available ("Validation
 * Failed", "Resource not accessible by integration") — but nothing else from
 * the response is, because a body can carry repository content.
 */
async function call(
  actor: Actor,
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<Record<string, unknown> | OperationFailure> {
  let response: Response;
  try {
    response = await fetch(`${config.github.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${actor.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    return fail(502, `could not reach GitHub: ${(error as Error).message}`);
  }

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const parsed = (await response.json()) as { message?: unknown };
      if (typeof parsed.message === "string") detail = parsed.message;
    } catch {
      // GitHub answers JSON; a proxy in front of it may not, and the status is
      // then the whole of what is known.
    }
    // A member's own credential reaching less than the installation does is not
    // a fault to report as one — it is the member's access, working.
    return fail(response.status === 404 ? 404 : 502, detail);
  }

  if (response.status === 204) return {};
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** One GraphQL call, for the parts of GitHub that have no REST equivalent. */
async function graphql(
  actor: Actor,
  query: string,
  variables: Record<string, unknown>
): Promise<Record<string, unknown> | OperationFailure> {
  // The GraphQL endpoint hangs off the API base, which is why that is
  // configurable — on GitHub Enterprise it is a different host from the pages.
  const answer = await call(actor, "POST", "/graphql", { query, variables });
  if (failed(answer)) return answer;

  const errors = answer.errors;
  if (Array.isArray(errors) && errors.length) {
    const first = errors[0] as { message?: unknown };
    return fail(
      502,
      typeof first.message === "string" ? first.message : "GraphQL refused the call"
    );
  }
  return (answer.data as Record<string, unknown>) ?? {};
}

/** Only what the vendor identifies the thing by. Never the content back. */
function identifiers(
  body: Record<string, unknown>,
  keys: string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
}

/** Which repository this operation is about, resolved the same way a read is. */
async function where(
  workspace: StoredWorkspace | null,
  params: Record<string, unknown>
): Promise<{ owner: string; repo: string } | OperationFailure> {
  const choice = await resolveRepository(workspace, text(params, "repo") ?? null);
  if ("unavailable" in choice) {
    return fail(409, choice.unavailable);
  }
  return choice;
}

/**
 * Run one endpoint.
 *
 * The dispatch is a closed switch over {@link OPERATION_IDS} and the default
 * leg is unreachable by construction — the kit refuses an id this app does not
 * declare before anything gets here.
 */
export async function run(
  operationId: string,
  actor: Actor,
  workspace: StoredWorkspace | null,
  params: Record<string, unknown>
): Promise<OperationResult> {
  // Projects are organization-scoped and name no repository, so this one is
  // settled before the repository is resolved.
  if (operationId === WRITE_IDS.moveProjectItem) {
    return moveProjectItem(actor, params);
  }

  const place = await where(workspace, params);
  if (failed(place)) return place;
  const { owner, repo } = place;
  const base = `/repos/${owner}/${repo}`;

  switch (operationId) {
    case WRITE_IDS.openIssue: {
      const title = text(params, "title");
      if (!title) return fail(400, "title is required");
      const answer = await call(actor, "POST", `${base}/issues`, {
        title,
        ...(text(params, "body") ? { body: text(params, "body") } : {}),
        ...(list(params, "labels").length ? { labels: list(params, "labels") } : {}),
        ...(list(params, "assignees").length
          ? { assignees: list(params, "assignees") }
          : {}),
      });
      if (failed(answer)) return answer;
      return { actor: actor.kind, result: identifiers(answer, ["number", "html_url", "id"]) };
    }

    case WRITE_IDS.comment: {
      const number = count(params, "number");
      const body = text(params, "body");
      if (number === undefined) return fail(400, "number is required");
      if (!body) return fail(400, "body is required");
      // Issues and pull requests share this endpoint, which is why one
      // endpoint covers both.
      const answer = await call(actor, "POST", `${base}/issues/${number}/comments`, { body });
      if (failed(answer)) return answer;
      return { actor: actor.kind, result: identifiers(answer, ["id", "html_url"]) };
    }

    case WRITE_IDS.closeIssue:
    case WRITE_IDS.reopenIssue: {
      const number = count(params, "number");
      if (number === undefined) return fail(400, "number is required");
      const closing = operationId === WRITE_IDS.closeIssue;
      const reason = text(params, "reason");
      const answer = await call(actor, "PATCH", `${base}/issues/${number}`, {
        state: closing ? "closed" : "open",
        // `completed` or `not_planned`, and GitHub shows the difference in the
        // timeline — worth carrying rather than closing everything the same way.
        ...(closing && (reason === "completed" || reason === "not_planned")
          ? { state_reason: reason }
          : {}),
      });
      if (failed(answer)) return answer;
      return {
        actor: actor.kind,
        result: identifiers(answer, ["number", "state", "html_url"]),
      };
    }

    case WRITE_IDS.label: {
      const number = count(params, "number");
      if (number === undefined) return fail(400, "number is required");
      const add = list(params, "add");
      const remove = list(params, "remove");
      if (!add.length && !remove.length) {
        return fail(400, "name a label to add or to remove");
      }

      // Removals first, so a call that both removes and adds the same name ends
      // with it present rather than absent.
      for (const name of remove) {
        const answer = await call(
          actor,
          "DELETE",
          `${base}/issues/${number}/labels/${encodeURIComponent(name)}`
        );
        // A label that was not there is the state being asked for, not a
        // failure — this endpoint is idempotent by design, because an
        // automation re-running should not start erroring.
        if (failed(answer) && answer.status !== 404) return answer;
      }
      if (!add.length) return { actor: actor.kind, result: { number } };

      const answer = await call(actor, "POST", `${base}/issues/${number}/labels`, {
        labels: add,
      });
      if (failed(answer)) return answer;
      return { actor: actor.kind, result: { number } };
    }

    case WRITE_IDS.requestReview: {
      const number = count(params, "number");
      if (number === undefined) return fail(400, "number is required");
      const reviewers = list(params, "reviewers");
      const teams = list(params, "team_reviewers");
      if (!reviewers.length && !teams.length) {
        return fail(400, "name a reviewer or a team");
      }
      const answer = await call(actor, "POST", `${base}/pulls/${number}/requested_reviewers`, {
        ...(reviewers.length ? { reviewers } : {}),
        ...(teams.length ? { team_reviewers: teams } : {}),
      });
      if (failed(answer)) return answer;
      return { actor: actor.kind, result: identifiers(answer, ["number", "html_url"]) };
    }

    default:
      // Unreachable: the kit refuses an id this app does not declare
      // before the request reaches here. Answered rather than thrown, because
      // an unreachable branch that throws is a 500 the day it turns out to be
      // reachable.
      return fail(400, `nothing here runs '${operationId}'`);
  }
}

/**
 * Move one card on a Projects v2 board.
 *
 * The odd one out, three times over, which is why it sits apart:
 *
 *   * **GraphQL only.** Projects v2 has no REST surface, so this is the one
 *     call in the app that is not a REST call.
 *   * **Organization-scoped.** A board belongs to the organization rather than
 *     to a repository, so it names no repository and runs on the organization's
 *     own grant. That is also the one permission this app asks for that reaches
 *     past a repository, and the reason it is worth an endpoint of its own
 *     rather than being folded into a general "update".
 *   * **Ids, not names.** A caller supplies the project, item, field and option
 *     by node id. Resolving a column called "In review" to an option id is a
 *     query against the board's own schema and belongs to whoever is building
 *     the automation, not here — this app would have to guess which board.
 */
async function moveProjectItem(
  actor: Actor,
  params: Record<string, unknown>
): Promise<OperationResult> {
  const projectId = text(params, "project_id");
  const itemId = text(params, "item_id");
  const fieldId = text(params, "field_id");
  const optionId = text(params, "option_id");
  if (!projectId || !itemId || !fieldId || !optionId) {
    return fail(400, "project_id, item_id, field_id and option_id are all required");
  }

  const answer = await graphql(
    actor,
    `mutation Move($project: ID!, $item: ID!, $field: ID!, $option: String!) {
       updateProjectV2ItemFieldValue(input: {
         projectId: $project, itemId: $item, fieldId: $field,
         value: { singleSelectOptionId: $option }
       }) { projectV2Item { id } }
     }`,
    { project: projectId, item: itemId, field: fieldId, option: optionId }
  );
  if (failed(answer)) return answer;

  const moved = (answer.updateProjectV2ItemFieldValue as { projectV2Item?: { id?: unknown } })
    ?.projectV2Item;
  return { actor: actor.kind, result: { item_id: moved?.id ?? itemId } };
}
