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
 * - **`/data/*`** — Initiative calling in, carrying a context token naming one
 *   guild, one install and one scope. Verified per call.
 * - **`/connect/*`, `/install/*`, `/setup/*`** — a person's browser, running
 *   the vendor's flow. Plain pages and no embedded surface: a member connecting
 *   their own account, an org owner installing the GitHub App, and — only while
 *   an operator has switched it on — the two that register the GitHub App in
 *   the first place.
 * - **`/webhooks/github`** — the *vendor* calling in, verified against GitHub's
 *   own webhook secret rather than against Initiative's. An organization
 *   installing this app, removing it, or changing which repositories it may see
 *   arrives here, and re-runs the sync for the installs it affects; repository
 *   activity arrives here too and is republished to whoever asked for it.
 * - **`/v1/events*`** — a *delegate* calling in, proving itself with a token it
 *   signed and a key the deployment publishes. This is the only surface here
 *   that Initiative is not a party to: an automation service asks to be told
 *   when something happens at GitHub, and this app tells it. Nothing about the
 *   dashboard depends on any of it.
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
  DelegationTokenError,
  JwksCache,
  answerChallenge,
  bearerToken,
  delegateHeader,
  verifyContextToken,
  verifyDelegationToken,
  type ContextClaims,
  type DelegationClaims,
} from "initiative-app-kit";

import { config } from "./config.js";
import { close, migrate, pool } from "./db.js";
import { document } from "./listing.config.js";
import { manifest } from "./manifest.config.js";
import { page } from "./page.js";
import {
  CALLBACK_PATH,
  CONNECT_PATH,
  EVENTS_PATH,
  INSTALL_PATH,
  REGISTERED_PATH,
  REGISTER_PATH,
  SETUP_PATH,
  SUBSCRIPTIONS_PATH,
  WEBHOOK_PATH,
} from "./routes.js";
import {
  listSubscriptions,
  spendToken,
  subscribe,
  unsubscribe,
} from "./events.js";
import { EVENT_TYPES } from "./github/events.js";
import {
  dependabotAlerts,
  issueThroughput,
  openIssues,
  reviewQueue,
} from "./github/queries.js";
import { installUrl } from "./github/app.js";
import { beginInstall, beginOAuth, completeOAuth } from "./github/oauth.js";
import {
  authorized,
  convert,
  credentialsPage,
  registerPage,
  setupEnabled,
  verifyState,
} from "./github/setup.js";
import {
  DELIVERY_HEADER,
  EVENT_HEADER,
  SIGNATURE_HEADER,
  handleDelivery,
  verifySignature,
} from "./github/webhooks.js";
import { forgetInstall, startSync, syncInstall } from "./sync.js";

/**
 * One cache, two documents.
 *
 * Initiative's own signing key answers "did Initiative send this"; a delegate's
 * key answers "did that delegate send this". Both are fetched from the same
 * deployment and cached per document, so one instance serves both and neither
 * set can verify the other's tokens.
 */
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
  sendBytes(res, status, JSON.stringify(body));
}

/** For a body whose exact bytes matter — see MANIFEST_DOCUMENT. */
function sendBytes(res: ServerResponse, status: number, payload: string): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * The discovery document, rendered once.
 *
 * `manifest` is the `definition` inside it, not the whole of what a registrar
 * fetches. Serving it bare is well-formed and unregisterable, which is the one
 * mistake this file is worth reading for.
 *
 * Built in `listing.config.ts` because the catalog uid it carries is the same
 * one the listings publish under — that is what ties a verified registration to
 * something a guild can install.
 */
const MANIFEST_DOCUMENT = JSON.stringify(document);


function sendPage(
  res: ServerResponse,
  html: string,
  options: { secret?: boolean } = {}
): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    // Not framed by anyone: this app mounts no embedded surface.
    "Content-Security-Policy": "frame-ancestors 'none'",
    // One page here renders credentials. It must not sit in a shared cache, and
    // the setup token must not travel onward in a Referer header to GitHub.
    ...(options.secret
      ? { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }
      : {}),
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

