/**
 * A browser trip this app started and expects back.
 *
 * Two kinds begin here and they end in different places: a member goes to
 * authorize their own account and comes back to the callback, and an admin goes
 * to install the app for an organization and comes back to the setup URL.
 * Nothing stored says which, because nothing has to — GitHub decides where to
 * return by what happened, so the route that claims a row is already the
 * answer.
 *
 * What the row carries is what a browser cannot be trusted to: which guild and
 * which connection this trip was started for. Anyone can type a guild id into a
 * URL, so the `state` GitHub hands back is matched against a row only this app
 * wrote, and the row is spent when it is claimed.
 */

import type { Authorization } from "initiative-app-kit";

import { pool } from "../db.js";

/** How long a trip may take. Long enough to read a consent screen. */
const HANDOFF_TTL_MINUTES = 10;

export interface Handoff {
  connectionRef: string;
  guildId: number | null;
  /** The PKCE verifier, or `null` where no challenge went out. */
  codeVerifier: string | null;
  returnUrl: string | null;
  /**
   * The installation somebody says they just made, carried unverified.
   *
   * GitHub returns one to the setup URL as a query parameter and documents
   * that it must not be relied on — anybody can type an id, including one
   * belonging to an organization they have nothing to do with. So it is
   * written down as a *claim* and checked at the end of the authorization it
   * sends the person into, against the installations GitHub says they hold.
   */
  claimedInstallation: number | null;
}

export async function rememberHandoff(
  auth: Authorization,
  connectionRef: string,
  guildId: number,
  returnUrl: string | null,
  claimedInstallation: number | null = null
): Promise<void> {
  await pool.query(
    `INSERT INTO oauth_states
       (state, connection_ref, guild_id, code_verifier, return_url,
        claimed_installation, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' minutes')::interval)`,
    [
      auth.state,
      connectionRef,
      guildId,
      auth.verifier,
      returnUrl,
      claimedInstallation,
      String(HANDOFF_TTL_MINUTES),
    ]
  );

  await pool.query("DELETE FROM oauth_states WHERE expires_at < now()");
}

/**
 * Spend the row this state names, or answer that there is none.
 *
 * Deleting as it reads is what makes a state single-use: a replayed callback
 * finds nothing and ends as an expired trip, which is the honest reading of it.
 */
export async function claimHandoff(state: string): Promise<Handoff | null> {
  if (!state) return null;

  const claimed = await pool.query<{
    connection_ref: string;
    guild_id: string | null;
    code_verifier: string | null;
    return_url: string | null;
    claimed_installation: string | null;
  }>(
    `DELETE FROM oauth_states
      WHERE state = $1 AND expires_at > now()
      RETURNING connection_ref, guild_id, code_verifier, return_url,
                claimed_installation`,
    [state]
  );

  const row = claimed.rows[0];
  if (!row) return null;

  return {
    connectionRef: row.connection_ref,
    guildId: row.guild_id === null ? null : Number(row.guild_id),
    codeVerifier: row.code_verifier,
    returnUrl: row.return_url,
    claimedInstallation:
      row.claimed_installation === null ? null : Number(row.claimed_installation),
  };
}
