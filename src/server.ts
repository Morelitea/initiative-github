import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  DelegationTokenError,
  JwksCache,
  answerChallenge,
  bearerToken,
  delegateHeader,
  isDigits,
  parseInvoke,
  returnAddress,
  verifyContextToken,
  verifyDelegationToken,
  type ConnectOutcome,
  type ContextClaims,
  type DelegationClaims,
} from "initiative-app-kit";

import { config } from "./config.js";
import { close, migrate, pool } from "./db.js";
import { document } from "./listing.config.js";
import { manifest } from "./manifest.config.js";
import {
  CALLBACK_PATH,
  CONNECT_PATH,
  ENDPOINTS_PATH,
  INSTALL_PATH,
  SETUP_PATH,
  SUBSCRIPTIONS_PATH,
  WEBHOOK_PATH,
} from "./vocabulary.js";
import {
  installIsGone,
  listSubscriptions,
  spendToken,
  subscribe,
  unsubscribe,
} from "./platform.js";
import type { Caller } from "./endpoints/index.js";
import {
  ENDPOINTS,
  callerFromContext,
  callerFromDelegate,
  failed,
  invoke,
} from "./invoke.js";
import { installUrl } from "./github/app.js";
import { beginInstall, beginOAuth, completeOAuth, landingFor } from "./github/oauth.js";
import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  SIGNATURE_HEADER,
  handleDelivery,
  verifySignature,
} from "./github/webhooks.js";
import { forgetInstall, startSync, syncInstall } from "./platform.js";

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;margin:4rem auto;max-width:44rem;padding:0 1rem}
</style>
</head><body><h1>${title}</h1><p>${body}</p></body></html>`;
}

const jwks = new JwksCache();

function guildFrom(params: URLSearchParams): number | null {
  const raw = params.get("guild_id");
  if (raw === null || !isDigits(raw)) return null;
  const guildId = Number(raw);
  return Number.isSafeInteger(guildId) && guildId > 0 ? guildId : null;
}

const NO_GUILD = page(
  "Cannot connect from here",
  "Open this app's settings in Initiative and connect from there. If you did, " +
    "this deployment's Initiative may be older than this app."
);

const ENDINGS: Record<ConnectOutcome, string> = {
  connected: page("Connected", "You can close this tab and go back to Initiative."),
  refused: page(
    "Not connected",
    "GitHub did not complete the sign-in. Nothing changed — start again from " +
      "the app's settings in Initiative."
  ),
  expired: page(
    "Could not connect",
    "That link has expired. Start again from the app's settings in Initiative."
  ),
  not_recorded: page(
    "Nearly there",
    "GitHub authorized this app, but Initiative did not record it. Try " +
      "connecting again from the app's settings — nothing was lost."
  ),
};

function homeFrom(url: URL): string | null {
  return returnAddress({ secret: config.appSecret, params: url.searchParams });
}

function header(req: IncomingMessage, name: string): string | undefined {
  const found = req.headers[name];
  return Array.isArray(found) ? found[0] : found;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;

    if (total > 1_000_000) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  sendBytes(res, status, JSON.stringify(body));
}

function sendBytes(res: ServerResponse, status: number, payload: string): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const MANIFEST_DOCUMENT = JSON.stringify(document);

function sendPage(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),

    "Content-Security-Policy": "frame-ancestors 'none'",
  });
  res.end(html);
}

async function context(
  req: IncomingMessage,
  res: ServerResponse,
  expected: { scope: ContextClaims["scope"]; endpointId?: string }
): Promise<ContextClaims | null> {
  const token = bearerToken(req.headers);
  if (!token) {
    send(res, 401, { error: "no context token" });
    return null;
  }
  try {
    const claims = await verifyContextToken(token, {
      publicId: manifest.service.public_id,
      baseUrl: config.initiativeBaseUrl,
      jwks,
    });

    if (claims.scope !== expected.scope) {
      send(res, 403, { error: "token is not for this scope" });
      return null;
    }

    if (expected.endpointId && claims.endpoint_id !== expected.endpointId) {
      send(res, 403, { error: "token is not for this endpoint" });
      return null;
    }
    return claims;
  } catch (error) {
    send(res, 401, { error: (error as Error).message });
    return null;
  }
}

async function delegate(
  req: IncomingMessage,
  res: ServerResponse
): Promise<DelegationClaims | null> {
  const token = bearerToken(req.headers);
  const named = delegateHeader(req.headers);
  if (!token || !named) {
    send(res, 401, { error: "no delegation token" });
    return null;
  }

  let claims: DelegationClaims;
  try {
    claims = await verifyDelegationToken(token, {
      publicId: manifest.service.public_id,
      delegate: named,
      baseUrl: config.initiativeBaseUrl,
      jwks,
    });
  } catch (error) {
    if (error instanceof DelegationTokenError) {
      send(res, 401, { error: "that token did not verify" });
    } else {
      console.error("delegation check failed", error);
      send(res, 503, { error: "could not check that token" });
    }
    return null;
  }

  if (!(await spendToken(claims.jti, claims.expiresAt))) {
    send(res, 401, { error: "that token has already been used" });
    return null;
  }
  return claims;
}

export const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://placeholder");
  const path = url.pathname;

  try {
    if (req.method === "GET" && path === "/healthz") {
      return send(res, 200, { ok: true });
    }
    if (req.method === "GET" && path === "/readyz") {
      try {
        await pool.query("SELECT 1");
        return send(res, 200, { ok: true });
      } catch {
        return send(res, 503, { ok: false });
      }
    }

    if (req.method === "GET" && path === "/.well-known/initiative-app.json") {
      return sendBytes(res, 200, MANIFEST_DOCUMENT);
    }

    if (req.method === "POST" && path === "/v1/handshake") {
      const body = JSON.parse((await readBody(req)).toString("utf-8")) as {
        challenge?: string;
      };
      if (!body.challenge) return send(res, 400, { error: "no challenge" });
      return send(res, 200, {
        signature: answerChallenge(config.appSecret, body.challenge),
      });
    }

    if (req.method === "POST" && path === "/v1/lifecycle") {
      const claims = await context(req, res, { scope: "lifecycle" });
      if (!claims) return;

      try {
        await syncInstall(claims.guild_id);
      } catch (error) {
        console.error(`lifecycle sync failed for guild ${claims.guild_id}`, error);
        // Drop the install only when Initiative says there is no install to
        // sync. Repairing a stale workspace is what the poll is for; this only
        // has to not destroy a good one.
        if (installIsGone(error)) await forgetInstall(claims.app_install_id);
      }

      return send(res, 204, null);
    }

    if (req.method === "GET" && path === CONNECT_PATH) {
      const connectionRef = url.searchParams.get("connection_ref");
      if (!connectionRef) return send(res, 400, { error: "no connection_ref" });

      const guildId = guildFrom(url.searchParams);
      if (guildId === null) return sendPage(res, NO_GUILD);

      const redirect = await beginOAuth(connectionRef, guildId, homeFrom(url));
      res.writeHead(302, { Location: redirect });
      return res.end();
    }

    if (req.method === "GET" && path === CALLBACK_PATH) {
      const result = await completeOAuth(url.searchParams);

      // An admin just recorded the guild's organization. The poll would find
      // it within the sync interval; syncing now is the difference between a
      // dashboard that works when they get back and one that works in five
      // minutes. A failure here is not the admin's problem — the workspace is
      // written down, and the next poll rebuilds what this missed.
      if (result.installedFor !== undefined) {
        try {
          await syncInstall(result.installedFor);
        } catch (error) {
          console.error(`could not sync guild ${result.installedFor} after an install`, error);
        }
      }

      const home = landingFor(result);
      if (home) {
        res.writeHead(302, { Location: home });
        return res.end();
      }

      return sendPage(res, ENDINGS[result.outcome]);
    }

    if (req.method === "GET" && path === INSTALL_PATH) {
      const connectionRef = url.searchParams.get("connection_ref");
      const guildId = connectionRef ? guildFrom(url.searchParams) : null;
      if (connectionRef && guildId === null) return sendPage(res, NO_GUILD);

      const redirect =
        connectionRef && guildId !== null
          ? await beginInstall(connectionRef, guildId, homeFrom(url))
          : await installUrl();
      if (!redirect) {
        return send(res, 503, { error: "this app is not registered at GitHub" });
      }
      res.writeHead(302, { Location: redirect });
      return res.end();
    }

    if (req.method === "GET" && path === SETUP_PATH) {
      // Where GitHub sends somebody who installed or reconfigured this app
      // from GitHub's own pages rather than from Initiative. Nothing arrives
      // here that says which guild it is for — that is what the connect flow
      // carries — so this page has one job: say where the other half is.
      return sendPage(
        res,
        page(
          "Installed at GitHub",
          "That half is done. Now open this app's settings in Initiative and " +
            "press <b>Connect</b> on the GitHub organization — that is what " +
            "tells your guild which installation is its own. If you started " +
            "from there, you are already finished."
        )
      );
    }

    if (path === ENDPOINTS_PATH && (req.method === "GET" || req.method === "POST")) {
      if (req.method === "GET") {
        return send(res, 200, {
          public_id: manifest.service.public_id,
          endpoints: ENDPOINTS,
        });
      }

      let body: unknown;
      try {
        body = JSON.parse((await readBody(req)).toString("utf-8"));
      } catch {
        return send(res, 400, { error: "body is not json" });
      }

      const parsed = parseInvoke(body, ENDPOINTS);
      if (!parsed.ok) return send(res, 400, { error: parsed.error });

      let caller: Caller;
      if (delegateHeader(req.headers)) {
        const claims = await delegate(req, res);
        if (!claims) return;
        if (parsed.request.guild_id !== claims.guildId) {
          return send(res, 403, { error: "that token is for another guild" });
        }
        const resolved = await callerFromDelegate(claims);
        if (failed(resolved)) {
          return send(res, resolved.status, { error: resolved.error });
        }
        caller = resolved;
      } else {
        const claims = await context(req, res, {
          scope: "endpoint",
          endpointId: parsed.request.endpoint,
        });
        if (!claims) return;
        if (parsed.request.guild_id !== claims.guild_id) {
          return send(res, 403, { error: "that token is for another guild" });
        }
        caller = callerFromContext(claims);
      }

      const outcome = await invoke(caller, parsed.request);
      if ("error" in outcome) return send(res, outcome.status, { error: outcome.error });
      return send(res, 200, outcome);
    }

    if (path === SUBSCRIPTIONS_PATH && (req.method === "POST" || req.method === "GET")) {
      const claims = await delegate(req, res);
      if (!claims) return;

      if (req.method === "GET") {
        return send(res, 200, {
          items: await listSubscriptions(claims.signer.publicId, claims.guildId),
        });
      }

      let body: unknown;
      try {
        body = JSON.parse((await readBody(req)).toString("utf-8"));
      } catch {
        return send(res, 400, { error: "body is not json" });
      }
      const result = await subscribe(claims.signer.publicId, claims.guildId, body);
      if (!result.ok) return send(res, result.status, { error: result.error });

      return send(res, 201, { ...result.view, secret: result.secret });
    }

    if (req.method === "DELETE" && path.startsWith(`${SUBSCRIPTIONS_PATH}/`)) {
      const id = Number(path.slice(SUBSCRIPTIONS_PATH.length + 1));
      if (!Number.isInteger(id)) return send(res, 404, { error: "no such subscription" });

      const claims = await delegate(req, res);
      if (!claims) return;

      const removed = await unsubscribe(claims.signer.publicId, claims.guildId, id);
      if (!removed) return send(res, 404, { error: "no such subscription" });
      return send(res, 204, null);
    }

    if (req.method === "POST" && path === WEBHOOK_PATH) {
      const body = await readBody(req);
      if (!verifySignature(body, header(req, SIGNATURE_HEADER))) {
        return send(res, 401, { error: "bad signature" });
      }

      const event = header(req, EVENT_HEADER);
      if (!event) return send(res, 400, { error: "no event type" });

      if (event === "ping") return send(res, 200, { ok: true });

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(body.toString("utf-8")) as Record<string, unknown>;
      } catch {
        return send(res, 400, { error: "body is not json" });
      }

      const result = await handleDelivery(
        event,
        payload,
        header(req, DELIVERY_HEADER) ?? "",
      );

      if (result.reason) {
        console.log(
          `delivery ${header(req, DELIVERY_HEADER) ?? "?"} (${event}): ${result.reason}`
        );
      }
      return send(res, 200, { resynced: result.resynced, published: result.published });
    }

    return send(res, 404, { error: "no such route" });
  } catch (error) {
    console.error("request failed", error);
    return send(res, 500, { error: "internal error" });
  }
});

let sync: { stop: () => void } | null = null;

async function start(): Promise<void> {
  await migrate();
  server.listen(config.port, () => {
    console.log(`${manifest.service.public_id} listening on :${config.port}`);
  });

  sync = startSync();
}

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, shutting down`);
  sync?.stop();
  server.close(async () => {
    await close();
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 10_000).unref();
}

if (process.env.NODE_ENV !== "test") {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => void shutdown(signal));
  }
  start().catch((error) => {
    console.error("could not start", error);
    process.exit(1);
  });
}
