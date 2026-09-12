import { createHash } from "node:crypto";

import { Pool } from "pg";
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

const SCHEMA = [

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

  // A webhook delivery is accepted once. Rationale: T99.
  //
  // Primary key rather than a unique index, because the id IS the row.
  `CREATE TABLE IF NOT EXISTS webhook_deliveries (
     delivery_id TEXT PRIMARY KEY,
     seen_at     TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,

  // Bounded. GitHub gives up redelivering long before this, so anything older
  // is only taking up space.
  `CREATE INDEX IF NOT EXISTS webhook_deliveries_seen_at
     ON webhook_deliveries (seen_at)`,

  `CREATE TABLE IF NOT EXISTS delegation_tokens (
     jti        TEXT PRIMARY KEY,
     expires_at TIMESTAMPTZ NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS delegation_tokens_expires
     ON delegation_tokens (expires_at)`,
];

const FINGERPRINT = createHash("sha256")
  .update(SCHEMA.join(";"))
  .digest("hex")
  .slice(0, 16);

export class SchemaMismatchError extends Error {}

export async function migrate(): Promise<void> {
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

    if (stored !== null && stored !== FINGERPRINT) {
      throw new SchemaMismatchError(
        `this database was built by a different version of src/db.ts ` +
          `(it says ${stored}, this build is ${FINGERPRINT}). There is no ` +
          `migration path: drop the database and let it be recreated, or ` +
          `reconcile the difference by hand and update schema_version.`
      );
    }

    for (const statement of SCHEMA) {
      await client.query(statement);
    }

    await client.query(
      `INSERT INTO schema_version (fingerprint) VALUES ($1)
       ON CONFLICT (id) DO NOTHING`,
      [FINGERPRINT]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function close(): Promise<void> {
  await pool.end();
}

let vault: ReturnType<typeof createVault> | null = null;

export const seal = (value: string): string =>
  (vault ??= createVault(config.encryptionKey)).seal(value);

export const open = (value: string): string | null =>
  (vault ??= createVault(config.encryptionKey)).open(value);

/** How long a delivery id is remembered. GitHub stops redelivering well inside
 *  this window, so anything older is only taking up space. */
export const DELIVERY_MEMORY_DAYS = 7;

/**
 * Claim a delivery id. True the first time, false every time after.
 *
 * One statement, so two concurrent claims of the same id cannot both win: the
 * insert either creates the row or conflicts, and only the creating statement
 * gets a row back.
 *
 * Sweeps expired rows on the way through rather than on a timer, because a
 * timer is another thing to run and to notice has stopped.
 */
export async function claimDelivery(deliveryId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query(
      `DELETE FROM webhook_deliveries
        WHERE seen_at < now() - ($1 || ' days')::interval`,
      [String(DELIVERY_MEMORY_DAYS)]
    );
    const claimed = await client.query(
      `INSERT INTO webhook_deliveries (delivery_id)
       VALUES ($1)
       ON CONFLICT (delivery_id) DO NOTHING
       RETURNING delivery_id`,
      [deliveryId]
    );
    return claimed.rowCount === 1;
  } finally {
    client.release();
  }
}
