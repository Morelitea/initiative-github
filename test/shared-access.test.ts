/**
 * The guild's credential is Initiative's, held here only as long as it is
 * still there.
 *
 * That is the whole claim the shared tier rests on. An admin who clears the
 * field, switches the app off, or uninstalls has to see access actually stop —
 * and since nothing pushes that to this app, "stop" means the next pull returns
 * nothing and this drops what it was holding. A cache that kept the last good
 * value would make removing it a suggestion.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { config: configCall, installs, reportStatus } = vi.hoisted(() => ({
  config: vi.fn(),
  installs: vi.fn(),
  reportStatus: vi.fn(async () => ({})),
}));
vi.mock("../src/initiative.js", () => ({
  initiative: { config: configCall, installs, reportStatus },
}));

// The workspace half is Postgres-backed and has its own tests; this file is
// about what is held in memory, so its writes are stubbed out.
vi.mock("../src/github/workspace.js", () => ({
  rememberWorkspace: vi.fn(async () => {}),
  forgetWorkspace: vi.fn(async () => {}),
  forgetInstallsExcept: vi.fn(async () => 0),
}));

import { sharedAccessFor } from "../src/github/shared-access.js";
import { forgetInstall, syncAllInstalls, syncInstall } from "../src/sync.js";

/** One install's configuration as the channel returns it. */
function installConfig(overrides: Record<string, unknown> = {}) {
  return {
    guild_id: 500,
    install_id: 11,
    listing_uid: "TESTAPP0000001",
    listing_version: "0.3.0",
    enabled: true,
    config_state: "ok",
    config_state_detail: null,
    needs_config: false,
    connections: {
      workspace: { owner: "acme", repo: "widgets" },
      shared_account: { token: "ghp_shared" },
    },
    member_connections: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  reportStatus.mockResolvedValue({});
});

describe("holding the guild's access", () => {
  it("holds what a pull returned", async () => {
    configCall.mockResolvedValue(installConfig());

    await syncInstall(500);

    expect(sharedAccessFor(11)).toBe("ghp_shared");
  });

  it("drops it when an admin clears the field", async () => {
    configCall.mockResolvedValueOnce(installConfig());
    await syncInstall(500);
    expect(sharedAccessFor(11)).toBe("ghp_shared");

    configCall.mockResolvedValueOnce(
      installConfig({
        connections: { workspace: { owner: "acme", repo: "widgets" } },
      })
    );
    await syncInstall(500);

    expect(sharedAccessFor(11)).toBeNull();
  });

  it("drops it even when the repository is missing too", async () => {
    // The repository check returns early, so the credential has to be handled
    // before it — otherwise clearing both would leave the token held.
    configCall.mockResolvedValueOnce(installConfig());
    await syncInstall(500);

    configCall.mockResolvedValueOnce(
      installConfig({ connections: {}, needs_config: true })
    );
    await syncInstall(500);

    expect(sharedAccessFor(11)).toBeNull();
  });

  it("ignores a field an admin left blank", async () => {
    configCall.mockResolvedValue(
      installConfig({
        connections: {
          workspace: { owner: "acme", repo: "widgets" },
          shared_account: { token: "   " },
        },
      })
    );

    await syncInstall(500);

    expect(sharedAccessFor(11)).toBeNull();
  });

  it("drops it when the guild switches the app off", async () => {
    configCall.mockResolvedValueOnce(installConfig());
    await syncInstall(500);

    installs.mockResolvedValue([
      { install_id: 11, guild_id: 500, enabled: false },
    ]);
    await syncAllInstalls();

    expect(sharedAccessFor(11)).toBeNull();
  });

  it("drops it when the guild is no longer in the platform's list", async () => {
    // A guild that uninstalled while this app was down sends no signal, so
    // being absent from the list is the only thing that says so.
    configCall.mockResolvedValueOnce(installConfig());
    await syncInstall(500);
    expect(sharedAccessFor(11)).toBe("ghp_shared");

    installs.mockResolvedValue([]);
    await syncAllInstalls();

    expect(sharedAccessFor(11)).toBeNull();
  });

  it("drops it on the removal signal", async () => {
    configCall.mockResolvedValueOnce(installConfig());
    await syncInstall(500);

    await forgetInstall(11);

    expect(sharedAccessFor(11)).toBeNull();
  });

  it("keeps one guild's access out of another's", async () => {
    configCall.mockResolvedValueOnce(installConfig());
    await syncInstall(500);
    configCall.mockResolvedValueOnce(
      installConfig({
        guild_id: 600,
        install_id: 12,
        connections: {
          workspace: { owner: "acme", repo: "gadgets" },
          shared_account: { token: "ghp_other" },
        },
      })
    );
    await syncInstall(600);

    expect(sharedAccessFor(11)).toBe("ghp_shared");
    expect(sharedAccessFor(12)).toBe("ghp_other");
  });
});
