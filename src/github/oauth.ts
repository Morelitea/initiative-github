/**
 * The member's own GitHub account, connected by the member.
 *
 * What matters here is what this app learns and what it does not. The
 * platform sends a member here with a `connection_ref` — an opaque handle it
 * minted per (install, connection, member). That handle is the *only* name this
 * app ever has for that person: no user id, no email, no display name. The same
 * person looks unrelated across apps, and across guilds within this one.
 *
 * So the table is keyed by the handle. When Initiative later calls a data
 * source or an action on that member's behalf, the context token carries the
 * same handle in `connection_refs`, and this app looks up the credential
 * without ever learning whose it is.
 *
 * **Three things about the flow that surprise people who know OAuth:**
 *
 *   * **There are no scopes.** A user token carries the permissions the
 *     *installation* was granted, intersected with what that member can already
 *     reach — bounded by the organization's own grant rather than by a string
 *     this app chose. A `scope` parameter would have nowhere to land.
 *   * **Tokens expire.** Eight hours, renewed with a refresh token good for six
 *     months. That is why this file has a refresh path at all, and why the
 *     credential is a rotating pair rather than one durable secret.
 *   * **PKCE.** The authorization code is bound to a verifier that never leaves
 *     this server, so a code intercepted in a redirect — a browser history, a
 *     proxy log, a referrer header — cannot be exchanged by whoever caught it.
 *
 * Two things are in Postgres rather than in memory, and the second is the one
 * that bites first: the credential, because a restart must not disconnect
 * everybody; and the in-flight state, because the browser leaves from one
 * replica and comes back to whichever the load balancer picks.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";

import { type ConnectOutcome, landingUrl } from "initiative-app-kit";

import { config } from "../config.js";
import { initiative } from "../initiative.js";
import { pool } from "../db.js";
import { CALLBACK_PATH } from "../routes.js";
import { open, seal } from "../secrets.js";
import { appIdentity } from "./app.js";

export interface StoredAccount {
  accessToken: string;
  /** What the member connected as, for display in their settings. */
  accountLabel: string | null;
}

const STATE_TTL_MINUTES = 10;

/** Renewed this long before it lapses, so a call never races the clock. */
const REFRESH_SKEW_SECONDS = 120;

const REDIRECT_URI = `${config.publicUrl}${CALLBACK_PATH}`;

/** Where the token exchange happens. Not the API host — see `config.ts`. */
const TOKEN_URL = `${config.github.webBase}/login/oauth/access_token`;

/**
 * Begin a flow, and hold the half of it that must not travel.
 *
 * `state` goes to GitHub and comes back, which is what ties a callback to a
 * request this app actually made. The verifier stays here and only its hash is
 * sent, which is what ties the code to *this server*. The two answer different
 * questions and neither substitutes for the other.
 */
