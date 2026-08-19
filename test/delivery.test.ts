/**
 * From a repository name back to a guild.
 *
 * A GitHub delivery carries a repository and no guild — there is no guild
 * anywhere in GitHub's world. Everything that makes the trigger side work is
 * the reverse lookup this exercises, and it is the piece with no equivalent on
 * the outbound path: sources are told which install is calling, and this has to
 * work it out.
 *
 * Needs a database, because the lookup *is* the database. `DATABASE_URL` in CI;
 * see README.md to run it locally.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` is hoisted above every import, so the double has to be built in a
// hoisted block too — the delivery path must get this rather than a client that
// would try to reach a platform.
const { emitEvent, syncInstall } = vi.hoisted(() => ({
  emitEvent: vi.fn<(guildId: number, type: string, payload: unknown) => Promise<void>>(
    async () => {}
  ),
  // An installation delivery re-runs the sync, which would otherwise want a
  // platform to talk to. What matters here is *which* guilds it names.
  syncInstall: vi.fn<(guildId: number) => Promise<boolean>>(async () => true),
}));
vi.mock("../src/initiative.js", () => ({ initiative: { emitEvent } }));
vi.mock("../src/sync.js", () => ({ syncInstall }));

import { close, migrate, pool } from "../src/db.js";
import { EVENTS, handleDelivery } from "../src/github/webhooks.js";
import {
  installsForInstallation,
  installsWatching,
  rememberWorkspace,
} from "../src/github/workspace.js";

const OPENED = {
  action: "opened",
  // A GitHub App delivery names the installation that produced it. That is the
  // handle the reverse lookup turns on now — an owner is a string an admin
  // typed and a repository can be renamed under one; this is a fact.
  installation: { id: 9011 },
  repository: { full_name: "acme/widgets" },
  issue: {
    number: 42,
    title: "Something is broken",
    html_url: "https://github.com/acme/widgets/issues/42",
    labels: [{ name: "bug" }],
  },
};

beforeEach(async () => {
  await migrate();
  await pool.query("TRUNCATE workspaces");
  emitEvent.mockClear();
  syncInstall.mockClear();
});

afterAll(async () => {
  await close();
});

describe("which installs asked about this repository", () => {
  it("finds the install that named it", async () => {
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, 9011);

    expect(await installsWatching(9011, "widgets")).toEqual([
      { appInstallId: 11, guildId: 500 },
    ]);
  });

  it("matches the way GitHub does, not the way an admin typed it", async () => {
    await rememberWorkspace(11, 500, { owner: "Acme", repos: ["Widgets"] }, 9011);

    expect(await installsWatching(9011, "widgets")).toHaveLength(1);
  });

  it("finds nobody for a repository no install named", async () => {
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, 9011);

    expect(await installsWatching(9011, "gadgets")).toEqual([]);
  });

  it("keeps one row per install as its configuration changes", async () => {
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, 9011);
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["gadgets"] }, 9011);

    expect(await installsWatching(9011, "widgets")).toEqual([]);
    expect(await installsWatching(9011, "gadgets")).toHaveLength(1);
  });
});

describe("where a delivery goes", () => {
  it("emits into the guild watching the repository", async () => {
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, 9011);

    expect(await handleDelivery("issues", OPENED)).toEqual({ emitted: 1 });
    expect(emitEvent).toHaveBeenCalledWith(500, EVENTS.issueOpened, {
      repository: "widgets",
      issue_number: 42,
      issue_title: "Something is broken",
      issue_url: "https://github.com/acme/widgets/issues/42",
      issue_labels: ["bug"],
    });
  });

  it("emits into every guild watching it", async () => {
    // Two guilds can both watch one public repository, and each is entitled to
    // its own event — neither knows the other exists.
    // One installation, two guilds: the organization granted access once and
    // two guilds pointed at it. Each is still entitled to its own event.
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, 9011);
    await rememberWorkspace(12, 600, { owner: "acme", repos: ["widgets"] }, 9011);

    expect(await handleDelivery("issues", OPENED)).toEqual({ emitted: 2 });
    expect(emitEvent.mock.calls.map((call) => call[0])).toEqual([500, 600]);
  });

  it("emits nothing for a repository nobody installed against", async () => {
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["gadgets"] }, 9011);

    expect(await handleDelivery("issues", OPENED)).toEqual({
      emitted: 0,
      reason: "no-install",
    });
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("emits nothing for a verb no trigger asked about", async () => {
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, 9011);

    expect(await handleDelivery("issues", { ...OPENED, action: "labeled" })).toEqual({
      emitted: 0,
      reason: "unhandled",
    });
    // Checked before the lookup, so a repository that sends a hundred verbs a
    // day does not cost a query for each.
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("emits nothing when the payload names no repository", async () => {
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, 9011);
    const { repository: _dropped, ...noRepo } = OPENED;

    expect(await handleDelivery("issues", noRepo)).toEqual({
      emitted: 0,
      reason: "no-repository",
    });
  });

  it("still reaches the second guild when the first one refuses", async () => {
    // A guild that disabled the app refuses its event. Retrying the delivery to
    // reach the others would deliver it twice everywhere it already landed, so
    // the failure is counted and stepped over.
    // One installation, two guilds: the organization granted access once and
    // two guilds pointed at it. Each is still entitled to its own event.
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, 9011);
    await rememberWorkspace(12, 600, { owner: "acme", repos: ["widgets"] }, 9011);
    emitEvent.mockRejectedValueOnce(new Error("refused"));

    expect(await handleDelivery("issues", OPENED)).toEqual({ emitted: 1 });
    expect(emitEvent).toHaveBeenCalledTimes(2);
  });
});

describe("which installs this installation answers for", () => {
  it("finds them by installation, for a delivery naming no repository", async () => {
    // An `installation` delivery for a removal carries the installation and
    // nothing else useful, so this is the only way back to a guild.
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, 9011);

    expect(await installsForInstallation(9011)).toEqual([
      { appInstallId: 11, guildId: 500 },
    ]);
    expect(await installsForInstallation(9999)).toEqual([]);
  });
});

describe("when the relationship changes rather than the repository", () => {
  /** What GitHub sends when an org removes the app. */
  const REMOVED = {
    action: "deleted",
    installation: { id: 9011 },
  };

  /** What it sends when an org adds it, before this app has ever seen it. */
  const ADDED = {
    action: "created",
    // The first time this app has heard of this installation, so nothing names
    // it yet. The account is the only handle back to a guild.
    installation: { id: 7000, account: { login: "acme" } },
    repositories: [{ full_name: "acme/widgets" }],
  };

  it("emits nothing and re-syncs the installs it answered for", async () => {
    // Nobody asked to be told that an org owner clicked a button, and no event
    // in the manifest could carry it. What it changes is whether the app can
    // answer at all.
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, 9011);

    expect(await handleDelivery("installation", REMOVED)).toEqual({
      emitted: 0,
      resynced: 1,
      reason: "installation",
    });
    expect(emitEvent).not.toHaveBeenCalled();
    expect(syncInstall).toHaveBeenCalledWith(500);
  });

  it("finds the guild by account when the installation is brand new", async () => {
    // The guild that has been sitting at `github_app_not_installed` waiting for
    // exactly this. Its row names no installation yet, so matching on the
    // installation id finds nothing and the account is the only handle there is.
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, null);

    expect(await handleDelivery("installation", ADDED)).toEqual({
      emitted: 0,
      resynced: 1,
      reason: "installation",
    });
    expect(syncInstall).toHaveBeenCalledWith(500);
  });

  it("re-syncs a guild once when both handles find it", async () => {
    // Named by the installation and matched by the account would be two hits on
    // one guild; a run per handle would re-sync it twice.
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, 7000);

    await handleDelivery("installation", ADDED);

    expect(syncInstall).toHaveBeenCalledTimes(1);
  });

  it("follows repositories added to an installation that already existed", async () => {
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["gadgets"] }, 7000);

    const result = await handleDelivery("installation_repositories", {
      action: "added",
      installation: { id: 7000, account: { login: "acme" } },
      repositories_added: [{ full_name: "acme/gadgets" }],
    });

    expect(result).toEqual({ emitted: 0, resynced: 1, reason: "installation" });
    expect(syncInstall).toHaveBeenCalledWith(500);
  });

  it("says so when the change touches nobody here", async () => {
    // Neither handle finds anything: no row names this installation, and no
    // guild has typed this account.
    expect(await handleDelivery("installation", ADDED)).toEqual({
      emitted: 0,
      resynced: 0,
      reason: "installation",
    });
    expect(syncInstall).not.toHaveBeenCalled();
  });
});

describe("a delivery that names no installation", () => {
  it("is answered rather than failed", async () => {
    // Every GitHub App delivery carries one, so this is a payload that could
    // only arrive from something that is not GitHub — and the signature already
    // said otherwise. Answered rather than thrown, because a webhook endpoint
    // that raises on a shape it did not expect fails the delivery and GitHub
    // retries it forever.
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, 9011);
    const { installation: _dropped, ...noInstallation } = OPENED;

    expect(await handleDelivery("issues", noInstallation)).toEqual({
      emitted: 0,
      reason: "no-installation",
    });
    expect(emitEvent).not.toHaveBeenCalled();
  });
});
