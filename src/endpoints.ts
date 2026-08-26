/**
 * One call, whoever made it.
 *
 * Every endpoint this app declares is served here — the reads a widget draws
 * from and the writes an automation asks for — because they differ in what they
 * do and not in how they are reached. By the time a call arrives, the question
 * "who is this for" has one answer in one shape, and the rest of this file
 * never asks again which kind of token produced it.
 *
 * ## The caller, resolved once
 *
 * Two tokens reach this app and both terminate at the same fact: which of *this
 * app's own* connection refs the call is for.
 *
 * A context token carries the ref outright. A delegation token names the member
 * by a pairwise subject — opaque to everyone, including this app — which
 * Initiative maps to the identical handle. Either way what arrives is "the
 * member you know as `ref-abc`", never a name, an email or an Initiative user
 * id, so the privacy the pairwise subject exists for survives a write intact.
 *
 * {@link Caller} is that fact, and it lives in `caller.ts`. The server builds
 * one; nothing below it branches on where it came from.
 *
 * ## Why the credential stays here
 *
 * An automation service that held GitHub tokens would be a second place they
 * can leak from and a second thing to reason about when revoking. Keeping them
 * here means an organization's own installation grant is the whole of what any
 * caller can do at GitHub — listed in the organization's settings, scoped to
 * the repositories it picked, and revoked by the button that already lives
 * there. A caller sends an id and parameters; it never sees a token, never
 * learns which account acted, and cannot reach anything not declared.
 */

import type {
  ContextClaims,
  DelegationClaims,
  Endpoint,
  InvokeOutcome,
  InvokeRequest,
} from "initiative-app-kit";

import type { Caller } from "./caller.js";
import { initiative } from "./initiative.js";
import { installFor } from "./subscriptions.js";
import { credentialFor } from "./github/oauth.js";
import {
  dependabotAlerts,
  issueThroughput,
  openIssues,
  reviewQueue,
} from "./github/reads.js";
import {
  chooseActor,
  fail,
  failed,
  run,
  type OperationFailure,
} from "./github/writes.js";
import { workspaceFor } from "./github/workspace.js";
import { READ_IDS, manifest } from "./manifest.config.js";

export type { Caller } from "./caller.js";

/**
 * Everything this app answers, read off the manifest rather than restated.
 *
 * The declaration is the routing table, which is what keeps them from
 * disagreeing: an id nothing declares is refused before it reaches a handler,
 * and a handler with no declaration is unreachable rather than quietly callable.
 */
export const ENDPOINTS: readonly Endpoint[] = manifest.endpoints ?? [];

/** The read handlers, by the id that reaches them. */
const READS: Record<
  string,
  (caller: Caller, params: URLSearchParams) => Promise<Record<string, unknown>>
> = {
  [READ_IDS.openIssues]: openIssues,
  [READ_IDS.reviewQueue]: reviewQueue,
  [READ_IDS.dependabotAlerts]: dependabotAlerts,
  [READ_IDS.issueThroughput]: issueThroughput,
};

/**
 * Parameters as the reads want them.
 *
 * They arrive as JSON and are read as text: a param declared `int` is a number
 * on the wire and a string here, which is what every narrowing below does with
 * it anyway. Anything that is not a scalar is dropped rather than stringified
 * into `[object Object]`.
 */
function searchParams(params: Record<string, unknown>): URLSearchParams {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out.set(key, String(value));
    }
  }
  return out;
}

/**
 * The caller behind a context token.
 *
 * Everything needed is already in the claims: Initiative resolved the member
 * before it minted one, and `connection_refs` carries this app's own handle for
 * them. Absent means they have connected no GitHub account.
 */
export function callerFromContext(claims: ContextClaims): Caller {
  return {
    guildId: claims.guild_id,
    appInstallId: claims.app_install_id,
    connectionRef: claims.connection_refs?.account ?? null,
  };
}

/**
 * The caller behind a delegation token.
 *
 * Two lookups, because a delegate knows less than Initiative does. Which
 * install this guild has is the same question the subscription surface asks,
 * and a guild without this app has nothing here for anyone. Who the call is for
 * is the pairwise subject, which only Initiative can map to one of this app's
 * refs.
 *
 * A resolve that fails is not "this member has not connected" and is not
 * treated as one: it is logged and the ref is left null, so a read says so and
 * a write refuses, rather than either silently running as somebody else.
 */
export async function callerFromDelegate(
  claims: DelegationClaims
): Promise<Caller | OperationFailure> {
  const appInstallId = await installFor(claims.guildId);
  if (appInstallId === null) {
    return fail(404, "this app is not installed in that guild");
  }

  let connectionRef: string | null = null;
  try {
    const connection = await initiative.resolveDelegate(
      claims.guildId,
      claims.signer.publicId,
      claims.subject
    );
    if (connection && connection.status === "connected") {
      connectionRef = connection.connection_ref;
    }
  } catch (error) {
    console.warn(`could not resolve the delegated member: ${(error as Error).message}`);
  }

  return { guildId: claims.guildId, appInstallId, connectionRef };
}

/** The member's GitHub credential, or null if there is not one. */
async function memberToken(caller: Caller): Promise<string | null> {
  const account = await credentialFor(caller.connectionRef ?? undefined);
  return account?.accessToken ?? null;
}

/** Run one call, or say why not. */
export async function invoke(
  caller: Caller,
  request: InvokeRequest
): Promise<InvokeOutcome | OperationFailure> {
  // Non-null by construction: `parseInvoke` refuses an id this app does not
  // declare, and an emit, before anything reaches here.
  const endpoint = ENDPOINTS.find((candidate) => candidate.id === request.endpoint)!;

  if (endpoint.direction === "read") {
    // Reads report their own unavailability in the body rather than as a
    // status: a widget draws "connect your account" and a 4xx draws nothing.
    const result = await READS[endpoint.id](caller, searchParams(request.params));
    return { endpoint: endpoint.id, actor: "member", result };
  }

  const workspace = await workspaceFor(caller.appInstallId);

  // One supplier, because there is one actor. A write this app cannot resolve a
  // member for refuses rather than running as something else: substituting the
  // app would look like success and would be a different act by a different
  // party, able to reach whatever the *organization* granted rather than
  // whatever the person whose automation fired may touch.
  const actor = await chooseActor(endpoint, { member: () => memberToken(caller) });
  if (failed(actor)) return actor;

  const result = await run(endpoint.id, actor, workspace, request.params);
  if (failed(result)) return result;
  return { endpoint: endpoint.id, actor: result.actor, result: result.result };
}

export { fail, failed, type OperationFailure };