async function beginFlow(
  connectionRef: string,
  guildId: number,
  returnUrl: string | null
): Promise<{ state: string; challenge: string }> {
  const state = randomUUID();
  // 32 bytes as base64url is 43 characters — the shortest verifier the spec
  // allows, and the length GitHub's own examples use.
  const verifier = randomBytes(32).toString("base64url");

  await pool.query(
    `INSERT INTO oauth_states
       (state, connection_ref, guild_id, code_verifier, return_url, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' minutes')::interval)`,
    [state, connectionRef, guildId, verifier, returnUrl, String(STATE_TTL_MINUTES)]
  );
  // Swept here rather than by a job: the table is small, and a sweep that runs
  // when somebody connects cannot fall behind in a way that matters.
  await pool.query("DELETE FROM oauth_states WHERE expires_at < now()");

  return {
    state,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

/** The query every leg of the flow carries. */
function authorizeParams(state: string, challenge: string): URLSearchParams {
  return new URLSearchParams({
    client_id: config.github.clientId,
    redirect_uri: REDIRECT_URI,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    // No `scope`. A GitHub App's user token carries the installation's
    // permissions, so there is nothing for this app to ask for here.
  });
}

/** Where to send the member so GitHub can authorize them. */
export async function beginOAuth(
  connectionRef: string,
  guildId: number,
  returnUrl: string | null
): Promise<string> {
  const { state, challenge } = await beginFlow(connectionRef, guildId, returnUrl);
  const query = authorizeParams(state, challenge);
  return `${config.github.webBase}/login/oauth/authorize?${query}`;
}

/**
 * Where to send somebody who has to *install* the app first, not just authorize.
 *
 * The same flow with one more step in front of it. Because the registration
 * sets `request_oauth_on_install`, GitHub carries the person straight from
 * choosing repositories to authorizing and returns them to the same callback
 * with the same `state` — so installing and connecting are one trip, and the
 * callback below does not need to know which of the two just happened.
 *
 * Falls back to plain authorization if GitHub will not say what this app is
 * called, since the slug is the only thing the install URL needs that the
 * authorize URL does not.
 */
export async function beginInstall(
  connectionRef: string,
  guildId: number,
  returnUrl: string | null
): Promise<string> {
  const app = await appIdentity();
  const { state, challenge } = await beginFlow(connectionRef, guildId, returnUrl);
  const query = authorizeParams(state, challenge);
  if (!app) return `${config.github.webBase}/login/oauth/authorize?${query}`;
  return `${config.github.webBase}/apps/${app.slug}/installations/new?${query}`;
}

/** What GitHub answers a code or a refresh with. */
interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
}

async function exchange(body: Record<string, string>): Promise<TokenResponse | null> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) return null;

  const answer = (await response.json()) as TokenResponse;
  if (!answer.access_token) {
    // GitHub answers 200 with an `error` field rather than a status here, so
    // the absence of a token is the only reliable failure signal.
    if (answer.error) console.error(`GitHub refused the exchange: ${answer.error}`);
    return null;
  }
  return answer;
}

/** `expires_in` seconds from now, or null when this app's tokens do not expire. */
function lapsesAt(seconds: number | undefined): Date | null {
  return typeof seconds === "number" ? new Date(Date.now() + seconds * 1000) : null;
}

/** Store what an exchange produced, under the handle it belongs to. */
async function store(
  connectionRef: string,
  guildId: number,
  tokens: TokenResponse,
  accountLabel: string | null
): Promise<void> {
  await pool.query(
    `INSERT INTO connections (
       connection_ref, guild_id, access_token, refresh_token,
       expires_at, refresh_expires_at, account_label
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (connection_ref) DO UPDATE
        SET guild_id           = EXCLUDED.guild_id,
            access_token       = EXCLUDED.access_token,
            refresh_token      = EXCLUDED.refresh_token,
            expires_at         = EXCLUDED.expires_at,
            refresh_expires_at = EXCLUDED.refresh_expires_at,
            account_label      = EXCLUDED.account_label,
            updated_at         = now()`,
    [
      connectionRef,
      guildId,
      seal(tokens.access_token!),
      tokens.refresh_token ? seal(tokens.refresh_token) : null,
      lapsesAt(tokens.expires_in),
      lapsesAt(tokens.refresh_token_expires_in),
      accountLabel,
    ]
  );
}

/**
 * What the callback ends as, and where the member goes to hear it.
 *
 * `home` is the address Initiative signed when it began the flow, or `null` for
 * a flow that carried none — one begun before the state row could hold one, or
 * by somebody who assembled the connect URL themselves. The caller draws its
 * own page in that case; here, both endings are the same four words.
 */
export interface ConnectResult {
  outcome: ConnectOutcome;
  home: string | null;
}

