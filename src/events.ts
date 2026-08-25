/**
 * The producer surface: who has asked to hear about this repository, and how
 * they are told.
 *
 * This is the half of the app an automation service talks to, and the thing
 * worth noticing about it is how little of it is about automation. This app
 * does not know what a workflow is, cannot be told to run one, and works
 * identically on a deployment that has no automation service at all — the
 * dashboard never touches this file. What it offers is a standing request:
 * *tell me when an issue opens, at this address, and sign it with this*.
 *
 * The shapes are the kit's, not this app's, and deliberately so. A subscriber
 * that can read one app's events can read every app's, because the envelope,
 * the signing and the paths come from `initiative-app-kit` rather than from
 * whoever wrote the app. What is local here is the storage and the two
 * questions only this app can answer: does that guild have this app, and is
 * that a type this app produces.
 *
 * ## Who is allowed to ask
 *
 * A delegate — an app the operator granted `delegation` to — proving it by a
 * token it signed with a key the deployment publishes. Not a context token:
 * that would say Initiative vouched for the call without saying who made it,
 * and a subscription belongs to somebody. See `initiative-app-kit`'s
 * `delegation.ts`; the parts that matter here are that the caller names itself
 * so the right key set is fetched, the signature decides whether that name was
 * true, and the token is spent once.
 *
 * ## What a guild keeps when the delegate goes away
 *
 * Nothing here deletes on a delegate's behalf and nothing here calls back to
 * one. A subscription outlives the app that made it, deliveries to an address
 * that stopped answering are recorded as failures and dropped, and the guild's
 * dashboard is unaffected by any of it.
 */

import {
  EventProducer,
  mintSubscriptionSecret,
  parseSubscribe,
  type AppEvent,
  type DeliveryOutcome,
  type EventSubscription,
} from "initiative-app-kit";

import { PUBLIC_ID } from "./public-id.js";
import { pool } from "./db.js";
import { open, seal } from "./secrets.js";
import { EVENT_TYPES } from "./github/events.js";

interface Row {
  id: string;
  guild_id: string;
  subscriber: string;
  target_url: string;
  secret: string;
  event_types: string[];
}

/**
 * `pg` hands back `BIGINT` as a string, since not every value fits a JS number.
 * A subscription id and a guild id comfortably do, so they are narrowed once
 * here — and the id has to be a number, because a receiver written against
 * Initiative's envelope refuses one that is not.
 */
function toSubscription(row: Row): EventSubscription {
  return {
    id: Number(row.id),
    guildId: Number(row.guild_id),
    subscriber: row.subscriber,
    targetUrl: row.target_url,
    // Sealed at rest like a member's credential: it is the thing that makes a
    // forged delivery indistinguishable from a real one, so a stray `SELECT`
    // should not hand it over.
    secret: open(row.secret) ?? "",
    eventTypes: row.event_types,
  };
}

/** Subscriptions in this guild that named this type. The producer's one read. */
async function matching(
  guildId: number,
  eventType: string
): Promise<EventSubscription[]> {
  const found = await pool.query<Row>(
    `SELECT id, guild_id, subscriber, target_url, secret, event_types
       FROM event_subscriptions
      WHERE guild_id = $1 AND $2 = ANY(event_types)`,
    [guildId, eventType]
  );
  // A row whose secret will not open under the current key cannot produce a
  // delivery anybody could verify, so it is left out rather than sent
  // unverifiably. The subscriber re-subscribes and gets a fresh secret.
  return found.rows.map(toSubscription).filter((sub) => sub.secret !== "");
}

/** One producer for the process, holding no state of its own. */
export const producer = new EventProducer({
  publicId: PUBLIC_ID,
  store: { matching },
});

/** Deliver one event to whoever asked for it. Never throws. */
export async function publish(event: AppEvent): Promise<DeliveryOutcome[]> {
  try {
    return await producer.publish(event);
  } catch (error) {
    // A publish that fails is not a delivery GitHub should retry: the delivery
    // arrived and was understood, and re-sending it would re-run the lookup
    // that just failed. It is logged and dropped.
    console.error(`could not publish ${event.eventType}`, error);
    return [];
  }
}

/** Whether this app is installed in that guild, and which install. */
export async function installFor(guildId: number): Promise<number | null> {
  const found = await pool.query<{ app_install_id: string }>(
    "SELECT app_install_id FROM workspaces WHERE guild_id = $1 LIMIT 1",
    [guildId]
  );
  const row = found.rows[0];
  return row ? Number(row.app_install_id) : null;
}

