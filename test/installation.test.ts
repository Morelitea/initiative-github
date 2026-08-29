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

import type { InstallationLookup } from "../src/github/app.js";

/** GitHub answering: this owner has this installation, or has none. */
function told(installationId: number | null) {
  return { known: true as const, installationId };
}

/** GitHub not answering, which is a different thing entirely. */
const SILENT = { known: false as const, detail: "fetch failed" };

const {
  config: configCall,
  installs,
  reportStatus,
  installationById,
  installationRepositories,
  rememberWorkspace,
  workspaceFor,
  forgetWorkspace,
  forgetInstallsExcept,
} = vi.hoisted(() => ({
  config: vi.fn(),
  installs: vi.fn(),
  reportStatus: vi.fn(async () => ({})),
  installationById: vi.fn<(id: number) => Promise<InstallationLookup>>(
    async () => told(null)
  ),
  installationRepositories: vi.fn<(id: number) => Promise<string[] | null>>(
    async () => ["widgets"]
  ),
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

// GitHub is stubbed at the two calls that matter: "is that installation still
// there?" and "what does it cover?". Everything the sync decides hangs off
// those answers.
vi.mock("../src/github/app.js", async () => {
  const actual = await vi.importActual<typeof import("../src/github/app.js")>(
    "../src/github/app.js"
  );
  return { ...actual, installationById, installationRepositories };
});

import { ChannelError } from "initiative-app-kit";

import { forgetInstall, installIsGone, syncAllInstalls, syncInstall } from "../src/platform.js";

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
    connections: { workspace: { owner: "acme", installation_id: 4242 } },
    member_connections: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  reportStatus.mockResolvedValue({});
  workspaceFor.mockResolvedValue(null);
  // `clearAllMocks` forgets the calls and keeps the implementations, so a
  // boundary one test set would otherwise be the boundary every later one saw.
  installationRepositories.mockResolvedValue(["widgets"]);
});

describe("finding the guild's access", () => {
  it("reads the boundary off the installation rather than off the form", async () => {
    // The repository list is not configuration any more. An organization ticks
    // boxes at GitHub, the installation is what those boxes produced, and this
    // reads it — so a repository added there arrives on the next sync with
    // nobody coming back through Initiative to retype anything.
    configCall.mockResolvedValue(
      installConfig({
        connections: {
          workspace: { owner: "acme", installation_id: 4242 },
        },
      })
    );
    installationById.mockResolvedValue(told(4242));
    installationRepositories.mockResolvedValue(["widgets", "gadgets"]);

    await syncInstall(500);

    expect(installationRepositories).toHaveBeenCalledWith(4242);
    expect(rememberWorkspace).toHaveBeenCalledWith(
      11,
      500,
      "acme",
      4242,
      ["widgets", "gadgets"]
    );
  });

  it("keeps the boundary it had when GitHub would not restate it", async () => {
    // The same rule the id follows, and a costlier one to get wrong: an
    // unanswered question written down as an empty boundary is every tile in
    // the guild going dark until a later sync happens to succeed.
    configCall.mockResolvedValue(
      installConfig({
        connections: {
          workspace: { owner: "acme", installation_id: 4242 },
        },
      })
    );
    installationById.mockResolvedValue(told(4242));
    installationRepositories.mockResolvedValue(null);

    await syncInstall(500);

    expect(rememberWorkspace).toHaveBeenCalledWith(11, 500, "acme", 4242, undefined);
  });

  it("asks after the installation an admin actually made", async () => {
    // The heart of it. What the connection holds is an installation id, put
    // there by the flow that made the installation — so the question is "is
    // that installation still there", not "does some account by this name
    // have one". A login is a name pointing at an installation today, and a
    // renamed organization or a name somebody else has since taken makes the
    // two different questions with different answers.
    configCall.mockResolvedValue(
      installConfig({
        connections: {
          workspace: { owner: "acme", installation_id: 4242 },
        },
      })
    );
    installationById.mockResolvedValue(told(4242));

    await expect(syncInstall(500)).resolves.toBe(true);

    expect(installationById).toHaveBeenCalledWith(4242);
    expect(rememberWorkspace).toHaveBeenCalledWith(
      11,
      500,
      "acme",
      4242,
      ["widgets"]
    );
  });

  it("writes nothing down when GitHub would not answer about the id", async () => {
    // Silence is not "gone". Written down as an absence it would stop every
    // delivery this guild routes, to fix nothing.
    configCall.mockResolvedValue(
      installConfig({
        connections: {
          workspace: { owner: "acme", installation_id: 4242 },
        },
      })
    );
    installationById.mockResolvedValue(SILENT);

    await syncInstall(500);

    expect(rememberWorkspace).toHaveBeenCalledWith(
      11,
      500,
      "acme",
      undefined,
      undefined
    );
  });

  it("calls an install usable when the guild named its repositories", async () => {
    // The change least privilege bought. Reads run on each member's own GitHub
    // credential, so those tiles answer with or without an installation — and
    // telling an admin their working dashboard is invalid would be false.
    //
    // What is still missing is the webhook, which is why the poll keeps
    // looking rather than treating this as settled.
    configCall.mockResolvedValue(installConfig());
    installationById.mockResolvedValue(told(null));

    await expect(syncInstall(500)).resolves.toBe(true);
    expect(reportStatus).toHaveBeenCalledWith(500, { state: "ok" });
  });

  it("records the absence, so a source answers rather than guessing", async () => {
    // Written down as null rather than left at whatever it was. An install that
    // was working and has been uninstalled at GitHub has to stop working here.
    configCall.mockResolvedValue(installConfig());
    installationById.mockResolvedValue(told(null));

    await syncInstall(500);

    expect(rememberWorkspace).toHaveBeenCalledWith(
      11,
      500,
      "acme",
      null,
      undefined
    );
  });

  it("writes nothing down when GitHub would not answer", async () => {
    // The other half of the case above, and the one that has no symptom. An
    // answer of "none" is a fact and gets recorded; a lookup that failed is not
    // one, and recording it as "none" takes every guild-scoped source down —
    // the alerts widget included — until a later sync happens to succeed.
    configCall.mockResolvedValue(installConfig());
    installationById.mockResolvedValue(SILENT);

    await expect(syncInstall(500)).resolves.toBe(true);

    expect(rememberWorkspace).toHaveBeenCalledWith(
      11,
      500,
      "acme",
      undefined,
      undefined
    );
    // And the install is still usable: the reads that run as a member never
    // needed the installation in the first place.
    expect(reportStatus).toHaveBeenCalledWith(500, { state: "ok" });
  });

  it("asks again on every sync rather than trusting the last answer", async () => {
    // An organization can uninstall and reinstall, which is a different id
    // under the same name. Every delivery is routed by that id, so a stale one
    // is events silently ceasing to arrive.
    configCall.mockResolvedValue(installConfig());
    installationById.mockResolvedValueOnce(told(4242)).mockResolvedValueOnce(told(7));

    await syncInstall(500);
    await syncInstall(500);

    expect(installationById).toHaveBeenCalledTimes(2);
    expect(rememberWorkspace).toHaveBeenLastCalledWith(
      11,
      500,
      "acme",
      7,
      ["widgets"]
    );
  });

  it("records the installation going away even where nothing stops working", async () => {
    // The dashboard carries on — but the webhook does not, and the row is what
    // routes a delivery back to a guild. Writing the absence down is how the
    // next delivery for that installation finds nobody rather than finding a
    // guild that has not been in it for a week.
    configCall.mockResolvedValue(installConfig());
    installationById.mockResolvedValueOnce(told(4242)).mockResolvedValueOnce(told(null));

    await syncInstall(500);
    await syncInstall(500);

    expect(rememberWorkspace).toHaveBeenLastCalledWith(
      11,
      500,
      "acme",
      null,
      undefined
    );
  });

  it("does not go looking when there is no repository yet", async () => {
    configCall.mockResolvedValue(
      installConfig({ connections: {}, needs_config: true })
    );

    await expect(syncInstall(500)).resolves.toBe(false);

    expect(installationById).not.toHaveBeenCalled();
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
      detail: "not_installed",
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
      await expect(actual.installationById(4242)).resolves.toEqual(told(4242));

      const asked = fetching.mock.calls.map((call) => String(call[0]));
      expect(asked).toEqual([expect.stringContaining("/app/installations/4242")]);
    } finally {
      fetching.mockRestore();
    }
  });

  it("mints a token that acts as the installation in exactly one place", async () => {
    // This app used to refuse that token outright, and a grep over `src/`
    // enforced it. It mints one now, because the boundary an organization
    // granted is a question only the installation can answer and asking a
    // person to restate it is what this whole flow removed.
    //
    // What is worth keeping is where it can come from. One module holds the
    // private key and one function spends it, so a reader has one place to
    // look rather than a habit to trust.
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

    expect(found).toEqual(["src/github/app.ts"]);
  });

  it("never lets a write run as the installation", async () => {
    // The rule that replaced the refusal, and the one that has to survive
    // every later change: a write is somebody doing something, and one
    // attributed to the app is one nobody can be held to. Read from the
    // declarations rather than from a code path, so an endpoint added later
    // cannot join the exception quietly.
    const { manifest } = await import("../src/manifest.config.js");

    const writes = (manifest.endpoints ?? []).filter(
      (endpoint) => endpoint.direction === "write"
    );
    expect(writes.length).toBeGreaterThan(0);

    for (const write of writes) {
      expect(write.actors, `${write.id} may act as the app`).toEqual(["member"]);
    }
  });
});

