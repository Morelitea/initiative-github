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

  `CREATE TABLE IF NOT EXISTS connections (
     connection_ref     TEXT PRIMARY KEY,
     guild_id           BIGINT,
     access_token       TEXT NOT NULL,
     refresh_token      TEXT,
     expires_at         TIMESTAMPTZ,
     refresh_expires_at TIMESTAMPTZ,
     account_label      TEXT,
     created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,

  // `flow` is what this trip was started to do, decided here when the state is
  // minted rather than inferred from what GitHub hands back. Both flows end at
  // the same callback, and they end differently: one stores a member's own
  // credential, the other records the installation an admin just made for the
  // whole guild. Reading that off a parameter GitHub may or may not send would
  // be guessing at our own intent.
  `CREATE TABLE IF NOT EXISTS oauth_states (
     state          TEXT PRIMARY KEY,
     connection_ref TEXT NOT NULL,
     guild_id       BIGINT,
     flow           TEXT NOT NULL DEFAULT 'account',
     code_verifier  TEXT,
     return_url     TEXT,
     expires_at     TIMESTAMPTZ NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS oauth_states_expires_at ON oauth_states (expires_at)`,

  `CREATE TABLE IF NOT EXISTS workspaces (
     app_install_id  BIGINT PRIMARY KEY,
     guild_id        BIGINT,
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
     guild_id   BIGINT NOT NULL,
     subscriber TEXT NOT NULL,
     target_url TEXT NOT NULL,
     secret     TEXT NOT NULL,
     endpoints  TEXT[] NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,

  `CREATE INDEX IF NOT EXISTS subscriptions_guild ON subscriptions (guild_id)`,

  `CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_target
     ON subscriptions (guild_id, subscriber, target_url)`,

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
