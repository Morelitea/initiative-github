/**
 * Registering the GitHub App in one click, and the gate in front of it.
 *
 * This flow creates a GitHub App and shows its four secrets. That is a useful
 * thing to be able to do once and a dangerous thing to be able to do twice: a
 * stranger who reached it could register an app they control and hand the
 * operator credentials for it, and the deployment would then be somebody else's
 * integration wearing this one's name.
 *
 * So what is tested here is mostly the gate. The token guards the first route.
 * The second route cannot be guarded the same way — GitHub redirects to it with
 * a code and a state and no token — so the state has to carry the authority
 * itself, and that is what the bulk of this file is about.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted, because `import` is. Configuration is read at module load, so a
// plain assignment here would run after `config.ts` had already decided this
// deployment has no setup token — which is the state the second case below
// deliberately reproduces, and not the one the rest of the file wants.
const [TOKEN, SECOND] = vi.hoisted(() => {
  const tokens = ["setup-token-for-tests", "a-second-operators-token"];
  // Two, comma separated: an operator may hold more than one so a second
  // person can be let in, or a token replaced, without ending a flow already
  // in progress. Everything below has to hold for both.
  process.env.INITIATIVE_APP_SETUP_TOKEN = tokens.join(",");
  return tokens;
});

import { SetupGate } from "initiative-app-kit";

import { config } from "../src/config.js";
import {
  authorized,
  convert,
  credentialsPage,
  registerPage,
  setupEnabled,
  verifyState,
} from "../src/github/setup.js";

/** A state as the first route would mint it, for the second route to check. */
const mintState = (now: number = Date.now(), token: string = TOKEN) =>
  new SetupGate({ tokens: config.setupTokens }).mintState(token, now);

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("whether the flow exists at all", () => {
  it("is on when the operator set a token", () => {
    expect(setupEnabled()).toBe(true);
  });

  it("is off, and unmintable, when they did not", async () => {
    // The one case that cannot be checked by calling the same module twice:
    // configuration is read at import. A fresh registry with the variable gone
    // is the only honest way to see what a deployment that never set it does.
    vi.resetModules();
    const previous = process.env.INITIATIVE_APP_SETUP_TOKEN;
    delete process.env.INITIATIVE_APP_SETUP_TOKEN;
    try {
      const fresh = await import("../src/github/setup.js");
      expect(fresh.setupEnabled()).toBe(false);
      expect(fresh.authorized("anything")).toBeNull();
      expect(fresh.verifyState("anything")).toBe(false);
      // Not "returns something useless" — refuses. A state signed with no key
      // would verify against no key.
      expect(() => new SetupGate({ tokens: [] }).mintState("anything")).toThrow();
    } finally {
      process.env.INITIATIVE_APP_SETUP_TOKEN = previous;
      vi.resetModules();
    }
  });
});

describe("the token on the first route", () => {
  it("hands back the one the operator set, not merely a yes", () => {
    // Which token opened the flow decides which token signs its state, so the
    // answer has to be the token rather than a boolean.
    expect(authorized(TOKEN)).toBe(TOKEN);
  });

  it("refuses a wrong one, a missing one, and a prefix of the right one", () => {
    expect(authorized("wrong")).toBeNull();
    expect(authorized(null)).toBeNull();
    expect(authorized("")).toBeNull();
    // A length mismatch raises inside the compare rather than returning false,
    // so it is handled before it gets there.
    expect(authorized(TOKEN.slice(0, -1))).toBeNull();
    expect(authorized(`${TOKEN}x`)).toBeNull();
  });
});

