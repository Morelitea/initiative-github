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

  it("still refuse to render without the setup token", async () => {
    const response = await fetch(`${origin}${REGISTER_PATH}`);
    expect(response.status).toBe(404);
  });
});
