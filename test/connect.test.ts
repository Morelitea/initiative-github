/**
 * A member connecting their GitHub account, and the half that was missing.
 *
 * The app stored the credential correctly and told Initiative nothing, which is
 * a failure with no symptom on this side: the token is real, the widget works
 * when you call the endpoint directly, and every member is told to connect
 * forever. It shipped because the flow had no test that looked at both ends.
 *
 * The platform decides whether a per-member connection is satisfied from what
 * is stored against it — not from anything the app knows — and a connection
 * declaring no fields can never be satisfied at all. So what these check is not
 * "did we get a token" but "did we say so, and with something that counts".
 *
 * Needs a database, because the flow is the database. `DATABASE_URL` in CI; see
 * README.md to run it locally.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Write { values: Record<string, unknown>; status?: string; account_label?: string }

const { writeConnection } = vi.hoisted(() => ({
  // Typed, so reading an argument back below is checked rather than asserted.
  writeConnection:
    vi.fn<(guildId: number, ref: string, write: Write) => Promise<unknown>>(
      async () => ({})
    ),
}));
vi.mock("../src/initiative.js", () => ({ initiative: { writeConnection } }));

import { signReturnUrl } from "initiative-app-kit";

import { config } from "../src/config.js";
import { close, migrate, pool, seal } from "../src/db.js";
import {
  beginInstall,
  beginOAuth,
  completeOAuth,
  credentialFor,
  landingFor,
} from "../src/github/oauth.js";
import { manifest } from "../src/manifest.config.js";

const REF = "ref-abcdef";
const GUILD = 500;
const HOME = "https://initiative.test/apps/connected?app=morelitea.github";

/** GitHub answering the token exchange and the `/user` lookup that follows. */
function github(token = "ghu_member") {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (String(url).includes("access_token")) {
      return Response.json({
        access_token: token,
        expires_in: 28_800,
        refresh_token: "ghr_member",
        refresh_token_expires_in: 15_811_200,
      });
    }
    return Response.json({ login: "alice" });
  });
}

/** GitHub naming the registration, and then answering as above. */
function githubWithApp(token = "ghu_member") {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (String(url).endsWith("/app")) {
      return Response.json({ slug: "initiative-for-github", name: "Initiative" });
    }
    if (String(url).includes("access_token")) {
      return Response.json({ access_token: token, expires_in: 28_800 });
    }
    return Response.json({ login: "alice" });
  });
}

/** Start a flow the way the route does, and read back the state GitHub gets. */
async function started(guildId = GUILD, home: string | null = HOME) {
  const redirect = await beginOAuth(REF, guildId, home);
  return new URL(redirect).searchParams.get("state")!;
}

/** The same, through the install page rather than the authorize page. */
async function installStarted(home: string | null = HOME) {
  return new URL(await beginInstall(REF, GUILD, home));
}

/** The form the exchange put on the wire. */
function exchanged(fetching: ReturnType<typeof github>): URLSearchParams {
  const call = fetching.mock.calls.find((made) =>
    String(made[0]).includes("access_token")
  )!;
  return new URLSearchParams(String(call[1]?.body ?? ""));
}

/** A connection already held, with an access token this near to lapsing. */
async function holding(expiresInSeconds: number) {
  await pool.query(
    `INSERT INTO connections
       (connection_ref, guild_id, access_token, refresh_token, expires_at, account_label)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' seconds')::interval, $6)`,
    [REF, GUILD, seal("ghu_held"), seal("ghr_held"), String(expiresInSeconds), "@alice"]
  );
}

/** A connect URL as Initiative builds it, signed with the shared secret. */
function handoff(home = HOME): URLSearchParams {
  return new URLSearchParams({
    connection_ref: REF,
    guild_id: String(GUILD),
    return_url: home,
    return_sig: signReturnUrl(config.appSecret, home),
  });
}

beforeEach(async () => {
  await migrate();
  await pool.query("TRUNCATE connections, oauth_states");
  writeConnection.mockClear();
  writeConnection.mockResolvedValue({});
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await close();
});

