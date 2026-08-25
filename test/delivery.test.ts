/**
 * An organization changed its mind, and this app finding out.
 *
 * The only deliveries this app acts on are about its own installation, and the
 * lookup they need has no equivalent on any other path: GitHub names an
 * installation, and this app has to turn that back into the guilds whose
 * dashboards are about to start or stop working.
 *
 * It has to work in both directions, and they need different handles.
 * *Removing* names an installation this app already recorded, so the lookup is
 * by installation id. *Adding* names one it has never seen — no row can name it
 * yet — and the guild sitting at `github_app_not_installed` waiting for exactly
 * this is found by the account instead. Leaving the second one out is the easy
 * mistake: everything still works, just five minutes later, and only for the
 * case somebody is watching.
 *
 * Needs a database, because the lookup *is* the database. `DATABASE_URL` in CI;
 * see README.md to run it locally.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` is hoisted above every import, so the double has to be built in a
// hoisted block too — the delivery path must get this rather than something
// that would try to reach a platform.
const { syncInstall } = vi.hoisted(() => ({
  syncInstall: vi.fn<(guildId: number) => Promise<boolean>>(async () => true),
}));
vi.mock("../src/sync.js", () => ({ syncInstall }));

import { close, migrate, pool } from "../src/db.js";
import { handleDelivery } from "../src/github/webhooks.js";
import {
  installsAwaiting,
  installsForInstallation,
  rememberWorkspace,
} from "../src/github/workspace.js";

beforeEach(async () => {
  await migrate();
  await pool.query("TRUNCATE workspaces");
  syncInstall.mockClear();
});

afterAll(async () => {
  await close();
});

describe("turning an installation back into guilds", () => {
  it("finds the installs it answers for", async () => {
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, 9011);

    expect(await installsForInstallation(9011)).toEqual([
      { appInstallId: 11, guildId: 500 },
    ]);
    expect(await installsForInstallation(9999)).toEqual([]);
  });

  it("finds the installs still waiting for one", async () => {
    // The row an `installation.created` delivery is about, and the only handle
    // it has is the account an admin typed.
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, null);

    expect(await installsAwaiting("acme")).toEqual([
      { appInstallId: 11, guildId: 500 },
    ]);
    // Matched the way GitHub treats account names, since an admin types them.
    expect(await installsAwaiting("ACME")).toHaveLength(1);
    // And not the ones that already found an installation.
    await rememberWorkspace(12, 600, { owner: "acme", repos: ["widgets"] }, 9012);
    expect(await installsAwaiting("acme")).toHaveLength(1);
  });
});

describe("what a delivery does", () => {
  /** What GitHub sends when an organization removes the app. */
  const REMOVED = {
    action: "deleted",
    installation: { id: 9011, account: { login: "acme" } },
  };

  /** And when it adds it, before this app has ever seen that installation. */
  const ADDED = {
    action: "created",
    installation: { id: 7000, account: { login: "acme" } },
  };

  it("re-syncs the installs an installation answered for", async () => {
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, 9011);

    expect(await handleDelivery("installation", REMOVED)).toEqual({ resynced: 1 });
    expect(syncInstall).toHaveBeenCalledWith(500);
  });

  it("re-syncs the guild that was waiting, when the installation is new", async () => {
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, null);

    expect(await handleDelivery("installation", ADDED)).toEqual({ resynced: 1 });
    expect(syncInstall).toHaveBeenCalledWith(500);
  });

  it("re-syncs a guild once when both handles find it", async () => {
    // Named by the installation and matched by the account would be two hits on
    // one guild; a run per handle would re-sync it twice.
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, 7000);

    await handleDelivery("installation", ADDED);

    expect(syncInstall).toHaveBeenCalledTimes(1);
  });

  it("follows a change to which repositories it may see", async () => {
    await rememberWorkspace(11, 500, { owner: "acme", repos: [] }, 7000);

    const result = await handleDelivery("installation_repositories", {
      action: "added",
      installation: { id: 7000, account: { login: "acme" } },
      repositories_added: [{ full_name: "acme/gadgets" }],
    });

    expect(result).toEqual({ resynced: 1 });
    expect(syncInstall).toHaveBeenCalledWith(500);
  });

  it("says so when the change touches nobody here", async () => {
    expect(await handleDelivery("installation", ADDED)).toEqual({ resynced: 0 });
    expect(syncInstall).not.toHaveBeenCalled();
  });

  it("ignores repository activity rather than failing it", async () => {
    // This app subscribes to none of it, but a registration can be edited and a
    // delivery can arrive anyway. Failing it would fill an organization's
    // webhook log with red for something working exactly as intended.
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, 9011);

    expect(await handleDelivery("issues", { action: "opened" })).toEqual({
      resynced: 0,
      reason: "unhandled",
    });
    expect(syncInstall).not.toHaveBeenCalled();
  });

  it("survives a lifecycle payload with no installation in it", async () => {
    // Every real one carries it, so this could only come from something that is
    // not GitHub — and the signature already said otherwise. Answered rather
    // than thrown: a webhook endpoint that raises on an unexpected shape fails
    // the delivery, and GitHub retries a failure.
    expect(await handleDelivery("installation", { action: "created" })).toEqual({
      resynced: 0,
      reason: "no-installation",
    });
  });
});