/** Exchange the code, store the credential under its handle, and say how it went. */
export async function completeOAuth(
  params: URLSearchParams
): Promise<ConnectResult> {
  const state = params.get("state") ?? "";
  const code = params.get("code") ?? "";

  // Claimed in one statement, so a replayed callback finds nothing rather than
  // racing a second exchange of the same code.
  const claimed = await pool.query<{
    connection_ref: string;
    guild_id: string | null;
    code_verifier: string | null;
    return_url: string | null;
  }>(
    `DELETE FROM oauth_states
      WHERE state = $1 AND expires_at > now()
      RETURNING connection_ref, guild_id, code_verifier, return_url`,
    [state]
  );
  const claim = claimed.rows[0];

  // No row is the only ending with nowhere to send them: the address was in the
  // row, and there is no row. Whoever arrives here followed a link that had
  // expired, been spent, or was never minted.
  if (!claim) return { outcome: "expired", home: null };

  const home = claim.return_url;

  // GitHub sends the member back with no code when they decline, so this is
  // their answer rather than a fault — told apart from an expired link because
  // the remedy is different: theirs at the vendor, not theirs here.
  if (!code) return { outcome: "refused", home };

  const tokens = await exchange({
    client_id: config.github.clientId,
    client_secret: config.github.clientSecret,
    code,
    redirect_uri: REDIRECT_URI,
    ...(claim.code_verifier ? { code_verifier: claim.code_verifier } : {}),
  });
  if (!tokens) return { outcome: "refused", home };

  const who = await fetch(`${config.github.apiBase}/user`, {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: "application/vnd.github+json",
    },
  });
  const user = (await who.json()) as { login?: string };

  const guildId = Number(claim.guild_id);
  const label = user.login ? `@${user.login}` : null;
  await store(claim.connection_ref, guildId, tokens, label);

  // A delivery that arrived because this person just installed the app carries
  // the installation as well. Nothing here needs it — the repository is what
  // decides which installation answers for a guild — but it is worth saying in
  // the log, because it is the difference between "somebody connected" and
  // "somebody set the whole thing up".
  const installationId = params.get("installation_id");
  if (installationId) {
    console.log(`a member authorized after installing (installation ${installationId})`);
  }

  // Holding the credential is not the same as being connected, and this is the
  // half that was missing. Initiative decides whether an endpoint may run from its
  // OWN record of the connection, not from anything this app knows: a member
  // connection is satisfied when the app writes back a managed value, and one
  // that declares fields nobody has written is never satisfied at all. So a
  // token stored and never announced is a member who authorized GitHub and
  // still cannot see a single tile.
  if (!(await announce(guildId, claim.connection_ref, user.login ?? null, label))) {
    return { outcome: "not_recorded", home };
  }

  return { outcome: "connected", home };
}

/**
 * Where to send the member, given how it ended.
 *
 * `null` when Initiative gave no address to go back to, and the caller says its
 * piece on its own page instead.
 */
export function landingFor(result: ConnectResult): string | null {
  return result.home ? landingUrl(result.home, result.outcome) : null;
}

/**
 * Tell Initiative this member is connected, or that they no longer are.
 *
 * The value written is the GitHub login and nothing else. It is not a
 * credential — the token stays sealed in this app's own database — but the
 * platform needs *something* stored against the connection, because that is
 * precisely how it decides a per-member connection is satisfied. Passing `null`
 * clears it, which is how a credential that lapsed stops reading as connected.
 *
 * Never throws. A platform that is unreachable is a connection this app holds
 * and Initiative does not yet know about, which the caller reports honestly
 * rather than turning into a failed connect.
 */
async function announce(
  guildId: number,
  connectionRef: string,
  login: string | null,
  accountLabel: string | null
): Promise<boolean> {
  if (!Number.isInteger(guildId)) return false;
  try {
    await initiative.writeConnection(guildId, connectionRef, {
      values: { account_login: login },
      status: login ? "connected" : "pending",
      ...(accountLabel ? { account_label: accountLabel } : {}),
    });
    return true;
  } catch (error) {
    console.error(`could not report connection ${connectionRef}`, error);
    return false;
  }
}

/**
 * Renew a credential that has lapsed, once, across every replica.
 *
 * A refresh token is single-use: GitHub issues a new one with each renewal and
 * retires the old. Two replicas refreshing the same member at the same moment
 * would have one succeed and the other be refused — and the refused one would
 * then overwrite a perfectly good credential with nothing. So the row is locked
 * for the length of the exchange, and whoever loses the race re-reads what the
 * winner wrote instead of asking GitHub again.
 */