describe("sending a member to GitHub", () => {
  it("sends them to GitHub's own authorization page", async () => {
    const redirect = new URL(await beginOAuth(REF, GUILD, HOME));
    expect(redirect.origin + redirect.pathname).toBe(
      "https://github.com/login/oauth/authorize"
    );
    expect(redirect.searchParams.get("client_id")).toBeTruthy();
    expect(redirect.searchParams.get("code_challenge_method")).toBe("S256");
    // No scope: a GitHub App's user token carries the installation's
    // permissions, so there is nothing to ask for here.
    expect(redirect.searchParams.has("scope")).toBe(false);
  });

  it("keeps the verifier on this side and sends only its hash", async () => {
    const redirect = new URL(await beginOAuth(REF, GUILD, HOME));
    const stored = await pool.query<{ code_verifier: string }>(
      "SELECT code_verifier FROM oauth_states"
    );
    const verifier = stored.rows[0].code_verifier;
    expect(verifier).toBeTruthy();
    expect(redirect.searchParams.get("code_challenge")).not.toBe(verifier);
    expect(new URL(redirect).search).not.toContain(verifier);
  });

  it("binds the guild to the flow rather than to the callback", async () => {
    // GitHub controls the callback's query string and echoes only `state`, so a
    // guild read back there would be one the redirect supplied. This is the
    // moment Initiative hands the member over, and the only honest place to
    // take it.
    await beginOAuth(REF, GUILD, HOME);
    const stored = await pool.query<{ guild_id: string }>(
      "SELECT guild_id FROM oauth_states"
    );
    expect(Number(stored.rows[0].guild_id)).toBe(GUILD);
  });
});

describe("when they come back", () => {
  it("stores the credential sealed, under the handle the platform minted", async () => {
    github();
    const state = await started();

    await completeOAuth(new URLSearchParams({ state, code: "gh-code" }));

    const held = await credentialFor(REF);
    expect(held?.accessToken).toBe("ghu_member");
    expect(held?.accountLabel).toBe("@alice");

    // Sealed: a stray SELECT is not a GitHub token.
    const row = await pool.query<{ access_token: string }>(
      "SELECT access_token FROM connections"
    );
    expect(row.rows[0].access_token).not.toContain("ghu_member");
  });

  it("tells Initiative, which is what makes the connection usable", async () => {
    // The bug this file exists for. Everything above passed while this did not
    // happen, and the result was every tile telling every member to connect.
    github();
    const state = await started();

    await completeOAuth(new URLSearchParams({ state, code: "gh-code" }));

    expect(writeConnection).toHaveBeenCalledWith(GUILD, REF, {
      values: { account_login: "alice" },
      status: "connected",
      account_label: "@alice",
    });
  });

  it("writes a value the platform can actually count", async () => {
    // A connection is satisfied by what is stored against it, and only fields
    // the manifest declares are stored at all. Writing a key the manifest does
    // not name would be accepted here and dropped there.
    github();
    const state = await started();
    await completeOAuth(new URLSearchParams({ state, code: "gh-code" }));

    const declared = (manifest.connections ?? [])
      .find((connection) => connection.id === "account")!
      .fields.map((field) => field.key);
    const written = Object.keys(writeConnection.mock.calls[0][2].values);

    expect(written.length).toBeGreaterThan(0);
    for (const key of written) expect(declared).toContain(key);
  });

  it("says so when Initiative did not record it, rather than claiming success", async () => {
    // The token is real and held; the member simply is not connected as far as
    // anything that matters is concerned. Telling them "Connected" would send
    // them back to a dashboard that refuses them with no way to understand why.
    github();
    writeConnection.mockRejectedValue(new Error("platform unreachable"));
    const state = await started();

    const result = await completeOAuth(new URLSearchParams({ state, code: "gh-code" }));

    expect(result.outcome).toBe("not_recorded");
    expect(await credentialFor(REF)).not.toBeNull();
  });

  it("spends the state once", async () => {
    // A replayed callback finds nothing rather than racing a second exchange of
    // the same code.
    github();
    const state = await started();

    await completeOAuth(new URLSearchParams({ state, code: "gh-code" }));
    const second = await completeOAuth(new URLSearchParams({ state, code: "gh-code" }));

    expect(second.outcome).toBe("expired");
    expect(writeConnection).toHaveBeenCalledTimes(1);
  });

  it("refuses a state it never minted", async () => {
    const fetching = github();
    const result = await completeOAuth(
      new URLSearchParams({ state: "not-one-of-ours", code: "gh-code" })
    );
    expect(result.outcome).toBe("expired");
    // And nowhere to send them: the address was in the row, and there is no
    // row. So this is one of the two endings the app draws itself.
    expect(landingFor(result)).toBeNull();
    expect(fetching).not.toHaveBeenCalled();
    expect(writeConnection).not.toHaveBeenCalled();
  });

  it("remembers which guild the credential belongs to", async () => {
    // So a credential that later lapses can be reported. Without it this app
    // forgets the token and Initiative goes on showing the member as connected.
    github();
    const state = await started();
    await completeOAuth(new URLSearchParams({ state, code: "gh-code" }));

    const row = await pool.query<{ guild_id: string }>(
      "SELECT guild_id FROM connections"
    );
    expect(Number(row.rows[0].guild_id)).toBe(GUILD);
  });
});

