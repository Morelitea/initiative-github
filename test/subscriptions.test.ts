/**
 * Who has asked to be told, and what this app will and will not accept.
 *
 * The delegation token itself is checked in the kit, thoroughly, and there is
 * no point restating it here. What is local to this app is everything that
 * happens *after* a token verifies — the questions only this app can answer:
 *
 *   * is that guild one this app is installed in;
 *   * is that a type this app produces;
 *   * and is this subscription the caller's to change.
 *
 * Plus the two properties that are easy to have and easy to lose: a
 * re-subscribe is a replacement rather than a second delivery of everything,
 * and a one-shot token is one-shot across replicas rather than per process.
 *
 * Needs a database, because all of it is the database. `DATABASE_URL` in CI;
 * see README.md to run it locally.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { close, migrate, pool } from "../src/db.js";
import {
  listSubscriptions,
  spendToken,
  subscribe,
  unsubscribe,
} from "../src/events.js";
import { EVENT_TYPES } from "../src/github/events.js";
import { rememberWorkspace } from "../src/github/workspace.js";

const AUTO = "morelitea.auto";
const OTHER = "someone.else";
const TARGET = "https://auto.example.com/webhooks/initiative";

/** A guild with this app installed, which is what makes it subscribable. */
async function installed(guildId: number, appInstallId: number) {
  await rememberWorkspace(appInstallId, guildId, { owner: "acme", repos: [] }, 9011);
}

const request = (overrides: Record<string, unknown> = {}) => ({
  guild_id: 500,
  target_url: TARGET,
  event_types: [EVENT_TYPES[0]],
  ...overrides,
});

beforeEach(async () => {
  await migrate();
  await pool.query("TRUNCATE workspaces, event_subscriptions, delegation_tokens");
});

afterAll(async () => {
  await close();
});

describe("accepting a subscription", () => {
  it("records one and hands back the secret exactly once", async () => {
    await installed(500, 11);
    const result = await subscribe(AUTO, 500, request());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view).toMatchObject({
      guild_id: 500,
      target_url: TARGET,
      event_types: [EVENT_TYPES[0]],
    });
    expect(result.secret).toMatch(/^[0-9a-f]{64}$/);
    // Reading it back never returns it — a subscriber that loses it
    // re-subscribes rather than asking for a copy.
    const listed = await listSubscriptions(AUTO, 500);
    expect(Object.keys(listed[0])).toEqual([
      "id",
      "guild_id",
      "target_url",
      "event_types",
    ]);
  });

  it("mints a subscription id an existing receiver can parse", async () => {
    // Not cosmetic: a receiver written against Initiative's envelope refuses
    // one whose `subscription_id` is not an integer, so a uuid here could not
    // be heard at all until that receiver changed.
    await installed(500, 11);
    const result = await subscribe(AUTO, 500, request());
    expect(result.ok && Number.isInteger(result.view.id)).toBe(true);
  });

  it("keeps the secret sealed at rest", async () => {
    // It is what makes a forged delivery indistinguishable from a real one, so
    // a stray `SELECT` should not hand it over.
    await installed(500, 11);
    const result = await subscribe(AUTO, 500, request());
    const stored = await pool.query<{ secret: string }>(
      "SELECT secret FROM event_subscriptions"
    );
    expect(result.ok && stored.rows[0].secret).not.toBe(result.ok && result.secret);
    expect(stored.rows[0].secret).not.toContain(result.ok ? result.secret : "");
  });

  it("replaces rather than duplicating when the same address subscribes again", async () => {
    // A duplicate here is not harmless — it is two deliveries of every event,
    // and a subscriber re-running its own setup would accumulate them.
    await installed(500, 11);
    const first = await subscribe(AUTO, 500, request());
    const second = await subscribe(AUTO, 500, request({ event_types: [...EVENT_TYPES] }));

    expect(await listSubscriptions(AUTO, 500)).toHaveLength(1);
    expect(first.ok && second.ok && second.view.id).toBe(first.ok ? first.view.id : -1);
    expect(second.ok && second.view.event_types).toEqual([...EVENT_TYPES]);
    // And rotates the secret, which is the only way a subscriber that lost one
    // can recover.
    expect(first.ok && second.ok && second.secret).not.toBe(first.ok ? first.secret : "");
  });

  it("keeps two addresses in one guild apart", async () => {
    await installed(500, 11);
    await subscribe(AUTO, 500, request());
    await subscribe(AUTO, 500, request({ target_url: "https://auto.example.com/other" }));
    expect(await listSubscriptions(AUTO, 500)).toHaveLength(2);
  });

  it("collapses a repeated event type", async () => {
    await installed(500, 11);
    const result = await subscribe(
      AUTO,
      500,
      request({ event_types: [EVENT_TYPES[0], EVENT_TYPES[0]] })
    );
    expect(result.ok && result.view.event_types).toEqual([EVENT_TYPES[0]]);
  });
});

