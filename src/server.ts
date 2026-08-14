/**
 * The whole protocol surface of an Initiative app, in one file.
 *
 * Five kinds of route, and the split is the point — each is authenticated by a
 * different party, which is why no two of them share a check:
 *
 * - **`/.well-known/initiative-app.json`** — unauthenticated. The manifest is
 *   public by design; it forbids anything whose secrecy could matter.
 * - **`/v1/handshake`** — the operator wiring this app up proves they hold the
 *   same secret, and so does this app. Neither sends it.
 * - **`/data/*` and `/actions/*`** — Initiative calling in, carrying a context
 *   token naming one guild, one install and one scope. Verified per call.
 * - **`/connect/*`** — a person's browser, running the vendor's flow. The one
 *   page this app serves; it mounts no embedded surface of its own.
 * - **`/webhooks/github`** — the *vendor* calling in, verified against GitHub's
 *   own webhook secret rather than against Initiative's. This is the trigger
 *   half of the automation surface: a delivery here becomes an event in every
 *   guild watching that repository.
 *
 * Calls in the other direction — pulling installs, emitting events — go through
 * `initiative.ts`, and everything about which installs exist comes from
 * `sync.ts` rather than from anything a caller asserts.
 *
 * Deliberately plain `node:http` with no framework. An app can use whatever it
 * likes; showing the protocol against the standard library keeps the parts that
 * matter visible instead of buried in middleware.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  JwksCache,
  answerChallenge,
  bearerToken,
  verifyContextToken,
  type ContextClaims,
} from "initiative-app-kit";

import { config } from "./config.js";
import { close, migrate, pool } from "./db.js";
import { manifest } from "./manifest.config.js";
import { createIssue } from "./github/actions.js";
import { issueThroughput, openIssues, reviewQueue } from "./github/queries.js";
import { beginOAuth, completeOAuth } from "./github/oauth.js";
import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  SIGNATURE_HEADER,
  handleDelivery,
  verifySignature,
} from "./github/webhooks.js";
import { forgetInstall, startSync, syncInstall } from "./sync.js";

const jwks = new JwksCache();

/** A header as one value; `node:http` gives an array for a repeated one. */
function header(req: IncomingMessage, name: string): string | undefined {
  const found = req.headers[name];
  return Array.isArray(found) ? found[0] : found;
}

/** Read a request body as bytes. Signing and verification are over bytes. */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    // A bounded read: an app should not let a caller decide how much memory it
    // spends, and nothing this app receives is large.
    if (total > 1_000_000) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}


/** The one HTML this app serves: the page a member lands on after the vendor flow. */
function sendPage(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    // Not framed by anyone: this app mounts no embedded surface.
    "Content-Security-Policy": "frame-ancestors 'none'",
  });
  res.end(html);
}

/**
 * Verify the context token on an inbound platform call.
 *
 * Returns null and answers 401 itself, so a handler reads as
 * `const claims = await context(...); if (!claims) return;`.
 */
async function context(
  req: IncomingMessage,
  res: ServerResponse,
  expected: { scope: ContextClaims["scope"]; sourceId?: string }
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
    // The scope is pinned per call, so a token minted to fetch a source is not
    // usable to run an action. Checking it is the app's job.
    if (claims.scope !== expected.scope) {
      send(res, 403, { error: "token is not for this scope" });
      return null;
    }
    if (expected.sourceId && claims.source_id !== expected.sourceId) {
      send(res, 403, { error: "token is not for this source" });
      return null;
    }
    return claims;
  } catch (error) {
    send(res, 401, { error: (error as Error).message });
    return null;
  }
}

