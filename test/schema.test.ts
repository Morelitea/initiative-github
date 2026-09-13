/**
 * Changing the schema without losing the database.
 *
 * There is still no migration framework here, and for this small schema that remains
 * right. What was wrong was having no way forward: the whole schema hashed to
 * one fingerprint, and a database built by an older build was told to drop
 * itself. Adding one additive table to take a security fix cost a production
 * database, so the fix did not ship — which is how a safety mechanism starts
 * costing more than the thing it prevents.
 *
 * The schema is now an ordered list of named steps, each applied once and
 * recorded by name. Two properties matter and neither is visible to the type
 * checker: an unapplied step is applied, and an applied step can never change.
 *
 * Needs a database it may drop and recreate. `DATABASE_URL` in CI; see
 * README.md to run it locally.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  SCHEMA,
  type SchemaStep,
  SchemaMismatchError,
  close,
  migrate,
  pool,
} from "../src/db.js";

/** Back to nothing, so each case starts from a database with no schema at all. */
async function empty() {
  await pool.query("DROP SCHEMA public CASCADE");
  await pool.query("CREATE SCHEMA public");
}

/** The exact stamp written by the release immediately before schema steps. */
const PREVIOUS_SCHEMA_FINGERPRINT = "ea4f995a8e701b3f";

class PreviousBuildRefusedSchema extends Error {}

/**
 * The previous release's observable rollback guard, pinned to its fixed stamp.
 * It deliberately knows nothing about `schema_steps`: old code cannot be
 * changed after a newer deployment has written the database.
 */
