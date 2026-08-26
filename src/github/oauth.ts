import { randomUUID } from "node:crypto";

import {
  CHALLENGE_METHOD,
  type ConnectOutcome,
  landingUrl,
  mintPkce,
} from "initiative-app-kit";

import { config } from "../config.js";
import { initiative } from "../initiative.js";
import { pool } from "../db.js";
import { CALLBACK_PATH } from "../vocabulary.js";
import { open, seal } from "../db.js";
import { appIdentity } from "./app.js";

export interface StoredAccount {
  accessToken: string;
    accountLabel: string | null;
}

const STATE_TTL_MINUTES = 10;

const REFRESH_SKEW_SECONDS = 120;

const redirectUri = () => `${config.publicUrl}${CALLBACK_PATH}`;

const tokenUrl = () => `${config.github.webBase}/login/oauth/access_token`;

async function beginFlow(
  connectionRef: string,
  guildId: number,
  returnUrl: string | null
): Promise<{ state: string; challenge: string }> {
  const state = randomUUID();
  const { verifier, challenge } = mintPkce();

  await pool.query(
    `INSERT INTO oauth_states
       (state, connection_ref, guild_id, code_verifier, return_url, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' minutes')::interval)`,
    [state, connectionRef, guildId, verifier, returnUrl, String(STATE_TTL_MINUTES)]
  );

  await pool.query("DELETE FROM oauth_states WHERE expires_at < now()");

  return { state, challenge };
}

function authorizeParams(state: string, challenge: string): URLSearchParams {
  return new URLSearchParams({
    client_id: config.github.clientId,
    redirect_uri: redirectUri(),
    state,
    code_challenge: challenge,
    code_challenge_method: CHALLENGE_METHOD,
  });
}

export async function beginOAuth(
  connectionRef: string,
  guildId: number,
  returnUrl: string | null
): Promise<string> {
  const { state, challenge } = await beginFlow(connectionRef, guildId, returnUrl);
  const query = authorizeParams(state, challenge);
  return `${config.github.webBase}/login/oauth/authorize?${query}`;
}

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

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
}

async function exchange(body: Record<string, string>): Promise<TokenResponse | null> {
  const response = await fetch(tokenUrl(), {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) return null;

  const answer = (await response.json()) as TokenResponse;
  if (!answer.access_token) {
    if (answer.error) console.error(`GitHub refused the exchange: ${answer.error}`);
    return null;
  }
  return answer;
}

function lapsesAt(seconds: number | undefined): Date | null {
  return typeof seconds === "number" ? new Date(Date.now() + seconds * 1000) : null;
}

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

export interface ConnectResult {
  outcome: ConnectOutcome;
  home: string | null;
}

export async function completeOAuth(
  params: URLSearchParams
): Promise<ConnectResult> {
  const state = params.get("state") ?? "";
  const code = params.get("code") ?? "";

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

  if (!claim) return { outcome: "expired", home: null };

  const home = claim.return_url;

  if (!code) return { outcome: "refused", home };

  const tokens = await exchange({
    client_id: config.github.clientId,
    client_secret: config.github.clientSecret,
    code,
    redirect_uri: redirectUri(),
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

  const installationId = params.get("installation_id");
  if (installationId) {
    console.log(`a member authorized after installing (installation ${installationId})`);
  }

  if (!(await announce(guildId, claim.connection_ref, user.login ?? null, label))) {
    return { outcome: "not_recorded", home };
  }

  return { outcome: "connected", home };
}

export function landingFor(result: ConnectResult): string | null {
  return result.home ? landingUrl(result.home, result.outcome) : null;
}

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

    if (!row.stale) {
      await client.query("COMMIT");
      const accessToken = open(row.access_token);
      return accessToken ? { accessToken, accountLabel: row.account_label } : null;
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

    const tokens = await exchange({
      client_id: config.github.clientId,
      client_secret: config.github.clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    if (!tokens) {
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

async function disconnect(guildId: string | null, connectionRef: string): Promise<void> {
  if (guildId === null) return;
  await announce(Number(guildId), connectionRef, null, null);
}

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

  if (row.stale) return refresh(connectionRef);

  const accessToken = open(row.access_token);

  if (!accessToken) return null;

  return { accessToken, accountLabel: row.account_label };
}

export async function forgetConnection(connectionRef: string): Promise<void> {
  await pool.query("DELETE FROM connections WHERE connection_ref = $1", [connectionRef]);
}
