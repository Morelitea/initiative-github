/**
 * Knowing which version of the schema built the database in front of us.
 *
 * There is no migration tool here, which is a defensible choice for five tables
 * and was costing more than it saved: a database created before a column was
 * added simply did not get it, every statement being `IF NOT EXISTS` meant
 * re-running them fixed nothing, and the first anyone knew was a runtime
 * `column … does not exist` from whichever query happened to touch it — a long
 * way, in time and in file, from the change that caused it.
 *
 * A version does not replace a migration. It replaces *not noticing*.
 *
 * Needs a database it may drop and recreate. `DATABASE_URL` in CI; see
 * README.md to run it locally.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { SchemaMismatchError, close, migrate, pool } from "../src/db.js";

/** Back to nothing, so each case starts from a database with no schema at all. */
async function empty() {
  await pool.query("DROP SCHEMA public CASCADE");
  await pool.query("CREATE SCHEMA public");
}

beforeEach(async () => {
  await empty();
});

afterAll(async () => {
  // Left usable for whatever runs next, since every other suite calls migrate.
  await empty();
  await migrate();
  await close();
});

describe("applying it", () => {
  it("records what built the database", async () => {
    await migrate();
    const found = await pool.query<{ fingerprint: string }>(
      "SELECT fingerprint FROM schema_version"
    );
    expect(found.rows).toHaveLength(1);
    expect(found.rows[0].fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is safe to run again, and on a second replica", async () => {
    await migrate();
    const first = await pool.query<{ applied_at: Date }>(
      "SELECT applied_at FROM schema_version"
    );

    await Promise.all([migrate(), migrate()]);

    const after = await pool.query<{ applied_at: Date }>(
      "SELECT applied_at FROM schema_version"
    );
    // One row still, and the same one: a later boot does not restamp a schema
    // it did not change.
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0].applied_at).toEqual(first.rows[0].applied_at);
  });

  it("creates every table the app reads", async () => {
    await migrate();
    const found = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
    );
    expect(found.rows.map((row) => row.tablename).sort()).toEqual([
      "connections",
      "delegation_tokens",
      "oauth_states",
      "schema_version",
      "subscriptions",
      "workspaces",
    ]);
  });
});

describe("when the database was built by a different version", () => {
  it("refuses at boot, rather than at whichever query notices", async () => {
    await migrate();
    await pool.query("UPDATE schema_version SET fingerprint = 'deadbeefdeadbeef'");

    await expect(migrate()).rejects.toBeInstanceOf(SchemaMismatchError);
  });

  it("says both versions and what to do about it", async () => {
    // The whole value is in the message. A refusal that does not name the
    // remedy has moved the confusion rather than removed it.
    await migrate();
    await pool.query("UPDATE schema_version SET fingerprint = 'deadbeefdeadbeef'");

    await expect(migrate()).rejects.toThrow(/deadbeefdeadbeef/);
    await expect(migrate()).rejects.toThrow(/drop the database/);
  });

  it("changes nothing while refusing", async () => {
    // Refusing is not repairing, and it must not be destroying either: these
    // tables hold members' GitHub credentials and the secrets subscribers
    // verify deliveries with. Dropping them is a human's decision.
    await migrate();
    await pool.query(
      `INSERT INTO connections (connection_ref, access_token) VALUES ('ref-x', 'sealed')`
    );
    await pool.query("UPDATE schema_version SET fingerprint = 'deadbeefdeadbeef'");

    await expect(migrate()).rejects.toBeInstanceOf(SchemaMismatchError);

    const rows = await pool.query("SELECT connection_ref FROM connections");
    expect(rows.rowCount).toBe(1);
    const stamp = await pool.query<{ fingerprint: string }>(
      "SELECT fingerprint FROM schema_version"
    );
    expect(stamp.rows[0].fingerprint).toBe("deadbeefdeadbeef");
  });

  it("is what a missing column would otherwise have looked like", async () => {
    // The failure this replaces, reproduced: a database built before a column,
    // which every `IF NOT EXISTS` statement then leaves exactly as it is.
    await migrate();
    await pool.query("ALTER TABLE connections DROP COLUMN guild_id");
    await pool.query("UPDATE schema_version SET fingerprint = 'anolderbuild00'");

    // Boot refuses…
    await expect(migrate()).rejects.toBeInstanceOf(SchemaMismatchError);
    // …and it was right to: re-running the statements would not have added it.
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'connections' AND column_name = 'guild_id'`
    );
    expect(columns.rowCount).toBe(0);
  });
});
