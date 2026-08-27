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
 * `installationId` is what GitHub said: a number, or `null` for "there is no
 * installation", which has to be recorded so an app that was uninstalled stops
 * being found. Pass `undefined` when GitHub did not say — the row keeps the id
 * it already had rather than recording an absence nobody established.
 */
export async function rememberWorkspace(
  appInstallId: number,
  guildId: number,
  workspace: Workspace,
  installationId: number | null | undefined
): Promise<void> {
  const learned = installationId !== undefined;
  await pool.query(
    `INSERT INTO workspaces (app_install_id, guild_id, owner, repos, installation_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (app_install_id) DO UPDATE
        SET guild_id = EXCLUDED.guild_id,
            owner = EXCLUDED.owner,
            repos = EXCLUDED.repos,
            installation_id = CASE WHEN $6 THEN EXCLUDED.installation_id
                                   ELSE workspaces.installation_id END,
            updated_at = now()`,
    [
      appInstallId,
      guildId,
      workspace.owner,
      workspace.repos,
      installationId ?? null,
      learned,
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

export async function installsAwaiting(owner: string): Promise<WatchingInstall[]> {
  const found = await pool.query<{ app_install_id: string; guild_id: string }>(
    `SELECT app_install_id, guild_id
       FROM workspaces
      WHERE lower(owner) = lower($1) AND installation_id IS NULL`,
    [owner]
  );
  return watching(found.rows);
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
