/**
 * Turning a verified delegate's request into a write at GitHub.
 *
 * Three questions, in order, and each is somebody else's answer:
 *
 *   1. **Which repository, and is this app installed there?** The guild's own
 *      configuration says, exactly as it does for a read.
 *   2. **Whose credential?** The operation states its preference; this resolves
 *      the first one it can actually satisfy.
 *   3. **What does GitHub say?** `github/operations.ts` makes the call.
 *
 * The interesting one is the second, and it is the reason this file exists
 * rather than the route calling GitHub directly.
 *
 * ## Resolving the member without learning who they are
 *
 * A delegation token names the member it acts for by a **pairwise subject** —
 * minted for the delegate, opaque to everyone, and meaningless in this app's
 * namespace. On its own it says only "some member, in this guild".
 *
 * It does not have to stay that way. Initiative can map that subject to one of
 * *this app's own* connection refs, which is the identical handle a context
 * token hands over on the read path. So the app learns "this call is for the
 * member you know as `ref-abc`", looks that member's GitHub credential up in
 * its own store, and writes as them. It never learns a name, an email, an
 * Initiative user id, or anything that correlates with what another app knows
 * about the same person — the privacy property the pairwise subject exists for
 * survives the write path intact.
 *
 * When there is no such member — nobody has connected, or the deployment does
 * not answer that lookup — the operation falls back to the installation if it
 * permits one, and refuses if it does not. Which of the two ran is reported on
 * every success, because an app acting as itself has done something different
 * from what was asked.
 */

import type { DelegationClaims, InvokeRequest, InvokeOutcome } from "initiative-app-kit";

import { initiative } from "./initiative.js";
import {
  OPERATIONS,
  chooseActor,
  fail,
  failed,
  run,
  type OperationFailure,
} from "./github/operations.js";
import { credentialFor } from "./github/oauth.js";
import { workspaceFor } from "./github/workspace.js";
import { installFor } from "./events.js";

/**
 * Which of this app's members the caller is acting for, or null.
 *
 * Best effort by design. A deployment that has not got the resolve route
 * answers the same as a member who has connected nothing, and both mean the
 * same thing here: there is no member credential, so the operation's own
 * `actors` list decides what happens next.
 */
async function memberToken(claims: DelegationClaims): Promise<string | null> {
  let connection;
  try {
    connection = await initiative.resolveDelegate(
      claims.guildId,
      claims.signer.publicId,
      claims.subject
    );
  } catch (error) {
    // A platform that is down is not "this member has not connected", but it
    // has the same remedy at this point: run as the installation where the
    // operation permits it. Logged rather than swallowed, because a write
    // silently changing actor for the length of an outage is worth seeing.
    console.warn(`could not resolve the delegated member: ${(error as Error).message}`);
    return null;
  }
  if (!connection || connection.status !== "connected") return null;

  const account = await credentialFor(connection.connection_ref);
  return account?.accessToken ?? null;
}

/** Run one invocation, or say why not. */
export async function invoke(
  claims: DelegationClaims,
  request: InvokeRequest
): Promise<InvokeOutcome | OperationFailure> {
  // Non-null by construction: `parseInvoke` refuses an id this app does not
  // declare before anything reaches here.
  const operation = OPERATIONS.find((candidate) => candidate.id === request.operation)!;

  // Same question the subscription surface asks, and the same answer: a guild
  // that does not have this app has nothing here to run.
  const appInstallId = await installFor(claims.guildId);
  if (appInstallId === null) {
    return fail(404, "this app is not installed in that guild");
  }
  const workspace = await workspaceFor(appInstallId);

  // One supplier, because there is one actor. An operation this app cannot
  // resolve a member for refuses rather than running as something else.
  const actor = await chooseActor(operation, { member: () => memberToken(claims) });
  if (failed(actor)) return actor;

  const result = await run(request.operation, actor, workspace, request.params);
  if (failed(result)) return result;
  return { operation: request.operation, actor: result.actor, result: result.result };
}
