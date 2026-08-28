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
import { appIdentity, installationAccount } from "./app.js";

export interface StoredAccount {
  accessToken: string;
    accountLabel: string | null;
}

const STATE_TTL_MINUTES = 10;

const REFRESH_SKEW_SECONDS = 120;

const redirectUri = () => `${config.publicUrl}${CALLBACK_PATH}`;

const tokenUrl = () => `${config.github.webBase}/login/oauth/access_token`;

/**
 * What this trip is for.
 *
 * Both end at the same callback and they end differently: `account` stores the
 * credential of the person who just authorized, `install` records the
 * installation an admin just made for the whole guild and stores no credential
 * at all. Written down when the state is minted, because it is our own intent
 * rather than something to read back off whatever GitHub returns.
 */
type Flow = "account" | "install";

/**
 * The flow, written down: the state to match the callback against, the verifier
 * to answer it with — `null` whenever no challenge went out — and which of the
 * two endings this one is headed for.
 */
async function remember(
  auth: Authorization,
  connectionRef: string,
  guildId: number,
  returnUrl: string | null,
  flow: Flow
): Promise<void> {
  await pool.query(
    `INSERT INTO oauth_states
       (state, connection_ref, guild_id, flow, code_verifier, return_url, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' minutes')::interval)`,
    [
      auth.state,
      connectionRef,
      guildId,
      flow,
      auth.verifier,
      returnUrl,
      String(STATE_TTL_MINUTES),
    ]
  );

  await pool.query("DELETE FROM oauth_states WHERE expires_at < now()");
}

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

  await remember(auth, connectionRef, guildId, returnUrl, "account");
  return `${config.github.webBase}/login/oauth/authorize?${auth.params}`;
}

/**
 * Send a guild admin to GitHub's own install page.
 *
 * `null` when GitHub will not name this app's registration, which the caller
 * turns into a page saying so. There is no falling back to the ordinary
 * authorize step here: that one ends by storing a credential against the
 * connection it was started for, and this one was started for the connection
 * that holds the guild's organization. Ending an install flow by writing the
 * admin's personal token into it would satisfy the connection with the wrong
 * thing entirely.
 */
export async function beginInstall(
  connectionRef: string,
  guildId: number,
  returnUrl: string | null
): Promise<string | null> {
  const app = await appIdentity();
  if (!app) return null;

  // The install page is not an authorization request. GitHub preserves the
  // `state` on it and then begins the authorization itself, with parameters of
  // its own choosing — so a challenge put here never reaches the step that
  // would record it, and a verifier stored against it would be sent at
  // exchange time for a binding GitHub never made. No challenge goes out, so
  // `beginAuthorization` hands back no verifier and there is none to send.
  const auth = beginAuthorization({ pkce: false });

  await remember(auth, connectionRef, guildId, returnUrl, "install");
  return `${config.github.webBase}/apps/${app.slug}/installations/new?${auth.params}`;
}

function lapsesAt(seconds: number | null): Date | null {
  return seconds === null ? null : new Date(Date.now() + seconds * 1000);
}

async function store(
  connectionRef: string,
  guildId: number,
  grant: Grant,
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
      seal(grant.accessToken),
      grant.refreshToken ? seal(grant.refreshToken) : null,
      lapsesAt(grant.expiresIn),
      lapsesAt(grant.refreshExpiresIn),
      accountLabel,
    ]
  );
}

/**
 * Whose account this token is, or `null` if GitHub would not say.
 *
 * `null` is a real answer rather than a fault: the credential is still good,
 * and what is missing is the one field the connection is satisfied by.
 */
async function accountLogin(accessToken: string): Promise<string | null> {
  const who = await fetchJson<{ login?: unknown }>(`${config.github.apiBase}/user`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!who.ok) {
    console.error(`could not read the account this token belongs to: ${who.detail}`);
    return null;
  }
  return typeof who.body.login === "string" && who.body.login ? who.body.login : null;
}

/**
 * The repositories one installation covers, as the person who just authorized
 * can see them.
 *
 * Asked of *their* token rather than of a credential minted from this app's
 * key, which is what keeps the written-down list honest: it is what the person
 * who set this up could see, not everything the installation could reach. It is
 * also why nothing here needs the route that mints a credential acting *as* the
 * installation — the one that would turn the private key into access inside
 * every repository an organization granted. `test/installation.test.ts` greps
 * `src/` for it, which is why it is described here rather than named.
 *
 * A page at a time, and one page. An install covering more than a hundred
 * repositories is not one this list describes, and truncating quietly is
 * better than the alternative only because the boundary it produces is
 * narrower than the grant rather than wider.
 */