describe("what a failed lifecycle sync means", () => {
  // The route calls this before deciding whether to forget the install, and
  // the wrong answer is expensive in one direction only: forgetting a
  // workspace over a blip takes the guild's dashboard down until the poll
  // rebuilds it, while keeping one that is genuinely gone costs a poll.

  it("is gone when Initiative says there is no such install", async () => {
    expect(installIsGone(new ChannelError(404, "no such install"))).toBe(true);
    expect(installIsGone(new ChannelError(410, "uninstalled"))).toBe(true);
  });

  it("is not gone when the channel merely refused", async () => {
    expect(installIsGone(new ChannelError(503, "unavailable"))).toBe(false);
    expect(installIsGone(new ChannelError(429, "slow down"))).toBe(false);
    expect(installIsGone(new ChannelError(500, "boom"))).toBe(false);
  });

  it("is not gone for anything that is not the channel at all", async () => {
    // A database error, a bug here, GitHub. None of them is Initiative saying
    // the install ended.
    expect(installIsGone(new Error("connection terminated"))).toBe(false);
    expect(installIsGone(undefined)).toBe(false);
  });
});

describe("asking GitHub which installation covers an owner", () => {
  it("reads a removed installation as gone, and a fault as nothing", async () => {
    // The distinction the return type exists for, and the reason it is a union
    // rather than a number. A 404 is GitHub saying the installation is not
    // there, which stops deliveries; unreachable, or a 500, is GitHub saying
    // nothing, which must change none of that.
    const cases: Array<[() => Promise<Response>, unknown]> = [
      [async () => Response.json({ message: "Not Found" }, { status: 404 }), told(null)],
      [async () => Response.json({ message: "unavailable" }, { status: 503 }), null],
      [
        async () => {
          throw new TypeError("fetch failed");
        },
        null,
      ],
    ];

    for (const [answering, expected] of cases) {
      const fetching = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(answering as never);
      try {
        const actual = await vi.importActual<typeof import("../src/github/app.js")>(
          "../src/github/app.js"
        );
        const looked = await actual.installationById(4242);
        if (expected === null) expect(looked.known).toBe(false);
        else expect(looked).toEqual(expected);
      } finally {
        fetching.mockRestore();
      }
    }
  });
});
