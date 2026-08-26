/**
 * The guild's access is the organization's grant, held only while it lasts.
 *
 * This replaces a test about a token an admin pasted, and the claim it makes is
 * stronger. A pasted credential was Initiative's to lend, so "revoked" meant
 * the next configuration pull stopped returning it and this app dropped what it
 * held. An installation is GitHub's, so "revoked" means the app can no longer
 * mint a token at all — there is nothing to drop, because there was never a
 * durable copy to keep.
 *
 * What still has to be proved is everything around that: that the installation
 * is found from what an admin typed rather than from anything they pasted, that
 * an install pointing at a repository nobody installed the app on is reported
 * as such rather than left looking broken, and that a token minted for one
 * install stops being held the moment that install goes away.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  config: configCall,
  installs,
  reportStatus,
  installationForOwner,
  rememberWorkspace,
  workspaceFor,
  forgetWorkspace,
  forgetInstallsExcept,
  knownInstallations,
} = vi.hoisted(() => ({
  config: vi.fn(),
  installs: vi.fn(),
  reportStatus: vi.fn(async () => ({})),
  installationForOwner: vi.fn(async () => null as number | null),
  rememberWorkspace: vi.fn(async () => {}),
  workspaceFor: vi.fn(async () => null as unknown),
  forgetWorkspace: vi.fn(async () => {}),
  forgetInstallsExcept: vi.fn(async () => 0),
  knownInstallations: vi.fn(async () => [] as number[]),
}));

vi.mock("../src/initiative.js", () => ({
  initiative: { config: configCall, installs, reportStatus },
}));

// The workspace half is Postgres-backed and has its own tests; this file is
// about what the sync decides, so its writes are stubbed out.
vi.mock("../src/github/workspace.js", () => ({
  rememberWorkspace,
  workspaceFor,
  forgetWorkspace,
  forgetInstallsExcept,
  knownInstallations,
}));

// GitHub is stubbed at the one call that matters: "have you been installed on
// this repository?". Everything the sync decides hangs off its answer.
vi.mock("../src/github/app.js", async () => {
  const actual = await vi.importActual<typeof import("../src/github/app.js")>(
    "../src/github/app.js"
  );
  return { ...actual, installationForOwner };
});

import { forgetInstallation, installationToken } from "../src/github/app.js";
import { forgetInstall, syncAllInstalls, syncInstall } from "../src/sync.js";

/** One install's configuration as the channel returns it. */
function installConfig(overrides: Record<string, unknown> = {}) {
  return {
    guild_id: 500,
    install_id: 11,
    listing_uid: "TESTAPP0000001",
    listing_version: "0.4.0",
    enabled: true,
    config_state: "ok",
    config_state_detail: null,
    needs_config: false,
    connections: { workspace: { owner: "acme", repos: "widgets" } },
    member_connections: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  reportStatus.mockResolvedValue({});
  workspaceFor.mockResolvedValue(null);
  knownInstallations.mockResolvedValue([]);
});

describe("finding the guild's access", () => {
  it("finds the installation from the repository an admin typed", async () => {
    // The whole point of the change: nobody pastes a credential. An admin fills
    // in the repository they were always going to fill in, and the app asks
    // GitHub whether it has been installed there.
    configCall.mockResolvedValue(installConfig());
    installationForOwner.mockResolvedValue(4242);

    await expect(syncInstall(500)).resolves.toBe(true);

    // Asked of the account, not of a repository: one grant covers every
    // repository the organization chose, so asking per repository would be one
    // call per repository to learn the same id.
    expect(installationForOwner).toHaveBeenCalledWith("acme");
    expect(rememberWorkspace).toHaveBeenCalledWith(
      11,
      500,
      { owner: "acme", repos: ["widgets"] },
      4242
    );
    expect(reportStatus).toHaveBeenCalledWith(500, { state: "ok" });
  });

  it("says so when nothing can be resolved without an installation", async () => {
    // A form naming an account and no repositories, with nothing installed on
    // that account: neither side has a list, so no tile can answer. A different
    // problem with a different owner — somebody at GitHub, not the admin who
    // just filled the form in — so it gets its own reason rather than reading
    // as "not configured".
    configCall.mockResolvedValue(
      installConfig({ connections: { workspace: { owner: "acme", repos: "" } } })
    );
    installationForOwner.mockResolvedValue(null);

    await expect(syncInstall(500)).resolves.toBe(false);

    expect(reportStatus).toHaveBeenCalledWith(500, {
      state: "invalid",
      detail: "github_app_not_installed",
    });
  });

  it("calls an install usable when the guild named its repositories", async () => {
    // The change least privilege bought. Reads run on each member's own GitHub
    // credential, so those tiles answer with or without an installation — and
    // telling an admin their working dashboard is invalid would be false.
    //
    // What is still missing is the webhook, which is why the poll keeps
    // looking rather than treating this as settled.
    configCall.mockResolvedValue(installConfig());
    installationForOwner.mockResolvedValue(null);

    await expect(syncInstall(500)).resolves.toBe(true);
    expect(reportStatus).toHaveBeenCalledWith(500, { state: "ok" });
  });

  it("records the absence, so a source answers rather than guessing", async () => {
    // Written down as null rather than left at whatever it was. An install that
    // was working and has been uninstalled at GitHub has to stop working here.
    configCall.mockResolvedValue(installConfig());
    installationForOwner.mockResolvedValue(null);

    await syncInstall(500);

    expect(rememberWorkspace).toHaveBeenCalledWith(
      11,
      500,
      { owner: "acme", repos: ["widgets"] },
      null
    );
  });

  it("asks again on every sync, because an org can narrow what it granted", async () => {
    // Removing one repository from an installation is invisible from every
    // other angle: the installation still exists, the token still mints, and
    // the calls quietly come back empty. Checked on an install that named no
    // repositories, since that is the one whose answer depends on the grant.
    configCall.mockResolvedValue(
      installConfig({ connections: { workspace: { owner: "acme", repos: "" } } })
    );
    installationForOwner.mockResolvedValueOnce(4242).mockResolvedValueOnce(null);

    await expect(syncInstall(500)).resolves.toBe(true);
    await expect(syncInstall(500)).resolves.toBe(false);
  });

  it("records the installation going away even where nothing stops working", async () => {
    // The dashboard carries on — but the webhook does not, and the row is what
    // routes a delivery back to a guild. Writing the absence down is how the
    // next delivery for that installation finds nobody rather than finding a
    // guild that has not been in it for a week.
    configCall.mockResolvedValue(installConfig());
    installationForOwner.mockResolvedValueOnce(4242).mockResolvedValueOnce(null);

    await syncInstall(500);
    await syncInstall(500);

    expect(rememberWorkspace).toHaveBeenLastCalledWith(
      11,
      500,
      { owner: "acme", repos: ["widgets"] },
      null
    );
  });

  it("does not go looking when there is no repository yet", async () => {
    configCall.mockResolvedValue(
      installConfig({ connections: {}, needs_config: true })
    );

    await expect(syncInstall(500)).resolves.toBe(false);

    expect(installationForOwner).not.toHaveBeenCalled();
    // `needs_config` already says an admin has not finished; reporting
    // `invalid` as well would call an unfinished form a fault.
    expect(reportStatus).not.toHaveBeenCalled();
  });

  it("reports a finished form that still names nothing usable", async () => {
    // `owner/repo` typed into the owner box, which would otherwise build every
    // URL with an extra segment in it and 404 forever.
    configCall.mockResolvedValue(
      installConfig({ connections: { workspace: { owner: "acme/widgets" } } })
    );

    await expect(syncInstall(500)).resolves.toBe(false);

    expect(reportStatus).toHaveBeenCalledWith(500, {
      state: "invalid",
      detail: "no_repository",
    });
  });
});

