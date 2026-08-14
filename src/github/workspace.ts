/**
 * The guild-scoped half of this app's configuration.
 *
 * A `static` connection is one set of values a guild admin fills in once for
 * the whole guild. The platform holds them and hands them to this app when it
 * pulls its configuration, keyed by install — which is why the lookup is by
 * `app_install_id` and never by guild id alone: one guild could install the app
 * twice, and the two installs are separate configurations.
 *
 * Persisted rather than cached in memory. Losing it is not catastrophic — the
 * next sync refetches — but every source answers "not configured" until
 * something does, which reads to a member as the app being broken.
 *
 * It is also read **backwards**. A GitHub delivery names a repository and
 * nothing else, so this table is the only thing that can say which installs
 * asked about it — see {@link installsWatching}.
 */

import { pool } from "../db.js";

export interface Workspace {
  owner: string;
  repo: string;
}

/** An install, and the guild an event about its repository belongs to. */
export interface WatchingInstall {
  appInstallId: number;
  guildId: number;
}

/** Record what an install was configured with. Called after a config pull. */
export async function rememberWorkspace(
  appInstallId: number,
  guildId: number,
  workspace: Workspace
): Promise<void> {
  await pool.query(
    `INSERT INTO workspaces (app_install_id, guild_id, owner, repo)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (app_install_id) DO UPDATE
        SET guild_id = EXCLUDED.guild_id,
            owner = EXCLUDED.owner,
            repo = EXCLUDED.repo,
            updated_at = now()`,
    [appInstallId, guildId, workspace.owner, workspace.repo]
  );
}

/** What this install points at, or null if an admin has not set it up yet. */
export async function workspaceFor(appInstallId: number): Promise<Workspace | null> {
  const found = await pool.query<Workspace>(
    "SELECT owner, repo FROM workspaces WHERE app_install_id = $1",
    [appInstallId]
  );
  return found.rows[0] ?? null;
}

/**
 * Which installs pointed at this repository.
 *
 * A list, not one row: two guilds may both watch the same public repository,
 * and each is entitled to its own event. Matched case-insensitively because
 * GitHub treats owner and repo names that way and an admin types them by hand.
 */
export async function installsWatching(
  owner: string,
  repo: string
): Promise<WatchingInstall[]> {
  const found = await pool.query<{ app_install_id: string; guild_id: string }>(
    `SELECT app_install_id, guild_id
       FROM workspaces
      WHERE lower(owner) = lower($1) AND lower(repo) = lower($2)`,
    [owner, repo]
  );
  // `pg` hands back BIGINT as a string, since not every value fits a JS number.
  // These are ids and comfortably do, so they are narrowed once, here.
  return found.rows.map((row) => ({
    appInstallId: Number(row.app_install_id),
    guildId: Number(row.guild_id),
  }));
}

/** Drop an install's configuration. For the lifecycle removal signal. */
export async function forgetWorkspace(appInstallId: number): Promise<void> {
  await pool.query("DELETE FROM workspaces WHERE app_install_id = $1", [appInstallId]);
}

/**
 * Drop every install this app is no longer in.
 *
 * The removal signal is best-effort — it does not arrive if this app was down
 * when a guild uninstalled — so the reconcile is what actually ends the
 * relationship. It is the only thing that stops a repository matching an
 * install that no longer exists.
 */
export async function forgetInstallsExcept(appInstallIds: number[]): Promise<number> {
  const result = await pool.query(
    "DELETE FROM workspaces WHERE NOT (app_install_id = ANY($1::bigint[]))",
    [appInstallIds]
  );
  return result.rowCount ?? 0;
}
