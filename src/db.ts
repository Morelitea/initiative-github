/**
 * Where this app keeps what it must not lose.
 *
 * Three tables, and each exists because a process-local map would be wrong in a
 * way that only shows up in production:
 *
 * - **`connections`** — a member's credential at GitHub, and the install they
 *   connected under. In memory, every restart silently disconnects everybody,
 *   and they would have no way to tell except that things stopped working. A GitHub App's user token expires in
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
 * tool. Tables of this shape do not earn the dependency, and an app is expected
 * to be restartable.
 *
 * Every statement is `IF NOT EXISTS`, so a replica that boots second does
 * nothing and a replica that boots first does all of it. There is deliberately
 * no column-by-column upgrade path: this app has never been deployed anywhere
 * whose database would need one, and carrying an upgrade nobody is upgrading
 * from means a schema that has to be read historically to be understood.
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
  // A GitHub App's user token is short-lived and renewable, which an OAuth
  // app's was not — so what is kept is a rotating pair and the two moments it
  // expires, rather than one durable secret.
  // `guild_id` is which install this member connected under. The app needs it
  // to tell Initiative anything about the connection — the channel is addressed
  // per guild — and a credential that lapses has to be reportable, or the
  // platform goes on believing somebody is connected while every call fails.
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
  // `code_verifier` is the PKCE half that stays on this side of the handshake
  // by definition — only its hash is sent to GitHub — so an intercepted
  // callback is worth nothing without the row.
  // `guild_id` is carried from the moment Initiative hands the member over,
  // not read back off the callback: GitHub controls that query string and
  // echoes only `state`, so a value that arrived there would be a value the
  // redirect supplied rather than one bound to this flow.
  `CREATE TABLE IF NOT EXISTS oauth_states (
     state          TEXT PRIMARY KEY,
     connection_ref TEXT NOT NULL,
     guild_id       BIGINT,
     code_verifier  TEXT,
     expires_at     TIMESTAMPTZ NOT NULL
   )`,
  // Expired states are swept on use rather than by a job: the table is small,
  // and a sweep that runs only when somebody connects cannot fall behind in a
  // way that matters.
  `CREATE INDEX IF NOT EXISTS oauth_states_expires_at ON oauth_states (expires_at)`,
  // `guild_id` is what turns a GitHub delivery, which names a repository and
  // nothing else, back into somewhere to publish. `installation_id` is which
  // GitHub installation covers it — discovered rather than typed, and held so a
  // restart does not have to ask GitHub before it can answer anything. `repos`
  // is what a guild narrowed itself to, empty meaning every repository the
  // installation covers; an array rather than a second table, because it is
  // read whole, written whole, and bounded by what one organization granted.
  `CREATE TABLE IF NOT EXISTS workspaces (
     app_install_id  BIGINT PRIMARY KEY,
     guild_id        BIGINT,
     owner           TEXT NOT NULL,
     repos           TEXT[],
     installation_id BIGINT,
     updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
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
