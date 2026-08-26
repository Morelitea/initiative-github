/**
 * What the installation is for, and what the private key can do with it.
 *
 * The installation id is a *routing* fact here and nothing more. A delivery
 * arrives naming an installation, and this is what turns that back into the
 * guilds it belongs to — which is the whole of why the app looks it up.
 *
 * The claim underneath is the one worth testing: **the private key asks a
 * question and never acts on the answer.** It signs a JWT good for reading
 * which account installed the app, and this app mints nothing from it. Every
 * call that reaches a repository runs on the credential of the member who asked
 * for it. So the last case here is a grep, and it is the point of the file:
 * nothing in `src/` asks GitHub for an installation access token.
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
} = vi.hoisted(() => ({
  config: vi.fn(),
  installs: vi.fn(),
  reportStatus: vi.fn(async () => ({})),
  installationForOwner: vi.fn(async () => null as number | null),
  rememberWorkspace: vi.fn(async () => {}),
  workspaceFor: vi.fn(async () => null as unknown),
  forgetWorkspace: vi.fn(async () => {}),
  forgetInstallsExcept: vi.fn(async () => 0),
}));

vi.mock("../src/initiative.js", () => ({
  initiative: { config: configCall, installs, reportStatus },
}));

// The workspace half is Postgres-backed and has its own tests; this file is
// about what the sync decides, so its writes are stubbed out.
vi.mock("../src/workspace.js", () => ({
  rememberWorkspace,
  workspaceFor,
  forgetWorkspace,
  forgetInstallsExcept,
}));

// GitHub is stubbed at the one call that matters: "have you been installed on
// this repository?". Everything the sync decides hangs off its answer.
vi.mock("../src/github/app.js", async () => {
  const actual = await vi.importActual<typeof import("../src/github/app.js")>(
    "../src/github/app.js"
  );
  return { ...actual, installationForOwner };
});

import { forgetInstall, syncAllInstalls, syncInstall } from "../src/platform.js";

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

  it("says so when the form names an account and no repository", async () => {
    // An empty list is an unfinished form, and this app reads it as one — it is
    // never "every repository the account has". So the reason names the field
    // that is blank, and nothing goes looking for an installation to fill it.
    configCall.mockResolvedValue(
      installConfig({ connections: { workspace: { owner: "acme", repos: "" } } })
    );

    await expect(syncInstall(500)).resolves.toBe(false);

    expect(installationForOwner).not.toHaveBeenCalled();
    expect(reportStatus).toHaveBeenCalledWith(500, {
      state: "invalid",
      detail: "no_repository",
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

  it("asks again on every sync rather than trusting the last answer", async () => {
    // An organization can uninstall and reinstall, which is a different id
    // under the same name. Every delivery is routed by that id, so a stale one
    // is events silently ceasing to arrive.
    configCall.mockResolvedValue(installConfig());
    installationForOwner.mockResolvedValueOnce(4242).mockResolvedValueOnce(7)

    await syncInstall(500);
    await syncInstall(500);

    expect(installationForOwner).toHaveBeenCalledTimes(2);
    expect(rememberWorkspace).toHaveBeenLastCalledWith(
      11,
      500,
      { owner: "acme", repos: ["widgets"] },
      7
    );
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

describe("what the private key can do", () => {
  it("asks which account installed the app, and nothing else", async () => {
    // The two routes an app JWT is spent on here, and there is no third. Both
    // read; neither returns anything that can act.
    const fetching = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify({ id: 4242 }), { status: 200 })
    );
    try {
      const actual = await vi.importActual<typeof import("../src/github/app.js")>(
        "../src/github/app.js"
      );
      await expect(actual.installationForOwner("acme")).resolves.toBe(4242);

      const asked = fetching.mock.calls.map((call) => String(call[0]));
      expect(asked).toEqual([expect.stringContaining("/orgs/acme/installation")]);
    } finally {
      fetching.mockRestore();
    }
  });

  it("never asks GitHub for a token that acts as the installation", async () => {
    // The claim the whole permission model rests on, checked against the source
    // rather than against one path through it: a call this app cannot make is
    // stronger than one it happens not to make today.
    //
    // `POST /app/installations/{id}/access_tokens` is the only route that turns
    // the private key into something that can read and write inside every
    // repository an organization granted. Nothing here calls it, so a stolen
    // key yields the list of organizations and no way into one.
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");

    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts")) {
          if (readFileSync(path, "utf8").includes("access_tokens")) found.push(path);
        }
      }
    };
    walk("src");

    expect(found).toEqual([]);
  });
});