async function migrateAsPreviousBuild() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_version (
         id          BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
         fingerprint TEXT NOT NULL,
         applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
       )`
    );
    const found = await client.query<{ fingerprint: string }>(
      "SELECT fingerprint FROM schema_version"
    );
    const stored = found.rows[0]?.fingerprint ?? null;
    if (stored !== null && stored !== PREVIOUS_SCHEMA_FINGERPRINT) {
      throw new PreviousBuildRefusedSchema();
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Run migrate() with an extra step appended, and put SCHEMA back afterwards.
 *
 * The array is mutated rather than a parameter being threaded through
 * migrate(): the property under test is that a step appended to the real list
 * is applied to a real database, and a migrate() that accepted a list would be
 * proving something about a function signature instead.
 */
async function withExtraStep<T>(step: SchemaStep, run: () => Promise<T>): Promise<T> {
  SCHEMA.push(step);
  try {
    return await run();
  } finally {
    SCHEMA.pop();
  }
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
  it("records every step by name", async () => {
    await migrate();

    const found = await pool.query<{ name: string; fingerprint: string }>(
      "SELECT name, fingerprint FROM schema_steps ORDER BY name"
    );
    expect(found.rows.map((row) => row.name)).toEqual(SCHEMA.map((step) => step.name));
    for (const row of found.rows) expect(row.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is safe to run again, and on a second replica", async () => {
    await migrate();
    const first = await pool.query<{ applied_at: Date }>(
      "SELECT applied_at FROM schema_steps ORDER BY name"
    );

    await Promise.all([migrate(), migrate()]);

    const after = await pool.query<{ applied_at: Date }>(
      "SELECT applied_at FROM schema_steps ORDER BY name"
    );
    // The same rows, with the same stamps: a later boot does not re-apply or
    // re-stamp a step it did not change.
    expect(after.rows).toEqual(first.rows);
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
      "schema_steps",
      "schema_version",
      "subscriptions",
      "webhook_deliveries",
      "workspaces",
    ]);
  });
});

describe("an additive step on a database that already has rows", () => {
  it("applies, and keeps the rows", async () => {
    // The case that could not happen before, and the reason this exists: a
    // security fix that needs one more table must not cost the credentials
    // already in the database.
    await migrate();
    await pool.query(
      `INSERT INTO connections (connection_ref, access_token) VALUES ('ref-x', 'sealed')`
    );

    await withExtraStep(
      {
        name: "9001-additive",
        statements: [`CREATE TABLE IF NOT EXISTS later_table (id BIGSERIAL PRIMARY KEY)`],
        risk: "additive",
      },
      migrate
    );

    const rows = await pool.query("SELECT connection_ref FROM connections");
    expect(rows.rowCount).toBe(1);
    const table = await pool.query(
      "SELECT to_regclass('public.later_table') IS NOT NULL AS present"
    );
    expect(table.rows[0].present).toBe(true);
  });

  it("records the new step, and only it", async () => {
    await migrate();

    await withExtraStep(
      {
        name: "9001-additive",
        statements: [`CREATE TABLE IF NOT EXISTS later_table (id BIGSERIAL PRIMARY KEY)`],
        risk: "additive",
      },
      migrate
    );

    const found = await pool.query<{ name: string }>(
      "SELECT name FROM schema_steps ORDER BY name"
    );
    expect(found.rows.map((row) => row.name)).toEqual([
      ...SCHEMA.map((step) => step.name),
      "9001-additive",
    ]);
  });
});

describe("a step that can destroy data", () => {
  const dropping: SchemaStep = {
    name: "9002-drops-a-table",
    statements: [`DROP TABLE IF EXISTS connections`],
    risk: "destructive",
    dataLoss: "all stored GitHub connection credentials",
  };

  it("refuses a step with no explicit risk classification", async () => {
    await migrate();
    const unclassified = {
      name: dropping.name,
      statements: dropping.statements,
    } as SchemaStep;

    await expect(withExtraStep(unclassified, migrate)).rejects.toBeInstanceOf(
      SchemaMismatchError
    );
  });

  it("leaves the table it would have dropped", async () => {
    // Refusing is not repairing, and it must not be destroying either: these
    // tables hold members' GitHub credentials and the secrets subscribers
    // verify deliveries with.
    await migrate();
    await pool.query(
      `INSERT INTO connections (connection_ref, access_token) VALUES ('ref-x', 'sealed')`
    );

    const unclassified = {
      name: dropping.name,
      statements: dropping.statements,
    } as SchemaStep;
    await expect(withExtraStep(unclassified, migrate)).rejects.toThrow(/classify its data risk/);

    const rows = await pool.query("SELECT connection_ref FROM connections");
    expect(rows.rowCount).toBe(1);
  });

  it("applies once somebody has acknowledged it", async () => {
    // Marking it does not make it safe. It makes it deliberate, which is the
    // only thing code can check.
    await migrate();

    await withExtraStep(dropping, migrate);

    const table = await pool.query(
      "SELECT to_regclass('public.connections') IS NOT NULL AS present"
    );
    expect(table.rows[0].present).toBe(false);
  });

  it("classifies every step this build actually ships", () => {
    for (const step of SCHEMA) {
      expect(["additive", "destructive"]).toContain(step.risk);
    }
  });

  it("refuses an unclassified update before it changes stored credentials", async () => {
    await migrate();
    await pool.query(
      `INSERT INTO connections (connection_ref, access_token) VALUES ('ref-x', 'sealed')`
    );
    const unclassified = {
      name: "9003-unclassified-update",
      statements: [`UPDATE connections SET access_token = 'erased'`],
    } as SchemaStep;

    await expect(withExtraStep(unclassified, migrate)).rejects.toBeInstanceOf(
      SchemaMismatchError
    );

    const stored = await pool.query<{ access_token: string }>(
      "SELECT access_token FROM connections WHERE connection_ref = 'ref-x'"
    );
    expect(stored.rows[0]?.access_token).toBe("sealed");
  });
});

describe("when the database and the code have diverged", () => {
  it("refuses a step that was edited after it was applied", async () => {
    // An applied step is history. Editing one means the database no longer
    // matches the code and nothing would re-run to fix it.
    await migrate();
    await pool.query("UPDATE schema_steps SET fingerprint = 'deadbeefdeadbeef' WHERE name = $1", [
      SCHEMA[0].name,
    ]);

    await expect(migrate()).rejects.toBeInstanceOf(SchemaMismatchError);
    await expect(migrate()).rejects.toThrow(/deadbeefdeadbeef/);
    await expect(migrate()).rejects.toThrow(/Append a new step/);
  });

  it("refuses a database written by a newer build", async () => {
    // Rolling the code back without rolling the database back is how a column
    // silently stops being written to.
    await migrate();
    await pool.query("INSERT INTO schema_steps (name, fingerprint) VALUES ($1, $2)", [
      "9999-from-the-future",
      "0123456789abcdef",
    ]);

    await expect(migrate()).rejects.toThrow(/9999-from-the-future/);
  });

  it("changes nothing while refusing", async () => {
    await migrate();
    await pool.query(
      `INSERT INTO connections (connection_ref, access_token) VALUES ('ref-x', 'sealed')`
    );
    await pool.query("UPDATE schema_steps SET fingerprint = 'deadbeefdeadbeef' WHERE name = $1", [
      SCHEMA[0].name,
    ]);

    await expect(migrate()).rejects.toBeInstanceOf(SchemaMismatchError);

    const rows = await pool.query("SELECT connection_ref FROM connections");
    expect(rows.rowCount).toBe(1);
    const stamp = await pool.query<{ fingerprint: string }>(
      "SELECT fingerprint FROM schema_steps WHERE name = $1",
      [SCHEMA[0].name]
    );
    expect(stamp.rows[0].fingerprint).toBe("deadbeefdeadbeef");
  });
});

describe("a database stamped by the scheme this replaced", () => {
  /** What the previous build left behind: one row, one fingerprint, no steps. */
  async function asLegacyDatabase(fingerprint: string) {
    await migrate();
    await pool.query("DROP TABLE schema_steps");
    await pool.query("DROP TABLE IF EXISTS schema_version");
    await pool.query(
      `CREATE TABLE schema_version (
         id          BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
         fingerprint TEXT NOT NULL,
         applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
       )`
    );
    await pool.query("INSERT INTO schema_version (fingerprint) VALUES ($1)", [fingerprint]);
  }

  it("is adopted, and its rows survive", async () => {
    // These databases hold members' GitHub credentials. The upgrade has to be
    // something they live through, not something they are recreated for.
    await asLegacyDatabase(PREVIOUS_SCHEMA_FINGERPRINT);
    await pool.query(
      `INSERT INTO connections (connection_ref, access_token) VALUES ('ref-x', 'sealed')`
    );

    await migrate();

    const steps = await pool.query<{ name: string }>("SELECT name FROM schema_steps");
    expect(steps.rows.map((row) => row.name)).toEqual(SCHEMA.map((step) => step.name));
    const rows = await pool.query("SELECT connection_ref FROM connections");
    expect(rows.rowCount).toBe(1);
  });

  it("then takes an additive step like any other database", async () => {
    // Adoption is only worth anything if what follows it works. This is the
    // whole path a real deployment walks.
    await asLegacyDatabase(PREVIOUS_SCHEMA_FINGERPRINT);

    await migrate();
    await withExtraStep(
      {
        name: "9001-additive",
        statements: [`CREATE TABLE IF NOT EXISTS later_table (id BIGSERIAL PRIMARY KEY)`],
        risk: "additive",
      },
      migrate
    );

    const table = await pool.query(
      "SELECT to_regclass('public.later_table') IS NOT NULL AS present"
    );
    expect(table.rows[0].present).toBe(true);
  });

  it("still refuses a stamp from a build whose statements differed", async () => {
    // The old guard, kept. A stamp that does not match means this build cannot
    // tell what the schema in front of it actually is.
    await asLegacyDatabase("anolderbuild0000");

    await expect(migrate()).rejects.toBeInstanceOf(SchemaMismatchError);
    await expect(migrate()).rejects.toThrow(/anolderbuild0000/);
  });

  it("leaves the old table alone rather than dropping it", async () => {
    // Dropping it is a destructive statement on a database we are here to
    // preserve. One unused table is the cheaper mistake.
    await asLegacyDatabase(PREVIOUS_SCHEMA_FINGERPRINT);

    await migrate();

    const table = await pool.query(
      "SELECT to_regclass('public.schema_version') IS NOT NULL AS present"
    );
    expect(table.rows[0].present).toBe(true);
  });

  it("makes the previous build refuse after a later step is applied", async () => {
    await asLegacyDatabase(PREVIOUS_SCHEMA_FINGERPRINT);
    await pool.query(
      `INSERT INTO connections (connection_ref, access_token) VALUES ('ref-x', 'sealed')`
    );

    await withExtraStep(
      {
        name: "9004-forward-only",
        statements: [`CREATE TABLE later_table (id BIGSERIAL PRIMARY KEY)`],
        risk: "additive",
      },
      migrate
    );

    await expect(migrateAsPreviousBuild()).rejects.toBeInstanceOf(PreviousBuildRefusedSchema);
    const stored = await pool.query<{ access_token: string }>(
      "SELECT access_token FROM connections WHERE connection_ref = 'ref-x'"
    );
    expect(stored.rows[0]?.access_token).toBe("sealed");
  });
});
