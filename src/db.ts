import { createHash } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { createVault } from "initiative-app-kit";

import { config } from "./config.js";

let opened: Pool | null = null;

// Opened on first use, not at import: this module is on the path the manifest
// build imports, and rendering a JSON file should not open a connection.
export const pool: Pool = new Proxy({} as Pool, {
  get(_target, key) {
    opened ??= new Pool({
      connectionString: config.databaseUrl,

      max: 8,
      idleTimeoutMillis: 30_000,
    });
    const value = opened[key as keyof Pool];
    return typeof value === "function" ? value.bind(opened) : value;
  },
});

/**
 * The schema, as an ordered list of named steps.
 *
 * There is still no migration framework here, and that remains the right call
 * for a schema this size. What was wrong was having no way FORWARD: the whole
 * thing hashed to one fingerprint, and a database built by an older build was
 * told to drop itself. Adding one additive table to take a security fix cost a
 * production database, so the fix did not ship.
 *
 * A step is applied once and never edited afterwards. What has been applied is
 * a row per step, which an operator can read, rather than a hash they can only
 * compare.
 *
 * To change the schema: append a step. Do not edit an applied one -- boot
 * refuses if a step's statements no longer match what was recorded, because
 * the only thing that can mean is that the database and the code have quietly
 * diverged.
 */
interface SchemaStepBase {
  /** Ordered and stable. It is the primary key of the record. */
  name: string;
  statements: string[];
}

/**
 * SQL text is not a safety type. Every step therefore classifies itself, and a
 * destructive step must say what it loses. The declaration makes the decision
 * reviewable without pretending a regular expression can parse every way SQL
 * changes data.
 */
export type SchemaStep =
  | (SchemaStepBase & { risk: "additive" })
  | (SchemaStepBase & { risk: "destructive"; dataLoss: string });

