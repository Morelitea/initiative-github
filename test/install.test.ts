/**
 * An organization installing this app, and what that is *not*.
 *
 * It is not a login. Nobody authorizes anything, no code is exchanged, no
 * credential is stored, and none of it touches the callback a member comes back
 * to. An owner grants the app access to an account on GitHub's own page, and
 * what comes back is an installation id — the one thing GitHub cannot tell us
 * on its own is which guild that installation belongs to, and the state this
 * app minted is what answers it.
 *
 * It is also not finished when GitHub hands it back. The `installation_id` on
 * that return is documented as untrustworthy — anybody can hit the route with
 * one, including an id belonging to an organization they have nothing to do
 * with — so it is taken as a claim, and the person is sent to authorize so the
 * claim can be checked against the installations GitHub says they hold. That
 * check is the only thing standing between a guild admin and another
 * organization's repositories, because the credential behind an installation
 * is minted from this app's key and would be minted just the same.
 *
 * Needs a database, because the handoff is the database.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Write { values: Record<string, unknown>; status?: string }

const { writeConnection } = vi.hoisted(() => ({
  writeConnection:
    vi.fn<(guildId: number, ref: string, write: Write) => Promise<unknown>>(
      async () => ({})
    ),
}));
vi.mock("../src/initiative.js", () => ({ initiative: { writeConnection } }));

import { close, migrate, pool } from "../src/db.js";
import {
  beginInstall,
  completeInstall,
  completeVerify,
} from "../src/github/install.js";

const REF = "ref-workspace";
const GUILD = 500;
const HOME = "https://initiative.test/apps/connected?app=morelitea.github";

const INSTALLATION = 4242;
const OWNER = "morelitea";

/**
 * GitHub naming this app, exchanging a code, and saying what this person holds.
 *
 * `held` is the whole of the check: the installations the authorizing user
 * actually has, which is what the claim off the setup URL is measured against.
 */
function github(held: number[] = [INSTALLATION]) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const at = String(url);
    if (at.endsWith("/app")) {
      return Response.json({ slug: "initiative-for-github", name: "Initiative" });
    }
    if (at.includes("access_token")) {
      return Response.json({ access_token: "ghu_installer", expires_in: 28_800 });
    }
    if (at.includes("/user/installations")) {
      return Response.json({
        installations: held.map((id) => ({ id, account: { login: OWNER } })),
      });
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  });
}

/** Start the trip the way the route does, and read back what GitHub gets. */
async function started(home: string | null = HOME) {
  const redirect = await beginInstall(REF, GUILD, home);
  // `null` is "GitHub would not name this app", which every caller here has
  // stubbed away — reaching it means the stub stopped answering.
  return new URL(redirect!);
}

/** The return GitHub sends to the setup URL, as it really arrives. */
function returned(overrides: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    installation_id: String(INSTALLATION),
    setup_action: "install",
    ...overrides,
  });
}

/**
 * The whole trip: install page, setup return, authorization, verify return.
 *
 * Run as one helper because the state that carries the claim is minted in the
 * middle of it — a test that skipped the setup hop would be verifying a claim
 * nobody made.
 */
async function wholeTrip(claim = INSTALLATION) {
  const start = await started();
  const setup = await completeInstall(
    returned({ state: start.searchParams.get("state")!, installation_id: String(claim) })
  );
  const authorize = new URL(setup.authorize!);
  return completeVerify(
    new URLSearchParams({ state: authorize.searchParams.get("state")!, code: "gh-code" })
  );
}

