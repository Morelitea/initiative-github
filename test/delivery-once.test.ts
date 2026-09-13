/**
 * A delivery is accepted once.
 *
 * Needs a database, because the record of what has been seen IS the database.
 * `DATABASE_URL` in CI; see README.md to run it locally.
 *
 * Rationale: T99.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  beginDelivery,
  close,
  DELIVERY_MEMORY_DAYS,
  migrate,
  pool,
  runDeliveryOnce,
} from "../src/db.js";

beforeEach(async () => {
  await migrate();
  await pool.query("TRUNCATE webhook_deliveries");
});

afterAll(async () => {
  await close();
});

describe("a webhook delivery", () => {
  it("releases a failed attempt so the same delivery can retry", async () => {
    const failed = vi.fn(async () => {
      throw new Error("temporary downstream failure");
    });
    const retried = vi.fn(async () => "accepted on retry");

    await expect(runDeliveryOnce("delivery-retry", failed)).rejects.toThrow(
      "temporary downstream failure"
    );
    const original = await pool.query<{ seen_at: Date }>(
      "SELECT seen_at FROM webhook_deliveries WHERE delivery_id = 'delivery-retry'"
    );

    await expect(runDeliveryOnce("delivery-retry", retried)).resolves.toEqual({
      kind: "processed",
      result: "accepted on retry",
    });
    const after = await pool.query<{ seen_at: Date }>(
      "SELECT seen_at FROM webhook_deliveries WHERE delivery_id = 'delivery-retry'"
    );
    expect(after.rows[0]?.seen_at).toEqual(original.rows[0]?.seen_at);
    expect(failed).toHaveBeenCalledOnce();
    expect(retried).toHaveBeenCalledOnce();
  });

  it("suppresses a retry only after the first attempt completed", async () => {
    const work = vi.fn(async () => ({ published: 1 }));

    await expect(runDeliveryOnce("delivery-complete", work)).resolves.toEqual({
      kind: "processed",
      result: { published: 1 },
    });
    await expect(runDeliveryOnce("delivery-complete", work)).resolves.toEqual({
      kind: "duplicate",
    });
    expect(work).toHaveBeenCalledOnce();
  });

  it("only one concurrent attempt starts", async () => {
    const results = await Promise.all([
      beginDelivery("delivery-concurrent", "lease-a"),
      beginDelivery("delivery-concurrent", "lease-b"),
      beginDelivery("delivery-concurrent", "lease-c"),
    ]);
    expect(results.filter((result) => result === "started")).toHaveLength(1);
    expect(results.filter((result) => result === "in_progress")).toHaveLength(2);
  });

  it("lets a new attempt take over an expired lease without losing first-seen audit", async () => {
    expect(await beginDelivery("delivery-expired", "lease-original")).toBe("started");
    const original = await pool.query<{ seen_at: Date }>(
      "SELECT seen_at FROM webhook_deliveries WHERE delivery_id = 'delivery-expired'"
    );
    expect(await beginDelivery("delivery-expired", "lease-too-soon")).toBe("in_progress");

    await pool.query(
      `UPDATE webhook_deliveries
          SET lease_until = TIMESTAMPTZ '2000-01-01 00:00:00+00'
        WHERE delivery_id = 'delivery-expired'`
    );

    expect(await beginDelivery("delivery-expired", "lease-retry")).toBe("started");
    const reclaimed = await pool.query<{ seen_at: Date; lease_token: string }>(
      `SELECT seen_at, lease_token FROM webhook_deliveries
        WHERE delivery_id = 'delivery-expired'`
    );
    expect(reclaimed.rows[0]?.seen_at).toEqual(original.rows[0]?.seen_at);
    expect(reclaimed.rows[0]?.lease_token).toBe("lease-retry");
  });

  it("forgets completed deliveries older than the memory window", async () => {
    await runDeliveryOnce("delivery-stale", async () => "done");
    await runDeliveryOnce("delivery-fresh", async () => "done");

    await pool.query(
      `UPDATE webhook_deliveries
          SET completed_at = now() - ($1 || ' days')::interval
        WHERE delivery_id = 'delivery-stale'`,
      [String(DELIVERY_MEMORY_DAYS + 1)]
    );

    await beginDelivery("delivery-sweeps", "lease-sweeper");

    const rows = await pool.query(
      "SELECT delivery_id FROM webhook_deliveries WHERE delivery_id = ANY($1)",
      [["delivery-stale", "delivery-fresh"]]
    );
    const kept = rows.rows.map((r) => r.delivery_id as string);
    expect(kept).toContain("delivery-fresh");
    expect(kept).not.toContain("delivery-stale");
  });
});
