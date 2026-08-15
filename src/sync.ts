/**
 * Keeping this app's picture of its installs true.
 *
 * An app is told about installs in two ways, and it needs both:
 *
 * - **The lifecycle signal** is the fast path. Initiative posts to
 *   `/v1/lifecycle` when an install is created, reconfigured, or removed, and
 *   this refetches that one install.
 * - **The poll** is the floor under it. A signal that arrives while this app is
 *   restarting is simply gone — nothing retries it — so an install configured
 *   during a deploy would stay unconfigured until somebody touched it again.
 *
 * What it pulls is the guild-wide half of the configuration: which repository
 * the guild cares about. That is also what makes the *inbound* direction
 * possible at all — a GitHub delivery names a repository and nothing else, so
 * without this table there is no way back to a guild to emit into.
 *
 * Reporting the verdict matters as much as reading the values. An admin who
 * typed a repository this app cannot see gets `invalid` beside the install
 * rather than three widgets that quietly say "unavailable" with no cause.
 */

import { ChannelError, type InstallConfig } from "initiative-app-kit";

import { config } from "./config.js";
import { initiative } from "./initiative.js";
import {
  forgetSharedAccess,
  forgetSharedAccessExcept,
  rememberSharedAccess,
} from "./github/shared-access.js";
import {
  forgetInstallsExcept,
  forgetWorkspace,
  rememberWorkspace,
} from "./github/workspace.js";

/** What a `static` connection's values look like once an admin has filled it in. */
function readWorkspace(
  installConfig: InstallConfig
): { owner: string; repo: string } | null {
  const values = installConfig.connections.workspace;
  if (!values) return null;
  const owner = typeof values.owner === "string" ? values.owner.trim() : "";
  const repo = typeof values.repo === "string" ? values.repo.trim() : "";
  if (!owner || !repo) return null;
  // A repository is `owner/repo`, and an admin who typed the whole thing into
  // one box would otherwise produce a path with an extra segment in it.
  if (owner.includes("/") || repo.includes("/")) return null;
  return { owner, repo };
}

/** The guild's shared read token, if an admin has supplied one. */
function readSharedAccess(installConfig: InstallConfig): string | null {
  const token = installConfig.connections.shared_account?.token;
  return typeof token === "string" && token.trim() ? token.trim() : null;
}

/**
 * Pull one install's configuration and record it.
 *
 * Returns whether this app now considers the install usable, which is also
 * what it reports back.
 */
export async function syncInstall(guildId: number): Promise<boolean> {
  const installConfig = await initiative.config(guildId);

  // Held first and unconditionally, so clearing the field in Initiative drops
  // it here on the very next pull rather than only when something else changes.
  const sharedAccess = readSharedAccess(installConfig);
  if (sharedAccess) {
    rememberSharedAccess(installConfig.install_id, sharedAccess);
  } else {
    forgetSharedAccess(installConfig.install_id);
  }

  const workspace = readWorkspace(installConfig);
  if (!workspace) {
    await forgetWorkspace(installConfig.install_id);
    // `needs_config` already says an admin has not finished; saying `invalid`
    // as well would report a problem where there is only an unfinished form.
    if (!installConfig.needs_config) {
      await initiative.reportStatus(guildId, {
        state: "invalid",
        detail: "no_repository",
      });
    }
    return false;
  }

  await rememberWorkspace(installConfig.install_id, guildId, workspace);
  await initiative.reportStatus(guildId, { state: "ok" });
  return true;
}

/** Forget an install this app has been removed from. */
export async function forgetInstall(installId: number): Promise<void> {
  forgetSharedAccess(installId);
  await forgetWorkspace(installId);
}

/**
 * Reconcile every install, from the platform's own list.
 *
 * Installs this app is no longer in are dropped at the end rather than as they
 * are noticed, because "not in the list" is only meaningful once the whole list
 * has been read — a pull that failed halfway would otherwise look like a guild
 * uninstalling.
 */
export async function syncAllInstalls(): Promise<void> {
  const installs = await initiative.installs();

  for (const install of installs) {
    if (!install.enabled) {
      // Switched off is not uninstalled: the configuration is still the
      // guild's, and this app simply stops acting on it.
      forgetSharedAccess(install.install_id);
      await forgetWorkspace(install.install_id);
      continue;
    }
    try {
      await syncInstall(install.guild_id);
    } catch (error) {
      // One guild's failure is not the others'. Logged and stepped over, so a
      // single unreachable install cannot stop the reconcile that would have
      // dropped a stale one.
      console.error(`could not sync install in guild ${install.guild_id}`, error);
    }
  }

  const present = installs.map((i) => i.install_id);
  forgetSharedAccessExcept(present);
  const dropped = await forgetInstallsExcept(present);
  if (dropped) console.log(`dropped ${dropped} install(s) this app is no longer in`);
}

/**
 * Run the reconcile now and on an interval, until the process ends.
 *
 * The first run is awaited so a failure at boot is visible in the logs beside
 * everything else that starts; later runs are logged and dropped, since an app
 * that exited on a transient platform blip would be worse than one that is
 * briefly out of date.
 */
export function startSync(): { stop: () => void } {
  const run = () =>
    syncAllInstalls().catch((error) => {
      if (error instanceof ChannelError) {
        console.error(`sync refused: ${error.status} ${error.detail}`);
      } else {
        console.error("sync failed", error);
      }
    });

  void run();
  const timer = setInterval(run, Math.max(30, config.syncIntervalSeconds) * 1000);
  // Nothing should be held open by this: a shutdown mid-interval is a sync that
  // simply does not happen.
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