beforeEach(async () => {
  await migrate();
  await pool.query("TRUNCATE oauth_states, connections, workspaces");
  writeConnection.mockClear();
  writeConnection.mockResolvedValue({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await close();
});

describe("sending an admin to GitHub", () => {
  it("starts nothing when GitHub will not name this app", async () => {
    // First in the file, deliberately: the registration this app resolves is
    // cached for the process, so a test that needs it to fail cannot run after
    // one where it succeeded.
    //
    // The old answer here was to fall back to the authorization step. It
    // cannot be: that step ends by storing the credential of whoever completed
    // it, and this trip is not about a person at all.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ message: "Bad credentials" }, { status: 401 })
    );

    expect(await beginInstall(REF, GUILD, HOME)).toBeNull();
    expect((await pool.query("SELECT 1 FROM oauth_states")).rowCount).toBe(0);
  });

  it("sends them to the install page, carrying only a state", async () => {
    github();

    const redirect = await started();

    expect(redirect.origin + redirect.pathname).toBe(
      "https://github.com/apps/initiative-for-github/installations/new"
    );
    // GitHub preserves the `state` it documents on this page and drops what it
    // does not. Sending a challenge here would be sending it nowhere.
    expect([...redirect.searchParams.keys()]).toEqual(["state"]);
  });

  it("stores no verifier, because there is no challenge to answer", async () => {
    github();

    await started();

    const stored = await pool.query<{ code_verifier: string | null }>(
      "SELECT code_verifier FROM oauth_states"
    );
    expect(stored.rows[0].code_verifier).toBeNull();
  });

});

describe("when the install comes back", () => {
  it("settles nothing, and sends them to prove the claim", async () => {
    // The security of the whole flow is here. GitHub says not to rely on this
    // parameter, so nothing is written down on the strength of it — what comes
    // back is an authorization request, and the answer to it is the proof.
    github();
    const start = await started();

    const result = await completeInstall(
      returned({ state: start.searchParams.get("state")! })
    );

    expect(result.outcome).toBe("verifying");
    expect(writeConnection).not.toHaveBeenCalled();

    const authorize = new URL(result.authorize!);
    expect(authorize.origin + authorize.pathname).toBe(
      "https://github.com/login/oauth/authorize"
    );
    // A real authorization request this time, so a challenge does travel and
    // the code that comes back is bound to this server.
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("records the installation once GitHub agrees it is theirs", async () => {
    github();

    const result = await wholeTrip();

    expect(result.outcome).toBe("connected");
    expect(result.installedFor).toBe(GUILD);
    expect(writeConnection).toHaveBeenCalledWith(GUILD, REF, {
      values: { owner: OWNER, installation_id: INSTALLATION },
      status: "connected",
    });
  });

  it("stores no credential for the person who proved it", async () => {
    // Their token answered one question and was dropped. It is theirs, and
    // this connection is the guild's — filing it here would satisfy the wrong
    // connection with the wrong thing.
    github();

    await wholeTrip();

    expect((await pool.query("SELECT 1 FROM connections")).rowCount).toBe(0);
  });

  it("writes no repository list, because the installation is the list", async () => {
    github();

    await wholeTrip();

    const [, , write] = writeConnection.mock.calls[0];
    expect(Object.keys(write.values)).toEqual(["owner", "installation_id"]);
  });

  it("spends each state once", async () => {
    github();
    const start = await started();
    const setup = returned({ state: start.searchParams.get("state")! });

    await completeInstall(setup);
    const replayed = await completeInstall(setup);

    expect(replayed.outcome).toBe("elsewhere");
  });
});

describe("the claim somebody else's installation", () => {
  it("is refused when GitHub does not say they hold it", async () => {
    // The attack this whole hop exists for: a guild admin with a legitimate
    // state of their own, naming an installation belonging to an organization
    // they have nothing to do with. Believing it would hand their guild that
    // organization's repositories, because the credential behind an
    // installation is minted from this app's key either way.
    github([INSTALLATION]);

    const result = await wholeTrip(9999);

    expect(result.outcome).toBe("refused");
    expect(writeConnection).not.toHaveBeenCalled();
  });

  it("is refused rather than believed when GitHub would not answer at all", async () => {
    // Silence is not agreement. An unanswered check written down as a pass is
    // the same hole with a better excuse.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const at = String(url);
      if (at.endsWith("/app")) {
        return Response.json({ slug: "initiative-for-github", name: "Initiative" });
      }
      if (at.includes("access_token")) {
        return Response.json({ access_token: "ghu_installer", expires_in: 28_800 });
      }
      return Response.json({ message: "Server Error" }, { status: 500 });
    });

    const result = await wholeTrip();

    expect(result.outcome).toBe("not_recorded");
    expect(writeConnection).not.toHaveBeenCalled();
  });

  it("cannot be verified without a state this app minted", async () => {
    github();

    const result = await completeVerify(
      new URLSearchParams({ state: "invented", code: "gh-code" })
    );

    expect(result.outcome).toBe("expired");
    expect(writeConnection).not.toHaveBeenCalled();
  });
});

describe("the endings that are not failures", () => {
  it("says an owner has to approve, rather than reporting a refusal", async () => {
    // A member of an organization who cannot install apps is offered a request
    // instead, and comes back with `setup_action=request` and no installation.
    // Nothing is bound and nothing went wrong.
    github();
    const state = (await started()).searchParams.get("state")!;

    const result = await completeInstall(
      new URLSearchParams({ state, setup_action: "request" })
    );

    expect(result.outcome).toBe("requested");
    expect(writeConnection).not.toHaveBeenCalled();
  });

  it("has nothing to say about a trip it did not start", async () => {
    // No state, so this is a link somebody kept or an id somebody typed.
    github();

    const result = await completeInstall(returned());

    expect(result.outcome).toBe("elsewhere");
    expect(writeConnection).not.toHaveBeenCalled();
  });
});

describe("when it cannot be recorded", () => {
  it("does not claim an install Initiative refused to record", async () => {
    github();
    writeConnection.mockRejectedValueOnce(new Error("channel down"));

    const result = await wholeTrip();

    expect(result.outcome).toBe("not_recorded");
    expect(result.installedFor).toBeUndefined();
  });
});
