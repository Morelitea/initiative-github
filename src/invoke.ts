import type {
  ActorKind,
  ContextClaims,
  DelegationClaims,
  Endpoint,
  InvokeOutcome,
  InvokeRequest,
} from "initiative-app-kit";

import type { Caller } from "./endpoints/index.js";
import { initiative } from "./initiative.js";
import { installFor } from "./platform.js";
import { credentialFor } from "./github/oauth.js";
import {
  ENDPOINTS,
  READ_HANDLERS,
  WRITE_HANDLERS,
} from "./endpoints/index.js";
import {
  chooseActor,
  fail,
  failed,
  resolveActor,
  type OperationFailure,
} from "./github/api.js";
import { workspaceFor } from "./workspace.js";

export type { Caller } from "./endpoints/index.js";

/**
 * The wire's parameters as a read's own `URLSearchParams`.
 *
 * A parameter this manifest declares `list` — labels, assignees, reviewers —
 * arrives as an **array**, because that is what declaring `list` is for: the
 * alternative it replaces is an app declaring a string and documenting a comma,
 * which nothing upstream can validate or fill a menu for. Every read here takes
 * several values through `readNames`, which splits on commas, so this is where
 * the two meet.
 *
 * Dropping an array instead — which is what this did — is the quiet kind of
 * wrong: a caller that asked for the "bug" label got every issue, with nothing
 * anywhere saying the filter had been ignored.
 */
function searchParams(params: Record<string, unknown>): URLSearchParams {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      const several = value
        .filter(
          (entry): entry is string | number | boolean =>
            typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean"
        )
        .map((entry) => String(entry).trim())
        .filter(Boolean);
      if (several.length) out.set(key, several.join(","));
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out.set(key, String(value));
    }
  }
  return out;
}

export function callerFromContext(claims: ContextClaims): Caller {
  return {
    guildId: claims.guild_id,
    appInstallId: claims.app_install_id,
    connectionRef: claims.connection_refs?.account ?? null,
  };
}

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

/**
 * Which credentials this call may run on, best first.
 *
 * What the endpoint declared, narrowed where the parameters make the call
 * personal. `@me` is GitHub's word for "whoever this token belongs to", and an
 * installation token belongs to nobody — so a search carrying one has to run
 * as a person or not run at all. Read off the values rather than off a
 * parameter name, because it is a convention of GitHub's search syntax and not
 * a property of any one field this app declares.
 */
function actorsFor(
  endpoint: Endpoint,
  params: Record<string, unknown>
): readonly ActorKind[] {
  const personal = Object.values(params).some(
    (value) => typeof value === "string" && value.trim() === "@me"
  );
  return personal ? ["member"] : (endpoint.actors ?? ["member"]);
}

async function memberToken(caller: Caller): Promise<string | null> {
  const account = await credentialFor(caller.connectionRef ?? undefined);
  return account?.accessToken ?? null;
}

export async function invoke(
  caller: Caller,
  request: InvokeRequest
): Promise<InvokeOutcome | OperationFailure> {
  // Non-null by construction: `parseInvoke` refuses an id this app does not
  // declare, and an emit, before anything reaches here.
  const endpoint = ENDPOINTS.find((candidate) => candidate.id === request.endpoint)!;

  if (endpoint.direction === "read") {
    // Resolved once here and handed down, so every helper the endpoint reaches
    // runs on the same credential and the answer below is the one that ran
    // rather than the one that would have.
    const asking: Caller = { ...caller, actors: actorsFor(endpoint, request.params) };
    asking.resolved = await resolveActor(asking);

    const result = await READ_HANDLERS[endpoint.id](asking, searchParams(request.params));

    // Reported rather than assumed. Which credential answered decides what the
    // numbers mean — a member sees their own view of the repository, the
    // installation sees the organization's — and a caller is entitled to know
    // which it got.
    return {
      endpoint: endpoint.id,
      actor: "unavailable" in asking.resolved ? "member" : asking.resolved.actor,
      result,
    };
  }

  const workspace = await workspaceFor(caller.appInstallId);

  const actor = await chooseActor(endpoint, { member: () => memberToken(caller) });
  if (failed(actor)) return actor;

  const result = await WRITE_HANDLERS[endpoint.id](actor, workspace, request.params);
  if (failed(result)) return result;
  return { endpoint: endpoint.id, actor: result.actor, result: result.result };
}

export { ENDPOINTS } from "./endpoints/index.js";
export { fail, failed, type OperationFailure };
