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
 * lifecycle signal refetches — but every source answers "not configured" until
 * something does, which reads to a member as the app being broken.
 */

import { pool } from "../db.js";

export interface Workspace {
  owner: string;
  repo: string;
}

/** Record what an install was configured with. Called after a config pull. */
export async function rememberWorkspace(
  appInstallId: number,
  workspace: Workspace
): Promise<void> {
  await pool.query(
    `INSERT INTO workspaces (app_install_id, owner, repo)
     VALUES ($1, $2, $3)
     ON CONFLICT (app_install_id) DO UPDATE
        SET owner = EXCLUDED.owner, repo = EXCLUDED.repo, updated_at = now()`,
    [appInstallId, workspace.owner, workspace.repo]
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

/** Drop an install's configuration. For the lifecycle removal signal. */
export async function forgetWorkspace(appInstallId: number): Promise<void> {
  await pool.query("DELETE FROM workspaces WHERE app_install_id = $1", [appInstallId]);
}
