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

interface Write { values: Record<string, unknown>; status?: string }

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
import { rememberWorkspace } from "../src/workspace.js";
import {
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

/** Start a flow the way the route does, and read back the state GitHub gets. */
async function started(guildId = GUILD, home: string | null = HOME) {
  const redirect = await beginOAuth(REF, guildId, home);
  return new URL(redirect).searchParams.get("state")!;
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
       (connection_ref, guild_id, access_token, refresh_token, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' seconds')::interval)`,
    [REF, GUILD, seal("ghu_held"), seal("ghr_held"), String(expiresInSeconds)]
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
  await pool.query("TRUNCATE connections, oauth_states, workspaces");
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

    // Sealed: a stray SELECT is not a GitHub token.
    const row = await pool.query<{ access_token: string }>(
      "SELECT access_token FROM connections"
    );
    expect(row.rows[0].access_token).not.toContain("ghu_member");
  });

  it("does not ask GitHub who they are, because nothing needs to know", async () => {
    // Their account is theirs. The token is what every call is made with and
    // the handle is what it is filed under, so the login was a fact this app
    // fetched, wrote into Initiative in plaintext, and read back never.
    const fetching = github();
    const state = await started();

    await completeOAuth(new URLSearchParams({ state, code: "gh-code" }));

    const asked = fetching.mock.calls.map((made) => String(made[0]));
    expect(asked.some((url) => url.endsWith("/user"))).toBe(false);
  });

  it("tells Initiative, which is what makes the connection usable", async () => {
    // The bug this file exists for. Everything above passed while this did not
    // happen, and the result was every tile telling every member to connect.
    github();
    const state = await started();

    await completeOAuth(new URLSearchParams({ state, code: "gh-code" }));

    // A yes, and nothing about who. Satisfaction is presence, so this is the
    // smallest thing that can cross — and Initiative's own logins are what its
    // side is for.
    expect(writeConnection).toHaveBeenCalledWith(GUILD, REF, {
      values: { authorized: true },
      status: "connected",
    });
  });

  it("tells Initiative nothing about the person behind it", async () => {
    github();
    const state = await started();

    await completeOAuth(new URLSearchParams({ state, code: "gh-code" }));

    // Asserted against the whole payload rather than the one field somebody
    // remembered to leave out.
    const written = JSON.stringify(writeConnection.mock.calls[0][2]);
    expect(written).not.toContain("alice");
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

  it("connects on the exchange alone, with nothing else to go wrong", async () => {
    // There used to be a second call here — GitHub asked whose token this is,
    // producing the field the connection was satisfied by — and a whole ending
    // for it failing. Nothing needs that answer, so neither the call nor the
    // ending it could produce exists any more.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("access_token")) {
        return Response.json({ access_token: "ghu_member", expires_in: 28_800 });
      }
      throw new TypeError("fetch failed");
    });
    const state = await started();

    const result = await completeOAuth(new URLSearchParams({ state, code: "gh-code" }));

    expect(result.outcome).toBe("connected");
    expect((await credentialFor(REF))?.accessToken).toBe("ghu_member");
  });
});

describe("a credential that no longer reaches anything", () => {
  /**
   * A user access token is an intersection: it reaches what the app was
   * granted *and* what the person can see. Somebody who leaves the
   * organization keeps a token that is still valid and reaches none of it, and
   * GitHub answers their reads with less rather than refusing — so nothing
   * notices unless this app asks.
   *
   * Asked on renewal, which is periodic without being per-read.
   */
  const renewing = (holds: number[], ok = true) =>
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const at = String(url);
      if (at.includes("access_token")) {
        return Response.json({ access_token: "ghu_renewed", expires_in: 28_800 });
      }
      if (at.includes("/user/installations")) {
        return ok
          ? Response.json({ installations: holds.map((id) => ({ id })) })
          : Response.json({ message: "Server Error" }, { status: 500 });
      }
      return Response.json({});
    });

  const bind = () => rememberWorkspace(11, GUILD, "acme", 4242, ["widgets"]);

  it("is dropped when GitHub says they no longer hold the installation", async () => {
    await bind();
    await holding(30);
    renewing([9999]);

    expect(await credentialFor(REF)).toBeNull();
    expect((await pool.query("SELECT 1 FROM connections")).rowCount).toBe(0);
    // And Initiative is told, so the member is asked to connect rather than
    // left with a connection that reads as working.
    expect(writeConnection).toHaveBeenCalledWith(GUILD, REF, {
      values: { authorized: null },
      status: "pending",
    });
  });

  it("is kept when they still hold it", async () => {
    await bind();
    await holding(30);
    renewing([4242]);

    expect((await credentialFor(REF))?.accessToken).toBe("ghu_renewed");
  });

  it("is kept when GitHub would not say", async () => {
    // Silence is not a departure. Dropping on a bad minute would ask somebody
    // to connect again to fix nothing.
    await bind();
    await holding(30);
    renewing([], false);

    expect((await credentialFor(REF))?.accessToken).toBe("ghu_renewed");
  });

  it("is kept when the guild is bound to no installation", async () => {
    // Nothing to have lost access to, and no call made to find out.
    await holding(30);
    const fetching = renewing([]);

    expect((await credentialFor(REF))?.accessToken).toBe("ghu_renewed");
    expect(
      fetching.mock.calls.some((made) => String(made[0]).includes("/user/installations"))
    ).toBe(false);
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
      values: { authorized: null },
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