describe("the state on the second route", () => {
  it("verifies one this app minted", () => {
    expect(verifyState(mintState())).toBe(true);
  });

  it("refuses one that was edited", () => {
    const state = mintState();
    const [expiry, nonce, signature] = state.split(".");
    // Every part, because each of them is load-bearing: the expiry bounds it,
    // the nonce makes two mints differ, and the signature ties it to the token.
    expect(verifyState(`${expiry}.${nonce}.${signature.slice(0, -2)}AA`)).toBe(false);
    expect(verifyState(`${expiry}.tampered.${signature}`)).toBe(false);
    expect(verifyState(`${Number(expiry) + 3600}.${nonce}.${signature}`)).toBe(false);
  });

  it("refuses one that is not the right shape", () => {
    expect(verifyState(null)).toBe(false);
    expect(verifyState("")).toBe(false);
    expect(verifyState("nonsense")).toBe(false);
    expect(verifyState("a.b")).toBe(false);
    expect(verifyState("not-a-number.nonce.signature")).toBe(false);
  });

  it("refuses one that has expired", () => {
    const state = mintState(Date.now());
    // Fifteen minutes is long enough to read a GitHub confirmation screen and
    // short enough that a state left in a browser history is not a way back in.
    expect(verifyState(state, Date.now() + 16 * 60 * 1000)).toBe(false);
    expect(verifyState(state, Date.now() + 5 * 60 * 1000)).toBe(true);
  });

  it("refuses one minted under a token the deployment no longer holds", () => {
    // Removing a setup token has to end the flows it authorized, or removing it
    // would not be a way of ending them.
    const state = new SetupGate({ tokens: ["a-token-since-removed"] }).mintState(
      "a-token-since-removed"
    );
    expect(verifyState(state)).toBe(false);
  });

  it("keeps a flow opened under a token that is still held", () => {
    // The point of holding more than one: replacing a token, or letting a
    // second operator in, must not end somebody else's half-finished flow.
    for (const token of [TOKEN, SECOND]) {
      expect(verifyState(mintState(Date.now(), token))).toBe(true);
    }
  });

  it("recognizes either held token on the first route", () => {
    expect(authorized(TOKEN)).toBe(TOKEN);
    expect(authorized(SECOND)).toBe(SECOND);
    expect(authorized("neither-of-them")).toBeNull();
    expect(authorized(null)).toBeNull();
  });
});

describe("the page that posts the manifest", () => {
  it("posts to GitHub, carrying the manifest and a state", () => {
    const html = registerPage(null, TOKEN);
    expect(html).toContain(`action="${config.github.webBase}/settings/apps/new"`);
    expect(html).toContain('method="post"');
    expect(html).toContain('name="manifest"');
    expect(html).toContain('name="state"');
  });

  it("sends it to an organization when one is named", () => {
    expect(registerPage("acme", TOKEN)).toContain(
      `action="${config.github.webBase}/organizations/acme/settings/apps/new"`
    );
  });

  it("escapes the manifest rather than closing the attribute", () => {
    // The manifest is JSON in an HTML attribute, and it contains quotes on
    // every key. Unescaped, the first one ends the value and the rest of the
    // manifest becomes markup.
    const html = registerPage(null, TOKEN);
    expect(html).toContain("&quot;default_permissions&quot;");
    expect(html).not.toContain('value="{"');
  });

  it("waits for a click rather than submitting itself", () => {
    // The next screen creates a GitHub App under whoever is signed in. That is
    // not something to do to somebody who followed a link.
    const html = registerPage(null, TOKEN);
    expect(html).toContain("<button type=\"submit\">");
    expect(html).not.toMatch(/\.submit\(\)|onload=/);
  });
});

describe("what comes back", () => {
  function githubReturns(body: Record<string, unknown>, status = 201) {
    return vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () => new Response(JSON.stringify(body), { status })
      );
  }

  const CONVERTED = {
    client_id: "Iv23liABCDEF",
    client_secret: "secret-value",
    pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\n",
    webhook_secret: "hook-secret",
    slug: "initiative-for-tests",
  };

  it("reads the four credentials the app needs", async () => {
    githubReturns(CONVERTED);
    await expect(convert("code")).resolves.toEqual({
      clientId: "Iv23liABCDEF",
      clientSecret: "secret-value",
      pem: CONVERTED.pem,
      webhookSecret: "hook-secret",
      slug: "initiative-for-tests",
    });
  });

  it("refuses an answer missing any of them", async () => {
    githubReturns({ client_id: "only-this" });
    await expect(convert("code")).resolves.toBeNull();
  });

  it("refuses a code GitHub would not take", async () => {
    githubReturns({}, 422);
    await expect(convert("spent")).resolves.toBeNull();
  });

  it("renders the key in the one shape an environment variable survives", () => {
    const html = credentialsPage({
      clientId: "Iv23liABCDEF",
      clientSecret: "secret-value",
      pem: CONVERTED.pem,
      webhookSecret: "hook-secret",
      slug: "initiative-for-tests",
    });
    // A PEM's newlines do not survive a .env file, and an operator hand-joining
    // sixty lines finds out at boot.
    expect(html).toContain(
      `GITHUB_APP_PRIVATE_KEY=${Buffer.from(CONVERTED.pem).toString("base64")}`
    );
    expect(html).toContain("GITHUB_CLIENT_ID=Iv23liABCDEF");
    expect(html).toContain("GITHUB_WEBHOOK_SECRET=hook-secret");
    // And it says the thing that is only true because nothing was persisted.
    expect(html).toContain("stored nowhere");
    // Then points at the app it just made, by the slug GitHub assigned.
    expect(html).toContain("/apps/initiative-for-tests/installations/new");
  });
});