/**
 * Verify the delegation token on an inbound call from an automation service.
 *
 * The mirror of `context` above, for the other kind of caller, and it answers
 * 401 itself for the same reason.
 *
 * Three things happen here and the order matters. The caller names which
 * delegate it is, which decides *which* published key set is fetched — a
 * selector, and nothing is believed on the strength of it. The signature then
 * decides whether that name was true. And only then is the token spent: a
 * delegation token is one-shot, and burning it before it verified would let
 * anybody invalidate a real one by presenting a forgery with a guessed id.
 */
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
    // One sentence for every reason. Which of them applies is either the
    // deployment's own wiring or a detail of the token, and neither is
    // something to describe to a caller that has not proved anything yet.
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
    // The DOCUMENT, not the bare manifest: a registrar refuses anything without
    // the envelope, and `manifest` is only its `definition`. Rendered once at
    // module load, because a deployment hashes what it fetches and re-checks it
    // hourly — two renderings that differ by a space read as the app having
    // changed and send the registration back for re-verification.
    if (req.method === "GET" && path === "/.well-known/initiative-app.json") {
      return sendBytes(res, 200, MANIFEST_DOCUMENT);
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
      return send(res, 200, await reviewQueue(claims, url.searchParams));
    }

    if (req.method === "GET" && path === "/data/dependabot-alerts") {
      const claims = await context(req, res, {
        scope: "data",
        sourceId: "dependabot-alerts",
      });
      if (!claims) return;
      return send(res, 200, await dependabotAlerts(claims, url.searchParams));
    }

    if (req.method === "GET" && path === "/data/issue-throughput") {
      const claims = await context(req, res, {
        scope: "data",
        sourceId: "issue-throughput",
      });
      if (!claims) return;
      return send(res, 200, await issueThroughput(claims, url.searchParams));
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
    if (req.method === "GET" && path === CONNECT_PATH) {
      // The platform sends the member here with the opaque handle it minted for
      // them. It is the only name this app ever learns for that person.
      const connectionRef = url.searchParams.get("connection_ref");
      if (!connectionRef) return send(res, 400, { error: "no connection_ref" });
      const redirect = await beginOAuth(connectionRef);
      res.writeHead(302, { Location: redirect });
      return res.end();
    }

    if (req.method === "GET" && path === CALLBACK_PATH) {
      const html = await completeOAuth(url.searchParams);
      return sendPage(res, html);
    }

    // --- installing the GitHub App -----------------------------------------
    // The other half of setting this app up, and the half Initiative has no
    // vocabulary for: a guild admin fills in the repository there, and somebody
    // who owns that organization installs the app here. Served as a redirect so
    // there is one link to hand out — the app's own address rather than a
    // GitHub URL nobody can reconstruct from the slug.
    if (req.method === "GET" && path === INSTALL_PATH) {
      // With a handle, installing and authorizing are one trip and the member
      // comes back connected. Without one, it is just the install page.
      const connectionRef = url.searchParams.get("connection_ref");
      const redirect = connectionRef
        ? await beginInstall(connectionRef)
        : await installUrl();
      if (!redirect) {
        // GitHub would not say what this app is called, which means the private
        // key is wrong or absent. Nothing here can recover from that.
        return send(res, 503, { error: "this app is not registered at GitHub" });
      }
      res.writeHead(302, { Location: redirect });
      return res.end();
    }

    // Where GitHub returns an org owner after they install. It deliberately
    // shows nothing about the installation it was handed: the redirect carries
    // an `installation_id` and no proof of anything, so a page that looked it
    // up would report one organization's repositories to whoever guessed a
    // number. What the visitor needs is the next step, and that is the same
    // sentence for everybody.
    if (req.method === "GET" && path === SETUP_PATH) {
      return sendPage(
        res,
        page(
          "Installed",
          "Now open this app's settings in Initiative and set the owner and " +
            "repository you want it to watch. If you already have, it will " +
            "start working within a few minutes."
        )
      );
    }

    // --- registering this deployment's own GitHub App ----------------------
    // Two routes that exist only while `GITHUB_APP_SETUP_TOKEN` is set. They
    // create a GitHub App and show its secrets, which is a thing to be able to
    // do once and then not be able to do — so "off" is `404`, indistinguishable
    // from a deployment that never had the feature.
    if (req.method === "GET" && (path === REGISTER_PATH || path === REGISTERED_PATH)) {
      if (!setupEnabled()) return send(res, 404, { error: "no such route" });

      if (path === REGISTER_PATH) {
        if (!authorized(url.searchParams.get("token"))) {
          return send(res, 404, { error: "no such route" });
        }
        const org = url.searchParams.get("org");
        // An organization login is a path segment on GitHub's own URL, and this
        // one arrived in a query string.
        if (org !== null && !/^[A-Za-z0-9-]{1,39}$/.test(org)) {
          return send(res, 400, { error: "that is not an organization login" });
        }
        return sendPage(res, registerPage(org), { secret: true });
      }

      // GitHub returns the operator here with a code and the state this app
      // signed. The setup token is not in the redirect, so the state is what
      // carries the authority — see `setup.ts`.
      if (!verifyState(url.searchParams.get("state"))) {
        return send(res, 404, { error: "no such route" });
      }
      const code = url.searchParams.get("code");
      if (!code) return send(res, 400, { error: "no code" });

      const credentials = await convert(code);
      if (!credentials) {
        return sendPage(
          res,
          page(
            "Could not finish",
            "GitHub would not exchange that code. It is good for an hour and " +
              "for one attempt — start again from the setup link."
          ),
          { secret: true }
        );
      }
      return sendPage(res, credentialsPage(credentials), { secret: true });
    }

    // --- what this app produces, and who has asked for it ------------------
    // Unauthenticated, and it is the same list the manifest declares. A
    // subscriber connecting directly needs to know what it may ask for, and
    // making it prove itself to read a public vocabulary would be a credential
    // spent on nothing.
    if (req.method === "GET" && path === EVENTS_PATH) {
      return send(res, 200, {
        public_id: manifest.service.public_id,
        event_types: EVENT_TYPES,
      });
    }

    // Everything below is a delegate acting for one guild. The token names the
    // guild; nothing in the request may widen that.
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
      // The secret appears here and nowhere else, ever. A subscriber that loses
      // it re-subscribes to the same address and is given a fresh one.
      return send(res, 201, { ...result.view, secret: result.secret });
    }

    if (req.method === "DELETE" && path.startsWith(`${SUBSCRIPTIONS_PATH}/`)) {
      const id = Number(path.slice(SUBSCRIPTIONS_PATH.length + 1));
      if (!Number.isInteger(id)) return send(res, 404, { error: "no such subscription" });

      const claims = await delegate(req, res);
      if (!claims) return;
      // Matched on the delegate and the guild as well as the id, so one
      // subscriber cannot reach another's by guessing a number — and the
      // delegate is the registration whose key verified, not a name it typed.
      const removed = await unsubscribe(claims.signer.publicId, claims.guildId, id);
      if (!removed) return send(res, 404, { error: "no such subscription" });
      return send(res, 204, null);
    }

    // --- the vendor calling in ---------------------------------------------
    // This app subscribes to no repository activity. What arrives here is the
    // installation lifecycle, which GitHub sends to every app whether it asked
    // or not — and which is the one thing this app cannot work out for itself
    // in time to matter.
    if (req.method === "POST" && path === WEBHOOK_PATH) {
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

      const result = await handleDelivery(
        event,
        payload,
        header(req, DELIVERY_HEADER) ?? "",
      );
      // 200 whatever the outcome. GitHub retries a failure, and a delivery this
      // app has no install for is not going to succeed on the second attempt —
      // the delivery id goes into the log so an admin can still find it.
      if (result.reason) {
        console.log(
          `delivery ${header(req, DELIVERY_HEADER) ?? "?"} (${event}): ${result.reason}`
        );
      }
      return send(res, 200, { resynced: result.resynced, published: result.published });
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