describe("where they land when it is over", () => {
  it("goes back to Initiative with one word saying how it went", async () => {
    // The whole point. This app knows a handle and a guild id and has never
    // been told what language this person reads — so it does not write the
    // ending, it hands them back and Initiative writes it.
    github();
    const state = await started();

    const landing = new URL(
      landingFor(await completeOAuth(new URLSearchParams({ state, code: "gh-code" })))!
    );

    expect(landing.origin + landing.pathname).toBe(
      "https://initiative.test/apps/connected"
    );
    expect(landing.searchParams.get("outcome")).toBe("connected");
    // And what Initiative put on its own address survives the trip, so the page
    // can say which app was being connected.
    expect(landing.searchParams.get("app")).toBe("morelitea.github");
  });

  it("says they declined when GitHub sends them back with no code", async () => {
    // Their answer at the vendor, not a fault here — and a different remedy
    // from an expired link, which is why it is a different word.
    const state = await started();

    const result = await completeOAuth(new URLSearchParams({ state }));

    expect(result.outcome).toBe("refused");
    expect(landingFor(result)).toContain("outcome=refused");
    expect(await credentialFor(REF)).toBeNull();
  });

  it("carries the outcome even when Initiative did not record the connection", async () => {
    github();
    writeConnection.mockRejectedValue(new Error("platform unreachable"));
    const state = await started();

    const landing = landingFor(
      await completeOAuth(new URLSearchParams({ state, code: "gh-code" }))
    );

    expect(landing).toContain("outcome=not_recorded");
  });

  it("has nowhere to send somebody Initiative did not send", async () => {
    // A flow begun without a return address — a connect URL assembled by hand.
    // It still works; the ending is just this app's own page.
    github();
    const state = await started(GUILD, null);

    const result = await completeOAuth(new URLSearchParams({ state, code: "gh-code" }));

    expect(result.outcome).toBe("connected");
    expect(landingFor(result)).toBeNull();
  });
});

describe("the address Initiative signed", () => {
  it("is what gets stored, and only if it verifies", async () => {
    // The route reads this off the query string before the flow begins, so an
    // address somebody typed never reaches the row that the redirect is built
    // from at the end.
    const { returnAddress } = await import("initiative-app-kit");

    const real = handoff();
    expect(returnAddress({ secret: config.appSecret, params: real })).toBe(HOME);

    const forged = handoff();
    forged.set("return_url", "https://evil.test/looks-official");
    expect(returnAddress({ secret: config.appSecret, params: forged })).toBeNull();
  });
});

describe("a verifier is only sent for a challenge that travelled", () => {
  // PKCE is real on GitHub's authorize step, and the install page is not that
  // step: it preserves `state` and starts the authorization itself, with its
  // own parameters. A challenge put on it is dropped, and a verifier stored
  // against that would be sent at exchange time for a binding GitHub never
  // recorded — which is at best ignored and at worst refused, on a path
  // nothing here would be able to tell apart from a member declining.

  it("still carries a challenge when there is no install page to use", async () => {
    // First, deliberately: `appIdentity` caches the registration it resolves,
    // and a test that has to fail to resolve one cannot run after a test that
    // succeeded. With none, this falls back to the authorize step — which does
    // record a challenge.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ message: "Bad credentials" }, { status: 401 })
    );

    const redirect = await installStarted();

    expect(redirect.pathname).toBe("/login/oauth/authorize");
    expect(redirect.searchParams.get("code_challenge_method")).toBe("S256");
    const stored = await pool.query<{ code_verifier: string | null }>(
      "SELECT code_verifier FROM oauth_states"
    );
    expect(stored.rows[0].code_verifier).toBeTruthy();
  });

  it("binds the member's own flow, and says so on the wire", async () => {
    const fetching = github();
    const state = await started();

    await completeOAuth(new URLSearchParams({ state, code: "gh-code" }));

    const stored = await pool.query("SELECT code_verifier FROM oauth_states");
    expect(stored.rowCount).toBe(0);
    expect(exchanged(fetching).get("code_verifier")).toBeTruthy();
  });

  it("sends the install page only the state it keeps", async () => {
    githubWithApp();

    const redirect = await installStarted();

    expect(redirect.pathname).toBe("/apps/initiative-for-github/installations/new");
    expect([...redirect.searchParams.keys()]).toEqual(["state"]);
  });

  it("stores no verifier for a flow that sent no challenge", async () => {
    githubWithApp();

    await installStarted();

    const stored = await pool.query<{ code_verifier: string | null }>(
      "SELECT code_verifier FROM oauth_states"
    );
    expect(stored.rows[0].code_verifier).toBeNull();
  });

  it("claims nothing at exchange time that GitHub did not record", async () => {
    const fetching = githubWithApp();
    const state = (await installStarted()).searchParams.get("state")!;

    const result = await completeOAuth(new URLSearchParams({ state, code: "gh-code" }));

    expect(result.outcome).toBe("connected");
    expect(exchanged(fetching).has("code_verifier")).toBe(false);
  });

});

