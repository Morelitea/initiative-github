/**
 * The guild-scoped half of this app's configuration.
 *
 * A `static` connection is one set of values a guild admin fills in once for
 * the whole guild. The platform holds them and hands them to this app when it
 * pulls its configuration, keyed by install — which is why the lookup is by
 * `app_install_id` and never by guild id alone: one guild could install the app
 * twice, and the two installs are separate configurations.
 *
 * Beside those values sits one this app worked out rather than was given: the
 * **GitHub installation** covering that account. An admin types an owner and,
 * optionally, which repositories — and the app asks GitHub whether it has been
 * installed there. Nobody pastes a credential or goes looking for an
 * installation id.
 *
 * Persisted rather than cached in memory. Losing it is not catastrophic — the
 * next sync refetches — but every source answers "not configured" until
 * something does, which reads to a member as the app being broken.
 *
 * It is also read **backwards**, twice. A GitHub delivery names a repository
 * and nothing else, so this table is the only thing that can say which installs
 * asked about it ({@link installsWatching}); and an installation event names an
 * installation and nothing else, which is the same problem one column over
 * ({@link installsForInstallation}).
 */

import { pool } from "../db.js";

export interface Workspace {
  owner: string;
  /**
   * The repositories a guild narrowed itself to.
   *
   * Empty means *every repository the installation covers*, which is the
   * useful default: an organization already chose which repositories to grant
   * when it installed the app, and making an admin restate that list in
   * Initiative is asking them to keep two copies of one decision in step.
   */
  repos: string[];
}

/** A workspace as it comes back, with what this app found out about it. */
export interface StoredWorkspace extends Workspace {
  /** The GitHub installation covering it, or null if the app is not installed. */
  installationId: number | null;
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
  workspace: Workspace,
  installationId: number | null
): Promise<void> {
  await pool.query(
    `INSERT INTO workspaces (app_install_id, guild_id, owner, repos, installation_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (app_install_id) DO UPDATE
        SET guild_id = EXCLUDED.guild_id,
            owner = EXCLUDED.owner,
            repos = EXCLUDED.repos,
            installation_id = EXCLUDED.installation_id,
            updated_at = now()`,
    [appInstallId, guildId, workspace.owner, workspace.repos, installationId]
  );
}

/** What this install points at, or null if an admin has not set it up yet. */
export async function workspaceFor(
  appInstallId: number
): Promise<StoredWorkspace | null> {
  const found = await pool.query<{
    owner: string;
    repos: string[] | null;
    installation_id: string | null;
  }>(
    "SELECT owner, repos, installation_id FROM workspaces WHERE app_install_id = $1",
    [appInstallId]
  );
  const row = found.rows[0];
  if (!row) return null;
  return {
    owner: row.owner,
    // Null and empty mean the same thing: every repository the installation
    // covers. Nothing writes null, but the column allows one.
    repos: row.repos ?? [],
    // `pg` hands back BIGINT as a string, since not every value fits a JS
    // number. An installation id comfortably does, so it is narrowed once here.
    installationId: row.installation_id === null ? null : Number(row.installation_id),
  };
}

function watching(rows: Array<{ app_install_id: string; guild_id: string }>) {
  return rows.map((row) => ({
    appInstallId: Number(row.app_install_id),
    guildId: Number(row.guild_id),
  }));
}

/**
 * Which installs a delivery about this repository belongs to.
 *
 * A list, not one row: two guilds may both watch the same repository, and each
 * is entitled to its own event.
 *
 * Matched on the **installation** first rather than on the owner's name. A
 * delivery carries the installation that produced it, which is a fact GitHub
 * asserts; an owner is a string an admin typed and a repository can be renamed
 * or transferred under one. Then narrowed by the guild's own list, where it has
 * one — an empty list means every repository the installation covers, so any
 * delivery from that installation is theirs by construction.
 */
export async function installsWatching(
  installationId: number,
  repo: string
): Promise<WatchingInstall[]> {
  const found = await pool.query<{ app_install_id: string; guild_id: string }>(
    `SELECT app_install_id, guild_id
       FROM workspaces
      WHERE installation_id = $1
        AND (repos IS NULL
             OR cardinality(repos) = 0
             OR EXISTS (SELECT 1 FROM unnest(repos) AS r
                         WHERE lower(r) = lower($2)))`,
    [installationId, repo]
  );
  return watching(found.rows);
}

/**
 * Which installs this GitHub installation answers for.
 *
 * The other reverse lookup, and the one that makes uninstalling at GitHub
 * visible in Initiative. An `installation` delivery says an org added or
 * removed this app and names no repository at all when it is removed — so the
 * installation id is the only handle there is, and this turns it back into the
 * guilds whose dashboards are about to stop working.
 */
export async function installsForInstallation(
  installationId: number
): Promise<WatchingInstall[]> {
  const found = await pool.query<{ app_install_id: string; guild_id: string }>(
    "SELECT app_install_id, guild_id FROM workspaces WHERE installation_id = $1",
    [installationId]
  );
  return watching(found.rows);
}

/**
 * Which installs are waiting for somebody to install the app on their account.
 *
 * The other half of the lifecycle lookup, and the one that is easy to leave
 * out. An `installation.created` delivery is the first time this app has ever
 * heard of that installation, so no row names it yet — matching on the
 * installation id finds nothing, and the guild that has been sitting at
 * `github_app_not_installed` waiting for exactly this would wait for the poll
 * instead.
 *
 * So this matches the other way: by the account an admin typed, among installs
 * that have not found an installation. Case-insensitively, because GitHub
 * treats account names that way and an admin types them by hand.
 */
export async function installsAwaiting(owner: string): Promise<WatchingInstall[]> {
  const found = await pool.query<{ app_install_id: string; guild_id: string }>(
    `SELECT app_install_id, guild_id
       FROM workspaces
      WHERE lower(owner) = lower($1) AND installation_id IS NULL`,
    [owner]
  );
  return watching(found.rows);
}

/** Every installation this app is currently answering for. For the sweep. */
export async function knownInstallations(): Promise<number[]> {
  const found = await pool.query<{ installation_id: string }>(
    "SELECT DISTINCT installation_id FROM workspaces WHERE installation_id IS NOT NULL"
  );
  return found.rows.map((row) => Number(row.installation_id));
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
