import {
  beginAuthorization,
  exchangeCode,
  fetchJson,
  landingUrl,
  refreshGrant,
  type Authorization,
  type ConnectOutcome,
  type Grant,
} from "initiative-app-kit";

import { config } from "../config.js";
import { initiative } from "../initiative.js";
import { pool } from "../db.js";
import { CALLBACK_PATH } from "../vocabulary.js";
import { open, seal } from "../db.js";
import { claimHandoff, rememberHandoff } from "./handoff.js";

export interface StoredAccount {
  accessToken: string;
}

const REFRESH_SKEW_SECONDS = 120;

const redirectUri = () => `${config.publicUrl}${CALLBACK_PATH}`;

const tokenUrl = () => `${config.github.webBase}/login/oauth/access_token`;

export async function beginOAuth(
  connectionRef: string,
  guildId: number,
  returnUrl: string | null
): Promise<string> {
  // GitHub's authorize step takes a challenge and checks the verifier against
  // it at exchange time, so this flow is bound to this server. No scope: a
  // GitHub App's user token carries the installation's permissions.
  const auth = beginAuthorization({
    clientId: config.github.clientId,
    redirectUri: redirectUri(),
  });

  await rememberHandoff(auth, connectionRef, guildId, returnUrl);
  return `${config.github.webBase}/login/oauth/authorize?${auth.params}`;
}

function lapsesAt(seconds: number | null): Date | null {
  return seconds === null ? null : new Date(Date.now() + seconds * 1000);
}

async function store(
  connectionRef: string,
  guildId: number,
  grant: Grant
): Promise<void> {
  await pool.query(
    `INSERT INTO connections (
       connection_ref, guild_id, access_token, refresh_token,
       expires_at, refresh_expires_at
     )
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (connection_ref) DO UPDATE
        SET guild_id           = EXCLUDED.guild_id,
            access_token       = EXCLUDED.access_token,
            refresh_token      = EXCLUDED.refresh_token,
            expires_at         = EXCLUDED.expires_at,
            refresh_expires_at = EXCLUDED.refresh_expires_at,
            updated_at         = now()`,
    [
      connectionRef,
      guildId,
      seal(grant.accessToken),
      grant.refreshToken ? seal(grant.refreshToken) : null,
      lapsesAt(grant.expiresIn),
      lapsesAt(grant.refreshExpiresIn),
    ]
  );
}

export interface ConnectResult {
  outcome: ConnectOutcome;
  home: string | null;
}

export async function completeOAuth(
  params: URLSearchParams
): Promise<ConnectResult> {
  const code = params.get("code") ?? "";

  const handoff = await claimHandoff(params.get("state") ?? "");
  if (!handoff) return { outcome: "expired", home: null };

  const home = handoff.returnUrl;

  if (!code) return { outcome: "refused", home };

  const exchanged = await exchangeCode({
    tokenUrl: tokenUrl(),
    clientId: config.github.clientId,
    clientSecret: config.github.clientSecret,
    code,
    redirectUri: redirectUri(),
    // Whatever was stored when the flow began, including nothing.
    verifier: handoff.codeVerifier,
  });

  if (!exchanged.ok) {
    // GitHub refusing and GitHub being unreachable end the same way here:
    // nothing was stored, so the remedy is to start again. This is the page
    // that says so, and reaching it is the whole point of not throwing.
    console.error(`GitHub did not complete the exchange: ${exchanged.detail}`);
    return { outcome: "refused", home };
  }

  const guildId = handoff.guildId ?? Number.NaN;
  await store(handoff.connectionRef, guildId, exchanged.grant);

  // A credential this app holds and Initiative does not know about is the same
  // situation as a write that did not land: nothing satisfies the connection,
  // the dashboard refuses them, and connecting again is safe and is the remedy.
  if (!(await announce(guildId, handoff.connectionRef, true))) {
    return { outcome: "not_recorded", home };
  }

  return { outcome: "connected", home };
}

export function landingFor(result: ConnectResult): string | null {
  return result.home ? landingUrl(result.home, result.outcome) : null;
}

