/**
 * The guild's own read access, and why it is the one credential this app does
 * not write down.
 *
 * There are two kinds of credential in an app, and they belong in different
 * places. A credential the app *obtained* — the token a member's OAuth flow
 * produced — is the app's to keep, so it is sealed into Postgres and survives a
 * restart. A credential the platform *lent* it — this one, typed by an admin
 * into Initiative and handed over on a configuration pull — belongs to
 * Initiative, and holding a second durable copy would mean an admin who removed
 * it there had not actually removed it.
 *
 * So this is a process-local map, refilled by every sync. A restart empties it
 * and the sync at boot fills it again; an admin who clears the field sees the
 * next pull stop returning it and this drop it. That is what makes custody real
 * rather than stated.
 *
 * Per install rather than per guild, because one guild can install the app
 * twice and the two installs are separate configurations.
 */

const tokens = new Map<number, string>();

/** Record what a configuration pull returned. */
export function rememberSharedAccess(appInstallId: number, token: string): void {
  tokens.set(appInstallId, token);
}

/** What this install reads the repository with, or null if an admin has not set it. */
export function sharedAccessFor(appInstallId: number): string | null {
  return tokens.get(appInstallId) ?? null;
}

/** Drop one install's, on removal or when its configuration no longer carries one. */
export function forgetSharedAccess(appInstallId: number): void {
  tokens.delete(appInstallId);
}

/**
 * Drop every install not in this list.
 *
 * The reconcile's own sweep. A guild that uninstalled while this app was down
 * sends no signal, so being absent from the platform's list is the only thing
 * that says so.
 */
export function forgetSharedAccessExcept(appInstallIds: number[]): void {
  const keep = new Set(appInstallIds);
  for (const installId of tokens.keys()) {
    if (!keep.has(installId)) tokens.delete(installId);
  }
}