async function installationRepositories(
  accessToken: string,
  installationId: number
): Promise<string[] | null> {
  const answer = await fetchJson<{ repositories?: unknown }>(
    `${config.github.apiBase}/user/installations/${installationId}/repositories?per_page=100`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
      },
    }
  );

  if (!answer.ok) {
    console.error(
      `could not read what installation ${installationId} covers: ${answer.detail}`
    );
    return null;
  }

  const listed = answer.body.repositories;
  if (!Array.isArray(listed)) return null;

  return listed
    .map((entry) => (entry as { name?: unknown } | null)?.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

export interface ConnectResult {
  outcome: ConnectOutcome;
  home: string | null;
  /**
   * The guild whose organization was just recorded, for the caller to re-sync.
   *
   * Present only when an install flow wrote a workspace, and absent otherwise —
   * including on every ending where nothing was stored. The sync lives a layer
   * up because this module cannot reach it: the endpoints it would pull in
   * reach back here for a member's credential.
   */
  installedFor?: number;
}

export async function completeOAuth(
  params: URLSearchParams
): Promise<ConnectResult> {
  const state = params.get("state") ?? "";
  const code = params.get("code") ?? "";

  const claimed = await pool.query<{
    connection_ref: string;
    guild_id: string | null;
    flow: string;
    code_verifier: string | null;
    return_url: string | null;
  }>(
    `DELETE FROM oauth_states
      WHERE state = $1 AND expires_at > now()
      RETURNING connection_ref, guild_id, flow, code_verifier, return_url`,
    [state]
  );
  const claim = claimed.rows[0];

  if (!claim) return { outcome: "expired", home: null };

  const home = claim.return_url;

  if (!code) return { outcome: "refused", home };

  const exchanged = await exchangeCode({
    tokenUrl: tokenUrl(),
    clientId: config.github.clientId,
    clientSecret: config.github.clientSecret,
    code,
    redirectUri: redirectUri(),
    // Whatever was stored when the flow began, including nothing.
    verifier: claim.code_verifier,
  });

  if (!exchanged.ok) {
    // GitHub refusing and GitHub being unreachable end the same way here:
    // nothing was stored, so the remedy is to start again. This is the page
    // that says so, and reaching it is the whole point of not throwing.
    console.error(`GitHub did not complete the exchange: ${exchanged.detail}`);
    return { outcome: "refused", home };
  }

  if (claim.flow === "install") {
    return completeInstall({
      connectionRef: claim.connection_ref,
      guildId: Number(claim.guild_id),
      home,
      accessToken: exchanged.grant.accessToken,
      installationId: params.get("installation_id"),
    });
  }

  const guildId = Number(claim.guild_id);
  const login = await accountLogin(exchanged.grant.accessToken);
  const label = login ? `@${login}` : null;
  await store(claim.connection_ref, guildId, exchanged.grant, label);

  const installationId = params.get("installation_id");
  if (installationId) {
    console.log(`a member authorized after installing (installation ${installationId})`);
  }

  if (!(await announce(guildId, claim.connection_ref, login, label))) {
    return { outcome: "not_recorded", home };
  }

  // A token held under a name nothing knows is the same situation as a write
  // that did not land: this app has the credential, Initiative has nothing
  // that satisfies the connection, and connecting again is safe and is the
  // remedy. Telling them "Connected" would send them to a dashboard that
  // refuses them with no way to understand why.
  return { outcome: login ? "connected" : "not_recorded", home };
}

/**
 * The end of a guild admin's install flow: write down what GitHub now has.
 *
 * Nothing personal is stored. The admin's token was exchanged a moment ago and
 * is spent here on one question — which repositories this installation covers,
 * asked as them — and then dropped. What is kept is the installation: whose
 * account it is on, its id, and the repositories it was granted, written into
 * the connection Initiative holds for the guild.
 *
 * The id is the point of the whole exercise. An owner typed into a box is a
 * claim that some account somewhere installed this app; an installation id is
 * the installation, so a delivery can be routed to the guilds that hold it and
 * an uninstall at GitHub is a fact rather than a name that stops resolving.
 */
async function completeInstall(trip: {
  connectionRef: string;
  guildId: number;
  home: string | null;
  accessToken: string;
  installationId: string | null;
}): Promise<ConnectResult> {
  const { home } = trip;
  const installationId = Number(trip.installationId);

  // GitHub sends an installation id back from its install page and from
  // nowhere else. Without one this was an authorization and not an install —
  // an admin who backed out of choosing an account, most likely — and there is
  // nothing to record.
  if (!trip.installationId || !Number.isSafeInteger(installationId)) {
    return { outcome: "refused", home };
  }

  const account = await installationAccount(installationId);
  const repos = await installationRepositories(trip.accessToken, installationId);

  // Same situation as a member whose account GitHub would not name: the trip
  // happened, and this app has nothing that satisfies the connection. Saying
  // "connected" would send an admin back to a settings page that still says
  // the app needs setting up, with nothing to explain the difference.
  if (!account || !repos || repos.length === 0) {
    console.error(
      `installation ${installationId} was not recorded: ` +
        `account=${account ? account.owner : "unknown"} repositories=${repos?.length ?? "unknown"}`
    );
    return { outcome: "not_recorded", home };
  }

  if (!Number.isInteger(trip.guildId)) return { outcome: "not_recorded", home };

  try {
    await initiative.writeConnection(trip.guildId, trip.connectionRef, {
      values: {
        owner: account.owner,
        installation_id: installationId,
        // The shape this app has always read: one string, split on commas.
        repos: repos.join(","),
      },
      status: "connected",
      // No `account_label`: that is how an admin sees whose account a *member*
      // connected without being shown the credential, and this connection's
      // values are already theirs to read. `owner` is the label.
    });
  } catch (error) {
    console.error(`could not record installation ${installationId}`, error);
    return { outcome: "not_recorded", home };
  }

  return { outcome: "connected", home, installedFor: trip.guildId };
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

    const held = open(row.access_token);

    if (!row.stale) {
      await client.query("COMMIT");
      return held ? { accessToken: held, accountLabel: row.account_label } : null;
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
        return held ? { accessToken: held, accountLabel: row.account_label } : null;
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
    return { accessToken: grant.accessToken, accountLabel: row.account_label };
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
