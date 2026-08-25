/**
 * Where this app keeps what it must not lose.
 *
 * Three tables, and each exists because a process-local map would be wrong in a
 * way that only shows up in production:
 *
 * - **`connections`** — a member's credential at GitHub. In memory, every
 *   restart silently disconnects everybody, and they would have no way to tell
 *   except that things stopped working. A GitHub App's user token expires in
 *   eight hours and is renewed with a refresh token that lasts six months, so
 *   what is kept here is a rotating pair rather than one durable secret.
 * - **`oauth_states`** — the in-flight vendor handshake. This is the one that
 *   breaks first: the browser is redirected to GitHub by one replica and comes
 *   back to whichever replica the load balancer picks, so a map makes the flow
 *   fail roughly (n-1)/n of the time behind more than one pod. It also holds
 *   the PKCE verifier, which by construction must never travel with the browser.
 * - **`workspaces`** — an install's configuration, refreshed from the platform
 *   on the lifecycle signal, plus the GitHub installation this app found for it.
 *   Cheap to refetch but not free, and losing it makes every source answer
 *   "not configured" until something re-pulls.
 * - **`event_subscriptions`** — who has asked to be told when something happens
 *   at GitHub. Nothing can rebuild these: the subscriber holds a secret this
 *   app minted and will never mint again, so losing the row means silently
 *   delivering nothing to somebody who believes they are subscribed.
 * - **`delegation_tokens`** — the ids of one-shot tokens already spent. In
 *   memory it would be per-replica, which is not a one-shot rule at all.
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
  // A GitHub App's user token is short-lived and renewable, which an OAuth
  // app's was not. Added as their own statements rather than written into the
  // CREATE above — that is the rule this list keeps, so a deployment that
  // already ran gets them too.
  `ALTER TABLE connections ADD COLUMN IF NOT EXISTS refresh_token TEXT`,
  `ALTER TABLE connections ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`,
  `ALTER TABLE connections ADD COLUMN IF NOT EXISTS refresh_expires_at TIMESTAMPTZ`,
  `CREATE TABLE IF NOT EXISTS oauth_states (
     state          TEXT PRIMARY KEY,
     connection_ref TEXT NOT NULL,
     expires_at     TIMESTAMPTZ NOT NULL
   )`,
  // The PKCE verifier. It stays on this side of the handshake by definition —
  // only its hash is sent to GitHub — so an intercepted callback is worth
  // nothing without the row.
  `ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS code_verifier TEXT`,
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
  // The guild an install belongs to, so a GitHub delivery naming only a
  // repository can be turned back into somewhere to emit. Added as its own
  // statement rather than written into the CREATE above — that is the rule
  // this list keeps, so a deployment that already ran gets it too.
  `ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS guild_id BIGINT`,
  // Which GitHub installation covers this install's repository. Discovered
  // rather than typed, and held here so a restart does not have to ask GitHub
  // again before it can answer anything.
  `ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS installation_id BIGINT`,
  // Which repositories a guild narrowed itself to, empty meaning every one the
  // installation covers. An array rather than a second table: it is read whole,
  // written whole, and bounded by what one organization granted.
  `ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS repos TEXT[]`,
  // A delivery names the installation that produced it, which is the direction
  // this is read in — see `installsWatching`.
  `CREATE INDEX IF NOT EXISTS workspaces_installation
     ON workspaces (installation_id)`,
  // And the other direction, for an install that has not found an installation
  // yet — the guild waiting for somebody to install the app on their account.
  `CREATE INDEX IF NOT EXISTS workspaces_owner ON workspaces (lower(owner))`,
  // A standing request to be told about this repository. `id` is a BIGSERIAL
  // and not a uuid on purpose: it travels in the envelope as `subscription_id`,
  // and a receiver written against Initiative's own envelope refuses one that
  // is not an integer.
  `CREATE TABLE IF NOT EXISTS event_subscriptions (
     id          BIGSERIAL PRIMARY KEY,
     guild_id    BIGINT NOT NULL,
     subscriber  TEXT NOT NULL,
     target_url  TEXT NOT NULL,
     secret      TEXT NOT NULL,
     event_types TEXT[] NOT NULL,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // The producer's only read: which subscriptions in this guild named this
  // type. Filtered in the database rather than in the app, because it is an
  // index lookup here and a scan there.
  `CREATE INDEX IF NOT EXISTS event_subscriptions_guild
     ON event_subscriptions (guild_id)`,
  // What makes re-subscribing a replacement instead of a duplicate — and a
  // duplicate here is not harmless, it is two deliveries of every event.
  `CREATE UNIQUE INDEX IF NOT EXISTS event_subscriptions_target
     ON event_subscriptions (guild_id, subscriber, target_url)`,
  // Spent one-shot tokens. The primary key is the check: two requests racing
  // collide here rather than both being let through.
  `CREATE TABLE IF NOT EXISTS delegation_tokens (
     jti        TEXT PRIMARY KEY,
     expires_at TIMESTAMPTZ NOT NULL
   )`,
  // Swept on use rather than by a job, so the sweep cannot fall behind while
  // tokens are arriving.
  `CREATE INDEX IF NOT EXISTS delegation_tokens_expires
     ON delegation_tokens (expires_at)`,
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