describe("letting go of an installation's token", () => {
  /**
   * Answer the mint call, so there is something held to let go of.
   *
   * A fresh `Response` per call: a body reads once, and every case here counts
   * how many times GitHub was asked.
   */
  function githubMints(token: string) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            token,
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          }),
          { status: 200 }
        )
    );
  }

  it("mints once and reuses it until it is nearly spent", async () => {
    // An installation token lasts an hour. Minting one per request would be a
    // round trip to GitHub in front of every dashboard tile.
    const fetching = githubMints("ghs_first");
    try {
      await expect(installationToken(900)).resolves.toBe("ghs_first");
      await expect(installationToken(900)).resolves.toBe("ghs_first");
      expect(fetching).toHaveBeenCalledTimes(1);
    } finally {
      fetching.mockRestore();
      forgetInstallation(900);
    }
  });

  it("drops what it held when the install is removed", async () => {
    const fetching = githubMints("ghs_second");
    try {
      await installationToken(901);
      workspaceFor.mockResolvedValue({
        owner: "acme",
        repos: ["widgets"],
        installationId: 901,
      });

      await forgetInstall(11);

      // Held tokens outlive the row they were minted for by up to an hour, so
      // dropping the row is not on its own the end of access.
      expect(forgetWorkspace).toHaveBeenCalledWith(11);
      await installationToken(901);
      expect(fetching).toHaveBeenCalledTimes(2);
    } finally {
      fetching.mockRestore();
      forgetInstallation(901);
    }
  });

  it("sweeps what the platform's list no longer accounts for", async () => {
    // A guild that uninstalled while this app was down sends no signal, so
    // being absent from the list is the only thing that says so.
    const fetching = githubMints("ghs_third");
    try {
      await installationToken(902);
      installs.mockResolvedValue([]);
      knownInstallations.mockResolvedValue([]);

      await syncAllInstalls();

      await installationToken(902);
      expect(fetching).toHaveBeenCalledTimes(2);
    } finally {
      fetching.mockRestore();
      forgetInstallation(902);
    }
  });

  it("keeps one still in the list", async () => {
    const fetching = githubMints("ghs_fourth");
    try {
      await installationToken(903);
      installs.mockResolvedValue([]);
      knownInstallations.mockResolvedValue([903]);

      await syncAllInstalls();

      await expect(installationToken(903)).resolves.toBe("ghs_fourth");
      expect(fetching).toHaveBeenCalledTimes(1);
    } finally {
      fetching.mockRestore();
      forgetInstallation(903);
    }
  });

  it("drops one an install was switched off for", async () => {
    // Switched off is not uninstalled — the configuration is still the
    // guild's — but this app stops acting on it, which means it stops holding
    // anything it would act with.
    const fetching = githubMints("ghs_fifth");
    try {
      await installationToken(904);
      workspaceFor.mockResolvedValue({
        owner: "acme",
        repos: ["widgets"],
        installationId: 904,
      });
      installs.mockResolvedValue([{ install_id: 11, guild_id: 500, enabled: false }]);
      knownInstallations.mockResolvedValue([]);

      await syncAllInstalls();

      expect(configCall).not.toHaveBeenCalled();
      await installationToken(904);
      expect(fetching).toHaveBeenCalledTimes(2);
    } finally {
      fetching.mockRestore();
      forgetInstallation(904);
    }
  });
});
