/**
 * The guild-scoped half of this app's configuration.
 *
 * A `static` connection is one set of values a guild admin fills in once for
 * the whole guild. The platform holds them and hands them to this app when it
 * pulls its configuration, keyed by install — which is why the lookup here is
 * by `app_install_id` and never by guild id alone: one guild could install the
 * app twice, and the two installs are separate configurations.
 *
 * In-memory because this is a reference app. A real one persists this and
 * refreshes it on the lifecycle call.
 */

export interface Workspace {
  owner: string;
  repo: string;
}

const workspaces = new Map<number, Workspace>();

/** Record what an install was configured with. Called after a config pull. */
export function rememberWorkspace(appInstallId: number, workspace: Workspace): void {
  workspaces.set(appInstallId, workspace);
}

/** What this install points at, or null if an admin has not set it up yet. */
export function workspaceFor(appInstallId: number): Workspace | null {
  return workspaces.get(appInstallId) ?? null;
}

/** Drop an install's configuration. Called on the lifecycle removal signal. */
export function forgetWorkspace(appInstallId: number): void {
  workspaces.delete(appInstallId);
}
