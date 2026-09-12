/**
 * A delivery is accepted once.
 *
 * Needs a database, because the record of what has been seen IS the database.
 * `DATABASE_URL` in CI; see README.md to run it locally.
 *
 * Rationale: T99.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { claimDelivery, close, migrate, pool, DELIVERY_MEMORY_DAYS } from "../src/db.js";

beforeEach(async () => {
  await migrate();
});

afterAll(async () => {
  await close();
});

describe("a webhook delivery", () => {
  it("is claimed the first time and refused after", async () => {
    const id = randomUUID();
    expect(await claimDelivery(id)).toBe(true);
    expect(await claimDelivery(id)).toBe(false);
    expect(await claimDelivery(id)).toBe(false);
  });

  it("does not refuse a different delivery", async () => {
    expect(await claimDelivery(randomUUID())).toBe(true);
    expect(await claimDelivery(randomUUID())).toBe(true);
  });

  it("only one of two concurrent claims of the same id wins", async () => {
    // A read-then-write would let two concurrent claims both see nothing and
    // both proceed. The insert is one statement, so exactly one creates the row.
    const id = randomUUID();
    const results = await Promise.all([
      claimDelivery(id),
      claimDelivery(id),
      claimDelivery(id),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("forgets an id older than the memory window, and keeps a recent one", async () => {
    // The table has to stay bounded.
    const stale = randomUUID();
    const fresh = randomUUID();
    await claimDelivery(stale);
    await claimDelivery(fresh);

    await pool.query(
      `UPDATE webhook_deliveries
          SET seen_at = now() - ($1 || ' days')::interval
        WHERE delivery_id = $2`,
      [String(DELIVERY_MEMORY_DAYS + 1), stale]
    );

    // Any claim sweeps expired rows, so this call is what collects `stale`.
    await claimDelivery(randomUUID());

    const rows = await pool.query(
      "SELECT delivery_id FROM webhook_deliveries WHERE delivery_id = ANY($1)",
      [[stale, fresh]]
    );
    const kept = rows.rows.map((r) => r.delivery_id as string);
    expect(kept).toContain(fresh);
    expect(kept).not.toContain(stale);
  });
});
