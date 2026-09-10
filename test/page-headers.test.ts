/**
 * Headers on the HTML pages.
 *
 * Two of the pages `sendPage` serves are reached by a URL carrying a secret —
 * the registration form behind `?token=`, and the result page rendering the four
 * one-time values GitHub will not show again. Neither belongs in a cache, and
 * neither should send its own URL onward in a `Referer` header.
 *
 * See T98 in the estate threat model.
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
    // The setup token is in the query string, so a link followed from one of
    // these pages would otherwise carry it to the destination.
    const response = await fetch(
      `${origin}${REGISTER_PATH}?token=${encodeURIComponent(TOKEN)}`
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("still refuse to render without the setup token", async () => {
    const response = await fetch(`${origin}${REGISTER_PATH}`);
    expect(response.status).toBe(404);
  });
});