async function refresh(connectionRef: string): Promise<StoredAccount | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{
      guild_id: string | null;
      access_token: string;
      refresh_token: string | null;
      account_label: string | null;
      stale: boolean;
      renewable: boolean;
    }>(
      `SELECT guild_id, access_token, refresh_token, account_label,
              (expires_at IS NOT NULL
                 AND expires_at <= now() + ($2 || ' seconds')::interval) AS stale,
              (refresh_expires_at IS NULL OR refresh_expires_at > now()) AS renewable
         FROM connections
        WHERE connection_ref = $1
        FOR UPDATE`,
      [connectionRef, String(REFRESH_SKEW_SECONDS)]
    );
    const row = locked.rows[0];
    if (!row) {
      await client.query("COMMIT");
      return null;
    }

    // Somebody else refreshed while this call waited for the lock.
    if (!row.stale) {
      await client.query("COMMIT");
      const accessToken = open(row.access_token);
      return accessToken ? { accessToken, accountLabel: row.account_label } : null;
    }

    const sealed = row.refresh_token;
    const refreshToken = sealed ? open(sealed) : null;
    if (!refreshToken || !row.renewable) {
      // Six months of not being used, or a value that predates a key rotation.
      // Either way the member has to connect again, and the row goes so nothing
      // keeps trying with a credential that cannot work.
      await client.query("DELETE FROM connections WHERE connection_ref = $1", [
        connectionRef,
      ]);
      await client.query("COMMIT");
      await disconnect(row.guild_id, connectionRef);
      return null;
    }

    const tokens = await exchange({
      client_id: config.github.clientId,
      client_secret: config.github.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    if (!tokens) {
      // A refusal here is a grant the member or their organization withdrew.
      // That is not transient and will not become transient.
      await client.query("DELETE FROM connections WHERE connection_ref = $1", [
        connectionRef,
      ]);
      await client.query("COMMIT");
      await disconnect(row.guild_id, connectionRef);
      return null;
    }

    await client.query(
      `UPDATE connections
          SET access_token       = $2,
              refresh_token      = $3,
              expires_at         = $4,
              refresh_expires_at = $5,
              updated_at         = now()
        WHERE connection_ref = $1`,
      [
        connectionRef,
        seal(tokens.access_token!),
        // GitHub rotates the refresh token too; keeping the old one when it
        // does not is what makes this safe to call twice.
        tokens.refresh_token ? seal(tokens.refresh_token) : sealed,
        lapsesAt(tokens.expires_in),
        lapsesAt(tokens.refresh_token_expires_in),
      ]
    );
    await client.query("COMMIT");
    return { accessToken: tokens.access_token!, accountLabel: row.account_label };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Say that a credential this app was holding is gone.
 *
 * Called after the transaction has committed, never inside it: this is a
 * network call, and holding a row lock across one would make every other
 * refresh for that member wait on a platform that may be unreachable.
 *
 * Without it the picture goes permanently stale in the direction that matters.
 * This app forgets a lapsed credential and reports nothing, so Initiative goes
 * on showing the member as connected, offering them no way to reconnect, while
 * every tile they own answers `not-connected` from the app's side.
 */
async function disconnect(guildId: string | null, connectionRef: string): Promise<void> {
  // A row written before the guild was carried through the flow has none. There
  // is nothing to address the channel with, and nothing to be done about it.
  if (guildId === null) return;
  await announce(Number(guildId), connectionRef, null, null);
}

/** The credential behind a handle, or null if that member has not connected. */
export async function credentialFor(
  connectionRef: string | undefined
): Promise<StoredAccount | null> {
  if (!connectionRef) return null;
  const found = await pool.query<{
    access_token: string;
    account_label: string | null;
    stale: boolean;
  }>(
    `SELECT access_token, account_label,
            (expires_at IS NOT NULL
               AND expires_at <= now() + ($2 || ' seconds')::interval) AS stale
       FROM connections
      WHERE connection_ref = $1`,
    [connectionRef, String(REFRESH_SKEW_SECONDS)]
  );
  const row = found.rows[0];
  if (!row) return null;

  // Renewed on use rather than on a schedule. A member who has not opened a
  // dashboard in a week does not need a live token, and a job that rotated
  // everybody's would be a great deal of traffic spent keeping credentials
  // fresh for people who are not asking for anything.
  if (row.stale) return refresh(connectionRef);

  const accessToken = open(row.access_token);
  // A value that will not open is a credential that is no longer usable —
  // after a key rotation, say — so it reads as "not connected" and the member
  // is asked to connect again rather than the call failing obscurely.
  if (!accessToken) return null;

  return { accessToken, accountLabel: row.account_label };
}

/** Forget a member's credential. For the platform's revocation signal. */
export async function forgetConnection(connectionRef: string): Promise<void> {
  await pool.query("DELETE FROM connections WHERE connection_ref = $1", [connectionRef]);
}