/**
 * Tell Initiative whether this member holds a credential here. Not which one,
 * and not whose.
 *
 * The whole of what crosses: a yes, or a cleared value that reads as a no. A
 * connection is satisfied by presence, so that is all satisfaction ever needed
 * — the GitHub login that used to travel in its place was stored in plaintext,
 * read back by nothing, and already known to the one party with a use for it.
 */
async function announce(
  guildId: number,
  connectionRef: string,
  authorized: boolean
): Promise<boolean> {
  if (!Number.isInteger(guildId)) return false;
  try {
    await initiative.writeConnection(guildId, connectionRef, {
      values: { authorized: authorized ? true : null },
      status: authorized ? "connected" : "pending",
    });
    return true;
  } catch (error) {
    console.error(`could not report connection ${connectionRef}`, error);
    return false;
  }
}

async function refresh(connectionRef: string): Promise<StoredAccount | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{
      guild_id: string | null;
      access_token: string;
      refresh_token: string | null;
      stale: boolean;
      renewable: boolean;
    }>(
      `SELECT guild_id, access_token, refresh_token,
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

    const held = open(row.access_token);

    if (!row.stale) {
      await client.query("COMMIT");
      return held ? { accessToken: held } : null;
    }

    const sealed = row.refresh_token;
    const refreshToken = sealed ? open(sealed) : null;
    if (!refreshToken || !row.renewable) {
      await client.query("DELETE FROM connections WHERE connection_ref = $1", [
        connectionRef,
      ]);
      await client.query("COMMIT");
      await disconnect(row.guild_id, connectionRef);
      return null;
    }

    const exchanged = await refreshGrant({
      tokenUrl: tokenUrl(),
      clientId: config.github.clientId,
      clientSecret: config.github.clientSecret,
      refreshToken,
    });

    if (!exchanged.ok) {
      if (exchanged.reason === "unreachable") {
        // GitHub did not say this grant is finished — it did not say anything.
        // Dropping the row on that would disconnect every member whose token
        // happened to be near expiry during an outage, and tell Initiative so.
        // Hold what we have: the skew means it is usually still valid, and if
        // it is not, the call it is spent on fails as a vendor error, which is
        // the honest answer rather than "connect your account again".
        await client.query("COMMIT");
        console.warn(`could not refresh ${connectionRef}: ${exchanged.detail}`);
        return held ? { accessToken: held } : null;
      }

      await client.query("DELETE FROM connections WHERE connection_ref = $1", [
        connectionRef,
      ]);
      await client.query("COMMIT");
      await disconnect(row.guild_id, connectionRef);
      return null;
    }

    const { grant } = exchanged;
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
        seal(grant.accessToken),

        grant.refreshToken ? seal(grant.refreshToken) : sealed,
        lapsesAt(grant.expiresIn),
        lapsesAt(grant.refreshExpiresIn),
      ]
    );
    await client.query("COMMIT");
    return { accessToken: grant.accessToken };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function disconnect(guildId: string | null, connectionRef: string): Promise<void> {
  if (guildId === null) return;
  await announce(Number(guildId), connectionRef, false);
}

export async function credentialFor(
  connectionRef: string | undefined
): Promise<StoredAccount | null> {
  if (!connectionRef) return null;
  const found = await pool.query<{
    access_token: string;
    stale: boolean;
  }>(
    `SELECT access_token,
            (expires_at IS NOT NULL
               AND expires_at <= now() + ($2 || ' seconds')::interval) AS stale
       FROM connections
      WHERE connection_ref = $1`,
    [connectionRef, String(REFRESH_SKEW_SECONDS)]
  );
  const row = found.rows[0];
  if (!row) return null;

  if (row.stale) return refresh(connectionRef);

  const accessToken = open(row.access_token);

  if (!accessToken) return null;

  return { accessToken };
}

export async function forgetConnection(connectionRef: string): Promise<void> {
  await pool.query("DELETE FROM connections WHERE connection_ref = $1", [connectionRef]);
}