const INITIAL = [

  // One member's credential at GitHub, sealed. Their account is not written
  // down anywhere — not here and not in Initiative — because nothing reads it:
  // the token is what every call is made with, and the connection handle is
  // what it is filed under.
  `CREATE TABLE IF NOT EXISTS connections (
     connection_ref     TEXT PRIMARY KEY,
     guild_ref          TEXT,
     access_token       TEXT NOT NULL,
     refresh_token      TEXT,
     expires_at         TIMESTAMPTZ,
     refresh_expires_at TIMESTAMPTZ,
     created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,

  // A browser trip this app started and expects back. Nothing here says which
  // kind, because nothing has to: each ends at a route of its own, so whichever
  // one claims a row already knows what it is looking at.
  //
  // `claimed_installation` is the exception, and it is a claim rather than a
  // fact. GitHub returns an installation to the setup URL with an id anybody
  // can type, so it is written down unverified and checked at the end of the
  // authorization that follows, against what GitHub says that person holds.
  `CREATE TABLE IF NOT EXISTS oauth_states (
     state                TEXT PRIMARY KEY,
     connection_ref       TEXT NOT NULL,
     guild_ref            TEXT,
     code_verifier        TEXT,
     return_url           TEXT,
     claimed_installation BIGINT,
     expires_at           TIMESTAMPTZ NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS oauth_states_expires_at ON oauth_states (expires_at)`,

  `CREATE TABLE IF NOT EXISTS workspaces (
     app_install_id  BIGINT PRIMARY KEY,
     guild_ref       TEXT,
     owner           TEXT NOT NULL,
     repos           TEXT[],
     installation_id BIGINT,
     updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,

  `CREATE INDEX IF NOT EXISTS workspaces_installation
     ON workspaces (installation_id)`,

  `CREATE INDEX IF NOT EXISTS workspaces_owner ON workspaces (lower(owner))`,

  `CREATE TABLE IF NOT EXISTS subscriptions (
     id         BIGSERIAL PRIMARY KEY,
     guild_ref  TEXT NOT NULL,
     subscriber TEXT NOT NULL,
     target_url TEXT NOT NULL,
     secret     TEXT NOT NULL,
     endpoints  TEXT[] NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,

  `CREATE INDEX IF NOT EXISTS subscriptions_guild ON subscriptions (guild_ref)`,

  `CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_target
     ON subscriptions (guild_ref, subscriber, target_url)`,

  `CREATE TABLE IF NOT EXISTS delegation_tokens (
     jti        TEXT PRIMARY KEY,
     expires_at TIMESTAMPTZ NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS delegation_tokens_expires
     ON delegation_tokens (expires_at)`,
];

export const SCHEMA: SchemaStep[] = [
  { name: "0001-initial", statements: INITIAL, risk: "additive" },
];

const fingerprintOf = (statements: string[]): string =>
  createHash("sha256").update(statements.join(";")).digest("hex").slice(0, 16);

export class SchemaMismatchError extends Error {}

/**
 * Advisory lock id for the whole migration, so two replicas booting together
 * do not both try to apply the same step. One waits; by the time it looks, the
 * steps are recorded as applied and it has nothing to do.
 *
 * Transaction-scoped, so COMMIT or ROLLBACK releases it -- a crash part way
 * through cannot leave it held. The id is arbitrary and fixed; only this
 * module takes it.
 */
const MIGRATION_LOCK = 4_713_099_001;

export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Before reading what is applied, so two replicas cannot both decide a
    // step is outstanding and both run it.
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_steps (
         name        TEXT PRIMARY KEY,
         fingerprint TEXT NOT NULL,
         applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
       )`
    );

    await adoptLegacyStamp(client);

    const applied = new Map(
      (
        await client.query<{ name: string; fingerprint: string }>(
          "SELECT name, fingerprint FROM schema_steps"
        )
      ).rows.map((row) => [row.name, row.fingerprint])
    );

    // A step this build has never heard of means the database was written by a
    // NEWER build. Rolling back the code without rolling back the database is
    // how a column silently stops being written to, so it stops here.
    const known = new Set(SCHEMA.map((step) => step.name));
    const ahead = [...applied.keys()].filter((name) => !known.has(name)).sort();
    if (ahead.length > 0) {
      throw new SchemaMismatchError(
        `this database has schema steps this build does not know about ` +
          `(${ahead.join(", ")}). It was written by a newer version of this ` +
          `app. Deploy that version, or remove those rows from schema_steps ` +
          `only after undoing what they did by hand.`
      );
    }

    for (const step of SCHEMA) {
      const stepName = step.name;
      if (step.risk !== "additive" && step.risk !== "destructive") {
        throw new SchemaMismatchError(
          `schema step ${stepName} does not classify its data risk. Set risk ` +
            `to additive, or to destructive and document what is lost.`
        );
      }
      if (step.risk === "destructive" && step.dataLoss.trim() === "") {
        throw new SchemaMismatchError(
          `destructive schema step ${step.name} must document what data is lost`
        );
      }

      const fingerprint = fingerprintOf(step.statements);
      const stored = applied.get(step.name);

      if (stored !== undefined) {
        // Already applied. Its statements must not have changed since, because
        // re-running them is not what would happen -- nothing would, and the
        // database would quietly stop matching the code.
        if (stored !== fingerprint) {
          throw new SchemaMismatchError(
            `schema step ${step.name} has been edited since it was applied ` +
              `(the database recorded ${stored}, this build computes ` +
              `${fingerprint}). An applied step is history and cannot change. ` +
              `Append a new step that makes the difference instead.`
          );
        }
        continue;
      }

      for (const statement of step.statements) {
        await client.query(statement);
      }
      await client.query(
        "INSERT INTO schema_steps (name, fingerprint) VALUES ($1, $2)",
        [step.name, fingerprint]
      );
    }

    await blockPreviousSchemaBuilds(client);

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Once a later step exists, the single-fingerprint build cannot safely run.
 * It does not know `schema_steps`, so leave a value in the table it does know
 * that can never equal one of its hexadecimal schema fingerprints.
 *
 * The original 0001 fingerprint remains preserved in `schema_steps`; this
 * compatibility marker changes only the obsolete guard's view of the schema.
 */
async function blockPreviousSchemaBuilds(client: PoolClient): Promise<void> {
  if (SCHEMA.length < 2) return;

  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_version (
       id          BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
       fingerprint TEXT NOT NULL,
       applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );
  const marker = `schema-steps:${SCHEMA.at(-1)?.name}`;
  await client.query(
    `INSERT INTO schema_version (fingerprint) VALUES ($1)
     ON CONFLICT (id) DO UPDATE
       SET fingerprint = EXCLUDED.fingerprint,
           applied_at = now()
       WHERE schema_version.fingerprint <> EXCLUDED.fingerprint`,
    [marker]
  );
}

/**
 * Take over a database stamped by the single-fingerprint scheme this replaced.
 *
 * Those databases hold members' GitHub credentials, so the upgrade has to be
 * something they live through rather than something they are recreated for.
 * The old stamp is the fingerprint of exactly the statements that are now step
 * 0001, so a match means the schema in front of us IS 0001 and can be recorded
 * as applied without running anything.
 *
 * A stamp that does NOT match is the old guard doing its job: the database was
 * built by a version whose statements differed, and this build cannot tell
 * what from what. It refuses, as it did before.
 *
 * `schema_version` is left in place. Dropping it is a destructive statement on
 * a database we are here to preserve, and it costs one unused table to be sure.
 */
async function adoptLegacyStamp(client: PoolClient): Promise<void> {
  const alreadyRecorded = await client.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM schema_steps"
  );
  if (alreadyRecorded.rows[0]?.count !== "0") return;

  // Two queries, not one with a guard in its WHERE clause: Postgres resolves
  // the relation when it PARSES the statement, so a `to_regclass(...) IS NOT
  // NULL` condition in the same query still fails with "relation does not
  // exist". Found by running it against a fresh database.
  const legacyTable = await client.query<{ present: boolean }>(
    "SELECT to_regclass('public.schema_version') IS NOT NULL AS present"
  );
  if (!legacyTable.rows[0]?.present) return;

  const legacy = await client.query<{ fingerprint: string }>(
    "SELECT fingerprint FROM schema_version"
  );
  const stamp = legacy.rows[0]?.fingerprint;
  if (stamp === undefined) return;

  const initial = SCHEMA[0];
  const expected = fingerprintOf(initial.statements);
  if (stamp !== expected) {
    throw new SchemaMismatchError(
      `this database was built by a different version of src/db.ts ` +
        `(it says ${stamp}, this build's first step is ${expected}). There is ` +
        `no automatic path from there: reconcile the difference by hand and ` +
        `set schema_version.fingerprint to ${expected}, or drop the database ` +
        `and let it be recreated.`
    );
  }

  await client.query(
    "INSERT INTO schema_steps (name, fingerprint) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING",
    [initial.name, expected]
  );
}

export async function close(): Promise<void> {
  await pool.end();
}

let vault: ReturnType<typeof createVault> | null = null;

export const seal = (value: string): string =>
  (vault ??= createVault(config.encryptionKey)).seal(value);

export const open = (value: string): string | null =>
  (vault ??= createVault(config.encryptionKey)).open(value);
