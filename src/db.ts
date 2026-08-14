/**
 * Where this app keeps what it must not lose.
 *
 * Three tables, and each exists because a process-local map would be wrong in a
 * way that only shows up in production:
 *
 * - **`connections`** — a member's credential at GitHub. In memory, every
 *   restart silently disconnects everybody, and they would have no way to tell
 *   except that things stopped working.
 * - **`oauth_states`** — the in-flight vendor handshake. This is the one that
 *   breaks first: the browser is redirected to GitHub by one replica and comes
 *   back to whichever replica the load balancer picks, so a map makes the flow
 *   fail roughly (n-1)/n of the time behind more than one pod.
 * - **`workspaces`** — an install's configuration, refreshed from the platform
 *   on the lifecycle signal. Cheap to refetch but not free, and losing it makes
 *   every source answer "not configured" until something re-pulls.
 *
 * The schema is applied idempotently at boot rather than through a migration
 * tool. Two tables of this shape do not earn the dependency, and an app is
 * expected to be restartable — but the statements are additive on purpose, so a
 * new column is a new statement rather than an edit to an existing one.
 */

import { Pool } from "pg";

import { config } from "./config.js";

export const pool = new Pool({
  connectionString: config.databaseUrl,
  // A small app behind a couple of replicas; the ceiling matters more than the
  // throughput, so one pod cannot exhaust the database's connection budget.
  max: 8,
  idleTimeoutMillis: 30_000,
});

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS connections (
     connection_ref TEXT PRIMARY KEY,
     access_token   TEXT NOT NULL,
     account_label  TEXT,
     created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS oauth_states (
     state          TEXT PRIMARY KEY,
     connection_ref TEXT NOT NULL,
     expires_at     TIMESTAMPTZ NOT NULL
   )`,
  // Expired states are swept on use rather than by a job: the table is small,
  // and a sweep that runs only when somebody connects cannot fall behind in a
  // way that matters.
  `CREATE INDEX IF NOT EXISTS oauth_states_expires_at ON oauth_states (expires_at)`,
  `CREATE TABLE IF NOT EXISTS workspaces (
     app_install_id BIGINT PRIMARY KEY,
     owner          TEXT NOT NULL,
     repo           TEXT NOT NULL,
     updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
];

/** Apply the schema. Safe to run on every boot and on every replica. */
export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    // One transaction, so two replicas booting together either both see the
    // finished schema or one waits — never a half-applied one.
    await client.query("BEGIN");
    for (const statement of SCHEMA) {
      await client.query(statement);
    }
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
