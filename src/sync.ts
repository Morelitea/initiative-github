/**
 * Keeping this app's picture of its installs true — on both sides.
 *
 * This app is installed twice by two different people, and neither knows about
 * the other. A guild admin installs it in Initiative and names the repositories
 * they care about; an organization owner installs the GitHub App at GitHub, and
 * that is what makes deliveries arrive. Nothing joins those up except this
 * file, and until both have happened there is nothing to answer with.
 *
 * So there are three ways this app learns something changed, and it needs all
 * three:
 *
 * - **The lifecycle signal** is the fast path on the Initiative side.
 *   Initiative posts to `/v1/lifecycle` when an install is created,
 *   reconfigured, or removed, and this refetches that one install.
 * - **The webhook** is the fast path on the GitHub side. An `installation`
 *   delivery is an org adding or removing the app, and it arrives in seconds.
 * - **The poll** is the floor under both. A signal that arrives while this app
 *   is restarting is simply gone — nothing retries it — and the two sides can
 *   be put right in either order by two people who never speak, so an install
 *   that was `invalid` at 10:00 because nobody had installed the GitHub App
 *   becomes `ok` on the next pull rather than when somebody touches the form.
 *
 * Reporting the verdict matters as much as reading the values. An admin who
 * typed a repository this app cannot see gets `invalid` beside the install with
 * a reason, rather than widgets that quietly say "unavailable" with no cause
 * and no clue whose problem it is.
 */

import { ChannelError, type InstallConfig } from "initiative-app-kit";

import type { Workspace } from "./github/workspace.js";

import { config } from "./config.js";
import { initiative } from "./initiative.js";
import {
  installationForOwner,
} from "./github/app.js";
import {
  forgetInstallsExcept,
  forgetWorkspace,
  rememberWorkspace,
} from "./github/workspace.js";

/**
 * What a `static` connection's values look like once an admin has filled it in.
 *
 * Two fields, both required, and `null` for either one missing — an install
 * that named no repository has nothing to answer about, so it is unfinished
 * rather than broad.
 *
 * `repos` is a comma-separated list because the field vocabulary a connection
 * form draws from has no array in it — deliberately, since one closed set of
 * field types is what lets one renderer draw every app's settings page — so a
 * list arrives as a string and is split here rather than anywhere a person can
 * see.
 */
function readWorkspace(installConfig: InstallConfig): Workspace | null {
  const values = installConfig.connections.workspace;
  if (!values) return null;

  const owner = typeof values.owner === "string" ? values.owner.trim() : "";
  // An owner is one path segment. Somebody who typed `acme/widgets` into it
  // would otherwise build every URL with an extra segment in it.
  if (!owner || owner.includes("/")) return null;

  const listed = typeof values.repos === "string" ? values.repos : "";
  const repos = listed
    .split(",")
    .map((name) => name.trim())
    // A repository typed as `acme/widgets` when the owner is already named
    // separately is the same mistake one field over; take the last segment,
    // which is what they meant.
    .map((name) => (name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name))
    .filter(Boolean);
  if (!repos.length) return null;

  return { owner, repos };
}

/**
 * Pull one install's configuration, find its installation, and record both.
 *
 * Returns whether this app now considers the install usable, which is also
 * what it reports back.
 */
export async function syncInstall(guildId: number): Promise<boolean> {
  const installConfig = await initiative.config(guildId);
  const installId = installConfig.install_id;

  const workspace = readWorkspace(installConfig);
  if (!workspace) {
    await forgetInstall(installId);
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

  // Asked every time rather than trusted from last time. An organization can
  // uninstall and reinstall the app, which is a different installation id under
  // the same name — and every delivery is routed by that id, so a stale one
  // means events silently stop arriving.
  const installationId = await installationForOwner(workspace.owner);
  await rememberWorkspace(installId, guildId, workspace, installationId);

  // Reported `ok` whether or not an organization owner has installed the app at
  // GitHub yet. Reads and writes run on the caller's own credential against the
  // repositories this form names, so they answer either way, and telling an
  // admin their working dashboard is invalid would be false. The installation
  // is what routes *deliveries* — so until it exists, emissions are what this
  // guild is missing, and the poll keeps looking because the remedy belongs to
  // somebody else.
  await initiative.reportStatus(guildId, { state: "ok" });
  return true;
}

/** Forget an install this app has been removed from. */
export async function forgetInstall(installId: number): Promise<void> {
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
      await forgetInstall(install.install_id);
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

  const present = installs.filter((i) => i.enabled).map((i) => i.install_id);
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