export const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://placeholder");
  const path = url.pathname;

  try {
    // --- liveness and readiness ---------------------------------------------
    if (req.method === "GET" && path === "/healthz") {
      return send(res, 200, { ok: true });
    }
    if (req.method === "GET" && path === "/readyz") {
      // Ready means the database is reachable: without it this app can answer
      // no source and complete no connection, so reporting ready would just
      // route traffic at something that cannot serve it.
      try {
        await pool.query("SELECT 1");
        return send(res, 200, { ok: true });
      } catch {
        return send(res, 503, { ok: false });
      }
    }

    // --- the manifest ------------------------------------------------------
    if (req.method === "GET" && path === "/.well-known/initiative-app.json") {
      return send(res, 200, manifest);
    }

    // --- the handshake -----------------------------------------------------
    if (req.method === "POST" && path === "/v1/handshake") {
      const body = JSON.parse((await readBody(req)).toString("utf-8")) as {
        challenge?: string;
      };
      if (!body.challenge) return send(res, 400, { error: "no challenge" });
      return send(res, 200, {
        signature: answerChallenge(config.appSecret, body.challenge),
      });
    }

    // --- data sources ------------------------------------------------------
    if (req.method === "GET" && path === "/data/open-issues") {
      const claims = await context(req, res, { scope: "data", sourceId: "open-issues" });
      if (!claims) return;
      return send(res, 200, await openIssues(claims, url.searchParams));
    }

    if (req.method === "GET" && path === "/data/review-queue") {
      const claims = await context(req, res, { scope: "data", sourceId: "review-queue" });
      if (!claims) return;
      return send(res, 200, await reviewQueue(claims));
    }

    if (req.method === "GET" && path === "/data/issue-throughput") {
      const claims = await context(req, res, {
        scope: "data",
        sourceId: "issue-throughput",
      });
      if (!claims) return;
      return send(res, 200, await issueThroughput(claims));
    }

    // --- actions, called by the automation service ------------------------
    if (req.method === "POST" && path === "/actions/create-issue") {
      // An `action` token, naming this operation. A token minted to fetch a
      // source cannot run this — the scope is pinned per call.
      const claims = await context(req, res, { scope: "action" });
      if (!claims) return;
      if (claims.action_id !== "create-issue") {
        return send(res, 403, { error: "token is not for this operation" });
      }
      const body = JSON.parse((await readBody(req)).toString("utf-8"));
      return send(res, 200, await createIssue(claims, body));
    }

    // --- lifecycle ---------------------------------------------------------
    if (req.method === "POST" && path === "/v1/lifecycle") {
      const claims = await context(req, res, { scope: "lifecycle" });
      if (!claims) return;
      // An install changed — created, configured, or removed. The signal says
      // which install, not what changed, so this refetches and lets the answer
      // decide: a config pull that is refused because the app is gone is the
      // removal, and there is nothing else to distinguish it from.
      try {
        await syncInstall(claims.guild_id);
      } catch (error) {
        console.error(`lifecycle sync failed for guild ${claims.guild_id}`, error);
        await forgetInstall(claims.app_install_id);
      }
      // Answered regardless: the signal is not a request for this app's opinion,
      // and the poll in `sync.ts` is what makes a missed one recoverable.
      return send(res, 204, null);
    }

    // --- the member's own vendor flow --------------------------------------
    if (req.method === "GET" && path === "/connect/github") {
      // The platform sends the member here with the opaque handle it minted for
      // them. It is the only name this app ever learns for that person.
      const connectionRef = url.searchParams.get("connection_ref");
      if (!connectionRef) return send(res, 400, { error: "no connection_ref" });
      const redirect = await beginOAuth(connectionRef);
      res.writeHead(302, { Location: redirect });
      return res.end();
    }

    if (req.method === "GET" && path === "/connect/github/callback") {
      const html = await completeOAuth(url.searchParams);
      return sendPage(res, html);
    }

    // --- the vendor calling in ---------------------------------------------
    if (req.method === "POST" && path === "/webhooks/github") {
      // Read as bytes and verified before anything parses them: a signature is
      // over what arrived, and a re-serialized object is different bytes.
      const body = await readBody(req);
      if (!verifySignature(body, header(req, SIGNATURE_HEADER))) {
        return send(res, 401, { error: "bad signature" });
      }

      const event = header(req, EVENT_HEADER);
      if (!event) return send(res, 400, { error: "no event type" });
      // GitHub pings a new webhook before sending anything real; answering it
      // is what turns the delivery green in the repository's settings.
      if (event === "ping") return send(res, 200, { ok: true });

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(body.toString("utf-8")) as Record<string, unknown>;
      } catch {
        return send(res, 400, { error: "body is not json" });
      }

      const result = await handleDelivery(event, payload);
      // 200 whatever the outcome. GitHub retries a failure, and a delivery this
      // app has no install for is not going to succeed on the second attempt —
      // the delivery id goes into the log so an admin can still find it.
      if (result.reason) {
        console.log(
          `delivery ${header(req, DELIVERY_HEADER) ?? "?"} (${event}): ${result.reason}`
        );
      }
      return send(res, 200, { emitted: result.emitted });
    }

    return send(res, 404, { error: "no such route" });
  } catch (error) {
    // Never echo the error to the caller: a message can carry a path, a query,
    // or a value from the vendor.
    console.error("request failed", error);
    return send(res, 500, { error: "internal error" });
  }
});

let sync: { stop: () => void } | null = null;

async function start(): Promise<void> {
  // Idempotent and transactional, so every replica can run it on boot.
  await migrate();
  server.listen(config.port, () => {
    console.log(`${manifest.service.public_id} listening on :${config.port}`);
  });
  // Started after the listener, not before: the reconcile talks to Initiative,
  // and a platform that is slow to answer should delay this app's picture of
  // its installs, never its readiness probe.
  sync = startSync();
}

/** Stop taking new work, finish what is in flight, then let the pool go. */
async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, shutting down`);
  sync?.stop();
  server.close(async () => {
    await close();
    process.exit(0);
  });
  // A pod gets a grace period; not exiting within it is a kill, which is worse
  // than a bounded wait that gives in-flight requests a chance to finish.
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
