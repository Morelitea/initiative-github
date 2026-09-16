/**
 * Headers on the HTML pages.
 *
 * Every page `sendPage` serves must be uncacheable and must not pass its own
 * URL onward. Rationale: T98.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";

import { SETUP_TOKEN_ENV } from "initiative-app-kit";

const TOKEN = "open-sesame";
process.env[SETUP_TOKEN_ENV] = TOKEN;

const { server } = await import("../src/server.js");
const { REGISTER_PATH } = await import("../src/vocabulary.js");

let origin: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("HTML pages", () => {
  it("are not stored by any cache", async () => {
    const response = await fetch(
      `${origin}${REGISTER_PATH}?token=${encodeURIComponent(TOKEN)}`
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("do not send their own URL onward", async () => {
    // Asserted on a URL that carries a query parameter, so a regression would
    // be visible rather than vacuously passing on a bare path.
    const response = await fetch(
      `${origin}${REGISTER_PATH}?token=${encodeURIComponent(TOKEN)}`
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  // This used to read "still refuse to render without the setup token", and
  // pinned a bare GET at 404. Closing T98 changed that on purpose: the token
  // may no longer travel in the URL, so the page that ASKS for it has to be
  // reachable without it. What was being protected is not the page but the
  // registration behind it, and that is pinned harder below than the 404 was.
  //
  // The cost is stated rather than hidden: while a setup token is configured,
  // anyone who guesses the path learns that setup is pending. That is true for
  // the minutes between deploying and registering. The token it replaces was
  // durable and written into every access log on the path.
  it("asks for the token rather than carrying it", async () => {
    const response = await fetch(`${origin}${REGISTER_PATH}`);

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toMatch(/method="post"/i);
    expect(body).not.toContain(TOKEN);
  });

  it("does not hand out the registration form to a bare GET", async () => {
    // The form that matters is the one whose action posts a new App to
    // GitHub. Asserted on that action, not on a status code, because a page
    // rendering 200 is only a problem if it is THIS page.
    for (const url of [
      `${origin}${REGISTER_PATH}`,
      `${origin}${REGISTER_PATH}?token=${encodeURIComponent(TOKEN)}`,
      `${origin}${REGISTER_PATH}?token=wrong`,
    ]) {
      expect(await (await fetch(url)).text()).not.toContain("settings/apps/new");
    }
  });

  it("refuses a posted token that is not the one configured", async () => {
    const response = await fetch(`${origin}${REGISTER_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: "guessed" }).toString(),
    });

    expect(response.status).toBe(404);
  });

  it("hands out the registration form only for a posted token", async () => {
    const response = await fetch(`${origin}${REGISTER_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: TOKEN }).toString(),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("settings/apps/new");
    // The page that carries a registration is as uncacheable as the prompt.
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
});
