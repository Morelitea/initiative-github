/** The HTTP boundary around the durable delivery lease. */

import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { handleDelivery } = vi.hoisted(() => ({
  handleDelivery: vi.fn(),
}));

vi.mock("../src/github/webhooks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/github/webhooks.js")>()),
  handleDelivery,
}));

const { beginDelivery, close, migrate, pool } = await import("../src/db.js");
const { server } = await import("../src/server.js");
const { DELIVERY_HEADER, EVENT_HEADER, SIGNATURE_HEADER } = await import(
  "../src/github/webhooks.js"
);
const { WEBHOOK_PATH } = await import("../src/vocabulary.js");

let origin: string;

beforeAll(async () => {
  await migrate();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;
});

beforeEach(async () => {
  await pool.query("TRUNCATE webhook_deliveries");
  handleDelivery.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await close();
});

async function deliver(id: string): Promise<Response> {
  const body = Buffer.from('{"action":"opened"}');
  const signature = createHmac("sha256", "test-webhook-secret")
    .update(body)
    .digest("hex");
  return fetch(`${origin}${WEBHOOK_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [DELIVERY_HEADER]: id,
      [EVENT_HEADER]: "issues",
      [SIGNATURE_HEADER]: `sha256=${signature}`,
    },
    body,
  });
}

describe("the webhook delivery lease", () => {
  it("retries failed work, then suppresses only the completed delivery", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    handleDelivery
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({ resynced: 0, published: 1 });

    expect((await deliver("route-retry")).status).toBe(500);
    expect((await deliver("route-retry")).status).toBe(200);
    const duplicate = await deliver("route-retry");

    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ resynced: 0, published: 0, duplicate: true });
    expect(handleDelivery).toHaveBeenCalledTimes(2);
  });

  it("asks for another delivery while a live attempt owns the lease", async () => {
    expect(await beginDelivery("route-in-progress", "fixed-live-lease")).toBe("started");

    const response = await deliver("route-in-progress");

    expect(response.status).toBe(503);
    expect(handleDelivery).not.toHaveBeenCalled();
  });
});
