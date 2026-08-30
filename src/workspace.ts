import { pool } from "./db.js";

export interface Workspace {
  owner: string;
    repos: string[];
}

export interface StoredWorkspace extends Workspace {
    installationId: number | null;
}

export interface WatchingInstall {
  appInstallId: number;
  guildId: number;
}

/**
 * Write down what this install watches, and what routes deliveries to it.
 *
 * Two of these are the same shape of answer and are passed the same way.
 * `installationId` is what GitHub said: a number, or `null` for "there is no
 * installation", which has to be recorded so an app that was uninstalled stops
 * being found. `repos` is what that installation covers. Pass `undefined` for
 * either where GitHub did not say — the row keeps what it had rather than
 * recording an absence nobody established, because an empty boundary is not a
 * narrower guess, it is every tile in the guild going dark.
 */
export async function rememberWorkspace(
  appInstallId: number,
  guildId: number,
  owner: string,
  installationId: number | null | undefined,
  repos: string[] | undefined
): Promise<void> {
  const learnedInstall = installationId !== undefined;
  const learnedRepos = repos !== undefined;
  await pool.query(
    `INSERT INTO workspaces (app_install_id, guild_id, owner, repos, installation_id)
     VALUES ($1, $2, $3, COALESCE($4, ARRAY[]::text[]), $5)
     ON CONFLICT (app_install_id) DO UPDATE
        SET guild_id = EXCLUDED.guild_id,
            owner = EXCLUDED.owner,
            repos = CASE WHEN $7 THEN EXCLUDED.repos ELSE workspaces.repos END,
            installation_id = CASE WHEN $6 THEN EXCLUDED.installation_id
                                   ELSE workspaces.installation_id END,
            updated_at = now()`,
    [
      appInstallId,
      guildId,
      owner,
      repos ?? null,
      installationId ?? null,
      learnedInstall,
      learnedRepos,
    ]
  );
}

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

    repos: row.repos ?? [],

    installationId: row.installation_id === null ? null : Number(row.installation_id),
  };
}

function watching(rows: Array<{ app_install_id: string; guild_id: string }>) {
  return rows.map((row) => ({
    appInstallId: Number(row.app_install_id),
    guildId: Number(row.guild_id),
  }));
}

export async function installsWatching(
  installationId: number,
  repo: string
): Promise<WatchingInstall[]> {
  const found = await pool.query<{ app_install_id: string; guild_id: string }>(
    `SELECT app_install_id, guild_id
       FROM workspaces
      WHERE installation_id = $1
        AND EXISTS (SELECT 1 FROM unnest(repos) AS r
                     WHERE lower(r) = lower($2))`,
    [installationId, repo]
  );
  return watching(found.rows);
}

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
 * The installation one guild is bound to, if it is bound to one.
 *
 * By guild rather than by install id, because the caller here holds a member's
 * credential and knows which guild it was minted for and nothing else.
 */
export async function installationForGuild(guildId: number): Promise<number | null> {
  const found = await pool.query<{ installation_id: string | null }>(
    "SELECT installation_id FROM workspaces WHERE guild_id = $1 LIMIT 1",
    [guildId]
  );
  const held = found.rows[0]?.installation_id ?? null;
  return held === null ? null : Number(held);
}

export async function forgetWorkspace(appInstallId: number): Promise<void> {
  await pool.query("DELETE FROM workspaces WHERE app_install_id = $1", [appInstallId]);
}

export async function forgetInstallsExcept(appInstallIds: number[]): Promise<number> {
  const result = await pool.query(
    "DELETE FROM workspaces WHERE NOT (app_install_id = ANY($1::bigint[]))",
    [appInstallIds]
  );
  return result.rowCount ?? 0;
}

export type RepositoryChoice =
  | { owner: string; repo: string }
  | { unavailable: string };

export function resolveRepository(
  workspace: StoredWorkspace | null,
  wanted?: string | null
): RepositoryChoice {
  if (!workspace || !workspace.repos.length) {
    return { unavailable: "not-configured" };
  }

  const allowed = workspace.repos;
  const asked = wanted?.trim();

  if (asked) {
    const repo = allowed.find((name) => name.toLowerCase() === asked.toLowerCase());

    if (!repo) return { unavailable: "repository-not-listed" };
    return { owner: workspace.owner, repo };
  }

  if (allowed.length === 1) return { owner: workspace.owner, repo: allowed[0] };

  return { unavailable: "repository-required" };
}
