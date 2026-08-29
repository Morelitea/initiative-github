/**
 * Registering this app at GitHub, from the app itself.
 *
 * The state it guards against is the one an app should never be in by
 * accident: running with no credentials and a route that mints some. So what
 * these pin is the door rather than the flow — that it is shut unless an
 * operator opened it, that it cannot be opened by guessing, and that what comes
 * back from GitHub has to be a trip this app started.
 *
 * The conversion itself is one unauthenticated POST to GitHub, because the code
 * is the authority: it lives an hour and is good exactly once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SETUP_TOKEN_ENV } from "initiative-app-kit";

const TOKEN = "open-sesame";

beforeEach(() => {
  process.env[SETUP_TOKEN_ENV] = TOKEN;
});

afterEach(() => {
  delete process.env[SETUP_TOKEN_ENV];
  vi.restoreAllMocks();
});

/** Imported per test, because the guard reads the environment as it is. */
async function registration() {
  return import("../src/github/registration.js");
}

describe("the door", () => {
  it("is shut to everybody but the token", async () => {
    const { permitted } = await registration();

    expect(permitted(TOKEN)).toBe(true);
    expect(permitted("open-sesam")).toBe(false);
    expect(permitted("")).toBe(false);
    expect(permitted(null)).toBe(false);
  });

  it("is shut when the deployment set no token at all", async () => {
    delete process.env[SETUP_TOKEN_ENV];
    const { permitted, registrationForm } = await registration();

    // Not "shut to the empty string" — shut, so an operator who never set the
    // variable is not offering registration to whoever asks.
    expect(permitted("")).toBe(false);
    expect(permitted(TOKEN)).toBe(false);
    expect(registrationForm(null)).toBeNull();
  });
});

describe("what GitHub is asked to create", () => {
  it("posts the registration this app generates, to the right form", async () => {
    const { registrationForm } = await registration();

    const page = registrationForm(null)!;
    expect(page).toContain('action="https://github.com/settings/apps/new');

    const manifest = JSON.parse(
      page.match(/name="manifest" value="([^"]*)"/)![1].replace(/&quot;/g, '"')
    );
    // The whole reason for doing it this way: these came from the same
    // constants the app runs on, so they cannot be typed wrong.
    expect(manifest.callback_urls).toHaveLength(2);
    expect(manifest.request_oauth_on_install).toBe(false);
    expect(manifest.redirect_url).toContain("/setup/register/done");
  });

  it("sends an organization's form when one is named", async () => {
    const { registrationForm } = await registration();

    expect(registrationForm("morelitea")).toContain(
      "https://github.com/organizations/morelitea/settings/apps/new"
    );
  });
});

describe("what comes back", () => {
  it("is recognised only when this app sent it", async () => {
    const { registrationForm, returnedFromUs } = await registration();

    const state = decodeURIComponent(
      registrationForm(null)!.match(/state=([^"&]*)/)![1]
    );

    expect(returnedFromUs(state)).toBe(true);
    expect(returnedFromUs(null)).toBe(false);
    expect(returnedFromUs("invented")).toBe(false);
    // A real state with somebody else's signature on it.
    expect(returnedFromUs(`${state.split(".")[0]}.0000`)).toBe(false);
  });

  it("cannot be recognised once the operator shuts the door", async () => {
    const { registrationForm } = await registration();
    const state = decodeURIComponent(
      registrationForm(null)!.match(/state=([^"&]*)/)![1]
    );

    delete process.env[SETUP_TOKEN_ENV];
    const { returnedFromUs } = await registration();

    expect(returnedFromUs(state)).toBe(false);
  });
});

describe("converting the code", () => {
  it("hands back the four settings, with the key in the shape they take", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        slug: "initiative-for-github",
        html_url: "https://github.com/apps/initiative-for-github",
        client_id: "Iv1.abc",
        client_secret: "shh",
        webhook_secret: "hook",
        pem: "-----BEGIN RSA PRIVATE KEY-----\nkey\n-----END RSA PRIVATE KEY-----",
      })
    );
    const { convert } = await registration();

    const app = (await convert("code"))!;
    expect(app.clientId).toBe("Iv1.abc");
    // A PEM has newlines and a setting is one line.
    expect(Buffer.from(app.privateKey, "base64").toString("utf-8")).toContain(
      "BEGIN RSA PRIVATE KEY"
    );
  });

  it("answers nothing rather than half a registration", async () => {
    // GitHub answered, and without the credentials there is nothing to show —
    // which is a page saying so, not a partial block somebody pastes.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ slug: "initiative-for-github", client_id: "Iv1.abc" })
    );
    const { convert } = await registration();

    expect(await convert("code")).toBeNull();
  });

  it("answers nothing when GitHub refuses the code", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ message: "Not Found" }, { status: 404 })
    );
    const { convert } = await registration();

    expect(await convert("spent")).toBeNull();
  });
});
