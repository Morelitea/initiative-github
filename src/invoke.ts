import type {
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
  type OperationFailure,
} from "./github/api.js";
import { workspaceFor } from "./workspace.js";

export type { Caller } from "./endpoints/index.js";

function searchParams(params: Record<string, unknown>): URLSearchParams {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
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
    const result = await READ_HANDLERS[endpoint.id](caller, searchParams(request.params));
    return { endpoint: endpoint.id, actor: "member", result };
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