describe("what it refuses", () => {
  it("a guild the token does not name", async () => {
    // The token names one guild. A body naming another would be a subscription
    // for a guild nobody authorized.
    await installed(500, 11);
    await installed(600, 12);
    expect(await subscribe(AUTO, 500, request({ guild_id: 600 }))).toEqual({
      ok: false,
      status: 403,
      error: "that token is for another guild",
    });
    expect(await listSubscriptions(AUTO, 600)).toHaveLength(0);
  });

  it("a guild that does not have this app", async () => {
    // Not a permission check — the platform made that decision when the guild
    // installed the app — but the answer to "is there anything here for you".
    expect(await subscribe(AUTO, 500, request())).toEqual({
      ok: false,
      status: 404,
      error: "this app is not installed in that guild",
    });
  });

  it("a type this app does not produce", async () => {
    // Stored inert it would never fire, and the subscriber would have no way to
    // find out — which is the failure this whole surface exists to stop.
    await installed(500, 11);
    const result = await subscribe(
      AUTO,
      500,
      request({ event_types: ["app.morelitea.github.issue-teleported"] })
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.status).toBe(400);
  });

  it("an address it would not post to", async () => {
    await installed(500, 11);
    for (const target of [
      "http://localhost:9000/in",
      "http://169.254.169.254/latest/meta-data/",
      "file:///etc/passwd",
      "not a url",
    ]) {
      const result = await subscribe(AUTO, 500, request({ target_url: target }));
      expect(result.ok, target).toBe(false);
    }
    expect(await listSubscriptions(AUTO, 500)).toHaveLength(0);
  });

  it("a body that is not a subscription at all", async () => {
    await installed(500, 11);
    for (const body of [null, "a string", {}, request({ event_types: [] })]) {
      expect((await subscribe(AUTO, 500, body)).ok).toBe(false);
    }
  });
});

describe("whose subscription it is", () => {
  it("shows a delegate only its own", async () => {
    await installed(500, 11);
    await subscribe(AUTO, 500, request());
    await subscribe(OTHER, 500, request());

    expect(await listSubscriptions(AUTO, 500)).toHaveLength(1);
    expect(await listSubscriptions(OTHER, 500)).toHaveLength(1);
    // Two rows, same address, same guild, different delegates — so one is not
    // a replacement of the other.
    const all = await pool.query("SELECT 1 FROM event_subscriptions");
    expect(all.rowCount).toBe(2);
  });

  it("shows a delegate only the guild it asked about", async () => {
    await installed(500, 11);
    await installed(600, 12);
    await subscribe(AUTO, 500, request());
    await subscribe(AUTO, 600, request({ guild_id: 600 }));

    expect(await listSubscriptions(AUTO, 500)).toHaveLength(1);
    expect((await listSubscriptions(AUTO, 500))[0].guild_id).toBe(500);
  });

  it("will not let one delegate delete another's", async () => {
    // Matched on the delegate and the guild as well as the id, so guessing a
    // number reaches nothing — and the delegate is the registration whose
    // published key verified the call, not a name the caller typed.
    await installed(500, 11);
    const mine = await subscribe(AUTO, 500, request());
    expect(mine.ok).toBe(true);
    if (!mine.ok) return;

    expect(await unsubscribe(OTHER, 500, mine.view.id)).toBe(false);
    expect(await listSubscriptions(AUTO, 500)).toHaveLength(1);

    expect(await unsubscribe(AUTO, 500, mine.view.id)).toBe(true);
    expect(await listSubscriptions(AUTO, 500)).toHaveLength(0);
  });

  it("will not let a delegate delete across guilds", async () => {
    await installed(500, 11);
    await installed(600, 12);
    const mine = await subscribe(AUTO, 500, request());
    expect(mine.ok).toBe(true);
    if (!mine.ok) return;

    expect(await unsubscribe(AUTO, 600, mine.view.id)).toBe(false);
    expect(await listSubscriptions(AUTO, 500)).toHaveLength(1);
  });

  it("reports an id that was never there the same as one it may not touch", async () => {
    await installed(500, 11);
    expect(await unsubscribe(AUTO, 500, 999_999)).toBe(false);
  });
});

describe("spending a one-shot token", () => {
  const later = Math.floor(Date.now() / 1000) + 900;

  it("takes it once", async () => {
    expect(await spendToken("jti-1", later)).toBe(true);
    expect(await spendToken("jti-1", later)).toBe(false);
  });

  it("settles a race in the database rather than in this process", async () => {
    // The insert *is* the check. Reading first and then writing would let both
    // through, which is the whole failure a one-shot token exists to stop —
    // and two replicas would not see each other's read at all.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => spendToken("jti-raced", later))
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("sweeps what has expired, so the table tracks what is live", async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    await spendToken("jti-old", past);
    // The sweep runs on use, which is when the table grows.
    await spendToken("jti-new", later);

    const rows = await pool.query<{ jti: string }>("SELECT jti FROM delegation_tokens");
    expect(rows.rows.map((row) => row.jti)).toEqual(["jti-new"]);
  });
});
