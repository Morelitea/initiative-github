/**
 * Keeping this app's picture of its installs true — on both sides.
 *
 * This app is installed twice by two different people, and neither knows about
 * the other. A guild admin installs it in Initiative and says which repository
 * they care about; an organization owner installs the GitHub App at GitHub and
 * says which repositories it may see. Nothing joins those up except this file,
 * and until they agree there is nothing to answer with.
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
 * a reason, rather than three widgets that quietly say "unavailable" with no
 * cause and no clue whose problem it is.
 */

import { ChannelError, type InstallConfig } from "initiative-app-kit";

import type { Workspace } from "./github/workspace.js";

import { config } from "./config.js";
import { initiative } from "./initiative.js";
import {
  forgetInstallation,
  forgetInstallationsExcept,
  installationForOwner,
} from "./github/app.js";
import {
  forgetInstallsExcept,
  forgetWorkspace,
  knownInstallations,
  rememberWorkspace,
  workspaceFor,
} from "./github/workspace.js";

/**
 * What a `static` connection's values look like once an admin has filled it in.
 *
 * One required field and one optional one. `repos` is a comma-separated list
 * because the field vocabulary a connection form draws from has no array in it
 * — deliberately, since one closed set of field types is what lets one renderer
 * draw every app's settings page — so a list arrives as a string and is split
 * here rather than anywhere a person can see.
 *
 * Blank means *every repository the installation covers*, which is the useful
 * default: the organization already chose which repositories to grant when it
 * installed the app, and asking an admin to restate that list is asking them to
 * keep two copies of one decision in step.
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
  // narrow an installation to fewer repositories without uninstalling it, and
  // that is invisible from every other angle — the token keeps minting and the
  // calls start coming back empty.
  const installationId = await installationForOwner(workspace.owner);
  await rememberWorkspace(installId, guildId, workspace, installationId);

  if (installationId === null && !workspace.repos.length) {
    // The form names an account and no repositories, and nothing has installed
    // the app on that account — so there is no list to resolve against from
    // either side and no tile can answer. Reported as its own reason rather
    // than as "not configured", because the move is somebody else's: an
    // organization owner, at GitHub.
    //
    // An install that *did* name its repositories is not reported here at all.
    // Reads run on each member's own credential, so those tiles answer with or
    // without an installation, and calling the install invalid would be telling
    // an admin their working dashboard is broken. What is still missing in that
    // case is the webhook — which is why the poll keeps looking.
    await initiative.reportStatus(guildId, {
      state: "invalid",
      detail: "github_app_not_installed",
    });
    return false;
  }

  await initiative.reportStatus(guildId, { state: "ok" });
  return true;
}

/** Forget an install this app has been removed from. */
export async function forgetInstall(installId: number): Promise<void> {
  // Read before the row goes, so the held token can go with it rather than
  // sitting in memory answering for a guild that is no longer asking.
  const workspace = await workspaceFor(installId);
  if (workspace?.installationId !== null && workspace?.installationId !== undefined) {
    forgetInstallation(workspace.installationId);
  }
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

  // Held tokens outlive the rows they were minted for by up to an hour, so the
  // sweep is what actually ends access rather than expiry doing it eventually.
  forgetInstallationsExcept(await knownInstallations());
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
