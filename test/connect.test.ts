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

import { close, migrate, pool } from "../src/db.js";
import { beginOAuth, completeOAuth, credentialFor } from "../src/github/oauth.js";
import { manifest } from "../src/manifest.config.js";

const REF = "ref-abcdef";
const GUILD = 500;

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
async function started(guildId = GUILD) {
  const redirect = await beginOAuth(REF, guildId);
  return new URL(redirect).searchParams.get("state")!;
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
    const redirect = new URL(await beginOAuth(REF, GUILD));
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
    const redirect = new URL(await beginOAuth(REF, GUILD));
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
    await beginOAuth(REF, GUILD);
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

    const html = await completeOAuth(new URLSearchParams({ state, code: "gh-code" }));

    expect(html).toContain("Nearly there");
    expect(await credentialFor(REF)).not.toBeNull();
  });

  it("spends the state once", async () => {
    // A replayed callback finds nothing rather than racing a second exchange of
    // the same code.
    github();
    const state = await started();

    await completeOAuth(new URLSearchParams({ state, code: "gh-code" }));
    const second = await completeOAuth(new URLSearchParams({ state, code: "gh-code" }));

    expect(second).toContain("Could not connect");
    expect(writeConnection).toHaveBeenCalledTimes(1);
  });

  it("refuses a state it never minted", async () => {
    const fetching = github();
    const html = await completeOAuth(
      new URLSearchParams({ state: "not-one-of-ours", code: "gh-code" })
    );
    expect(html).toContain("Could not connect");
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