/** What a subscriber is told about a subscription. */
export interface SubscriptionView {
  id: number;
  guild_id: number;
  target_url: string;
  event_types: string[];
}

function view(subscription: EventSubscription): SubscriptionView {
  return {
    id: subscription.id,
    guild_id: subscription.guildId,
    target_url: subscription.targetUrl,
    event_types: subscription.eventTypes,
  };
}

/** Why a subscribe was refused, in words a caller can act on. */
export type SubscribeResult =
  | { ok: true; view: SubscriptionView; secret: string }
  | { ok: false; status: number; error: string };

/**
 * Record one subscription, or replace the one that address already had.
 *
 * Idempotent on `(guild, subscriber, address)`, which is what lets a subscriber
 * re-run its own setup without accumulating duplicates — and a duplicate here
 * would not be harmless, it would be two deliveries of every event.
 *
 * Replacing **rotates the secret**, and the new one is returned. That is the
 * only way a subscriber that lost its secret can recover, since it is stored
 * sealed and never handed out twice; the cost is that a delivery already in
 * flight under the old one fails its check, which a subscriber sees as one
 * dropped event and this app sees as a non-2xx.
 */
export async function subscribe(
  subscriber: string,
  guildId: number,
  body: unknown
): Promise<SubscribeResult> {
  const parsed = parseSubscribe(body, EVENT_TYPES);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };

  // The token names one guild; the body naming another would be a subscription
  // for a guild nobody authorized.
  if (parsed.request.guild_id !== guildId) {
    return { ok: false, status: 403, error: "that token is for another guild" };
  }
  // And a guild that does not have this app has no events to hear about. Not a
  // permission check — the platform made that decision when it installed the
  // app — but the answer to "is there anything here for you".
  if ((await installFor(guildId)) === null) {
    return { ok: false, status: 404, error: "this app is not installed in that guild" };
  }

  const secret = mintSubscriptionSecret();
  const stored = await pool.query<Row>(
    `INSERT INTO event_subscriptions (guild_id, subscriber, target_url, secret, event_types)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (guild_id, subscriber, target_url) DO UPDATE
        SET secret = EXCLUDED.secret,
            event_types = EXCLUDED.event_types,
            updated_at = now()
     RETURNING id, guild_id, subscriber, target_url, secret, event_types`,
    [guildId, subscriber, parsed.request.target_url, seal(secret), parsed.request.event_types]
  );

  return { ok: true, view: view(toSubscription(stored.rows[0])), secret };
}

/** What this subscriber has asked for in this guild. Never another's. */
export async function listSubscriptions(
  subscriber: string,
  guildId: number
): Promise<SubscriptionView[]> {
  const found = await pool.query<Row>(
    `SELECT id, guild_id, subscriber, target_url, secret, event_types
       FROM event_subscriptions
      WHERE guild_id = $1 AND subscriber = $2
      ORDER BY id`,
    [guildId, subscriber]
  );
  return found.rows.map((row) => view(toSubscription(row)));
}

/**
 * Drop one subscription.
 *
 * Matched on the subscriber and the guild as well as the id, so a delegate
 * cannot reach another's subscription by guessing a number — and `subscriber`
 * is the registration whose published key verified the call, not a name the
 * caller supplied.
 */
export async function unsubscribe(
  subscriber: string,
  guildId: number,
  id: number
): Promise<boolean> {
  const result = await pool.query(
    "DELETE FROM event_subscriptions WHERE id = $1 AND guild_id = $2 AND subscriber = $3",
    [id, guildId, subscriber]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Spend a delegation token's `jti`, or report that it has already been spent.
 *
 * The insert *is* the check: two requests racing past a read collide on the
 * primary key, and the loser gets no row. Reading first and then writing would
 * let both through, which is the whole failure a one-shot token exists to stop.
 *
 * Expired rows are swept here rather than by a job — the table only grows while
 * tokens are arriving, and a sweep that runs when they do cannot fall behind in
 * a way that matters.
 */
export async function spendToken(jti: string, expiresAt: number): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO delegation_tokens (jti, expires_at)
     VALUES ($1, to_timestamp($2))
     ON CONFLICT (jti) DO NOTHING`,
    [jti, expiresAt]
  );
  if ((result.rowCount ?? 0) === 0) return false;
  await pool.query("DELETE FROM delegation_tokens WHERE expires_at < now()");
  return true;
}