describe("when GitHub does not answer", () => {
  // The app has a page written for a flow that did not complete, and an
  // unguarded `fetch` routes around it: the exception reaches the server's last
  // resort and the member gets `{"error":"internal error"}` in a browser tab.

  it("ends on the page for it rather than in a 500", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    const state = await started();

    const result = await completeOAuth(new URLSearchParams({ state, code: "gh-code" }));

    expect(result.outcome).toBe("refused");
    expect(landingFor(result)).toContain("outcome=refused");
    expect(await credentialFor(REF)).toBeNull();
  });

  it("does the same for a refusal that arrives as a 200", async () => {
    // GitHub answers a spent code with `{"error": ...}` and a success status.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ error: "bad_verification_code" })
    );
    const state = await started();

    const result = await completeOAuth(new URLSearchParams({ state, code: "gh-code" }));

    expect(result.outcome).toBe("refused");
    expect(await credentialFor(REF)).toBeNull();
  });

  it("does the same for a proxy's HTML where the tokens should be", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response("<html>502 Bad Gateway</html>", { status: 200 })
    );
    const state = await started();

    const result = await completeOAuth(new URLSearchParams({ state, code: "gh-code" }));

    expect(result.outcome).toBe("refused");
  });

  it("keeps a credential it cannot put a name to, and says so", async () => {
    // The token is real; the lookup that says whose it is did not answer, and
    // that lookup produces the only field the connection is satisfied by. So
    // this is the ending that means "held here, not recorded there" — the same
    // one a failed write gets, and the same remedy.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("access_token")) {
        return Response.json({ access_token: "ghu_member", expires_in: 28_800 });
      }
      throw new TypeError("fetch failed");
    });
    const state = await started();

    const result = await completeOAuth(new URLSearchParams({ state, code: "gh-code" }));

    expect(result.outcome).toBe("not_recorded");
    expect((await credentialFor(REF))?.accessToken).toBe("ghu_member");
  });
});

describe("renewing a credential that is nearly out", () => {
  it("drops it when GitHub says the grant is finished", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ error: "bad_refresh_token" })
    );
    await holding(-60);

    expect(await credentialFor(REF)).toBeNull();

    const left = await pool.query("SELECT 1 FROM connections");
    expect(left.rowCount).toBe(0);
    // And Initiative is told, so the member is asked to connect rather than
    // shown a tile that fails.
    expect(writeConnection).toHaveBeenCalledWith(GUILD, REF, {
      values: { account_login: null },
      status: "pending",
    });
  });

  it("keeps it when GitHub simply could not be reached", async () => {
    // The opposite remedy, and the reason the two are told apart at all. An
    // outage is not a revocation: dropping the row here would disconnect every
    // member whose token happened to be inside the refresh skew, and tell
    // Initiative to ask all of them to connect again.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    await holding(60);

    const held = await credentialFor(REF);

    expect(held?.accessToken).toBe("ghu_held");
    const left = await pool.query("SELECT 1 FROM connections");
    expect(left.rowCount).toBe(1);
    expect(writeConnection).not.toHaveBeenCalled();
  });

  it("does not treat GitHub being down as a revocation either", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ message: "unavailable" }, { status: 503 })
    );
    await holding(-60);

    expect(await credentialFor(REF)).not.toBeNull();
    const left = await pool.query("SELECT 1 FROM connections");
    expect(left.rowCount).toBe(1);
  });
});
