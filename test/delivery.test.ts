/**
 * An organization changed its mind, and this app finding out.
 *
 * The only deliveries this app acts on are about its own installation, and the
 * lookup they need has no equivalent on any other path: GitHub names an
 * installation, and this app has to turn that back into the guilds whose
 * dashboards are about to start or stop working.
 *
 * It has to work in both directions, and they need different handles.
 * *Removing* names an installation this app already recorded, so the lookup is
 * by installation id. *Adding* names one it has never seen — no row can name it
 * yet — and the guild sitting at `github_app_not_installed` waiting for exactly
 * this is found by the account instead. Leaving the second one out is the easy
 * mistake: everything still works, just five minutes later, and only for the
 * case somebody is watching.
 *
 * Needs a database, because the lookup *is* the database. `DATABASE_URL` in CI;
 * see README.md to run it locally.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` is hoisted above every import, so the double has to be built in a
// hoisted block too — the delivery path must get this rather than something
// that would try to reach a platform.
const { syncInstall } = vi.hoisted(() => ({
  syncInstall: vi.fn<(guildId: number) => Promise<boolean>>(async () => true),
}));
vi.mock("../src/sync.js", () => ({ syncInstall }));

import { close, migrate, pool } from "../src/db.js";
import { handleDelivery } from "../src/github/webhooks.js";
import { EMITTED } from "../src/github/emissions.js";
import { seal } from "../src/secrets.js";
import {
  installsAwaiting,
  installsForInstallation,
  rememberWorkspace,
} from "../src/github/workspace.js";

beforeEach(async () => {
  await migrate();
  await pool.query("TRUNCATE workspaces, subscriptions");
  syncInstall.mockClear();
});

afterAll(async () => {
  await close();
});

describe("turning an installation back into guilds", () => {
  it("finds the installs it answers for", async () => {
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, 9011);

    expect(await installsForInstallation(9011)).toEqual([
      { appInstallId: 11, guildId: 500 },
    ]);
    expect(await installsForInstallation(9999)).toEqual([]);
  });

  it("finds the installs still waiting for one", async () => {
    // The row an `installation.created` delivery is about, and the only handle
    // it has is the account an admin typed.
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, null);

    expect(await installsAwaiting("acme")).toEqual([
      { appInstallId: 11, guildId: 500 },
    ]);
    // Matched the way GitHub treats account names, since an admin types them.
    expect(await installsAwaiting("ACME")).toHaveLength(1);
    // And not the ones that already found an installation.
    await rememberWorkspace(12, 600, { owner: "acme", repos: ["widgets"] }, 9012);
    expect(await installsAwaiting("acme")).toHaveLength(1);
  });
});

describe("what a delivery does", () => {
  /** What GitHub sends when an organization removes the app. */
  const REMOVED = {
    action: "deleted",
    installation: { id: 9011, account: { login: "acme" } },
  };

  /** And when it adds it, before this app has ever seen that installation. */
  const ADDED = {
    action: "created",
    installation: { id: 7000, account: { login: "acme" } },
  };

  it("re-syncs the installs an installation answered for", async () => {
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, 9011);

    expect(await handleDelivery("installation", REMOVED, "d-1")).toEqual({
      resynced: 1,
      published: 0,
    });
    expect(syncInstall).toHaveBeenCalledWith(500);
  });

  it("re-syncs the guild that was waiting, when the installation is new", async () => {
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, null);

    expect(await handleDelivery("installation", ADDED, "d-2")).toEqual({
      resynced: 1,
      published: 0,
    });
    expect(syncInstall).toHaveBeenCalledWith(500);
  });

  it("re-syncs a guild once when both handles find it", async () => {
    // Named by the installation and matched by the account would be two hits on
    // one guild; a run per handle would re-sync it twice.
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, 7000);

    await handleDelivery("installation", ADDED, "d-3");

    expect(syncInstall).toHaveBeenCalledTimes(1);
  });

  it("follows a change to which repositories it may see", async () => {
    await rememberWorkspace(11, 500, { owner: "acme", repos: [] }, 7000);

    const result = await handleDelivery(
      "installation_repositories",
      {
        action: "added",
        installation: { id: 7000, account: { login: "acme" } },
        repositories_added: [{ full_name: "acme/gadgets" }],
      },
      "d-4"
    );

    expect(result).toEqual({ resynced: 1, published: 0 });
    expect(syncInstall).toHaveBeenCalledWith(500);
  });

  it("says so when the change touches nobody here", async () => {
    expect(await handleDelivery("installation", ADDED, "d-5")).toEqual({
      resynced: 0,
      published: 0,
    });
    expect(syncInstall).not.toHaveBeenCalled();
  });

  it("ignores an activity delivery it has nothing to say about", async () => {
    // This app hears every action on the deliveries it subscribed to and
    // publishes four of them. `edited`, `labeled` and a dozen more arrive and
    // stop here. Failing them would fill an organization's webhook log with red
    // for something working exactly as intended.
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, 9011);

    for (const payload of [
      { action: "labeled", installation: { id: 9011 } },
      // Subscribed to, published action, but no repository — nothing to route.
      { action: "opened", installation: { id: 9011 } },
    ]) {
      expect(await handleDelivery("issues", payload, "d-6")).toEqual({
        resynced: 0,
        published: 0,
        reason: "nothing-to-say",
      });
    }
    // And a delivery this app never asked for at all.
    expect(await handleDelivery("gollum", { action: "created" }, "d-7")).toEqual({
      resynced: 0,
      published: 0,
      reason: "nothing-to-say",
    });
    expect(syncInstall).not.toHaveBeenCalled();
  });

  it("survives a lifecycle payload with no installation in it", async () => {
    // Every real one carries it, so this could only come from something that is
    // not GitHub — and the signature already said otherwise. Answered rather
    // than thrown: a webhook endpoint that raises on an unexpected shape fails
    // the delivery, and GitHub retries a failure.
    expect(await handleDelivery("installation", { action: "created" }, "d-8")).toEqual({
      resynced: 0,
      published: 0,
      reason: "no-installation",
    });
  });
});

describe("republishing what a repository did", () => {
  /** What GitHub sends when somebody opens an issue. */
  const OPENED = {
    action: "opened",
    installation: { id: 9011 },
    repository: { name: "widgets", owner: { login: "acme" } },
    issue: {
      number: 42,
      title: "Cache the issue counts",
      html_url: "https://github.com/acme/widgets/issues/42",
      user: { login: "alice" },
      labels: [{ name: "bug" }, { name: "perf" }],
    },
  };

  /** Where the delivery goes, and what was sent there. */
  const delivered: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];

  beforeEach(() => {
    delivered.length = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      delivered.push({
        url: String(url),
        body: JSON.parse(new TextDecoder().decode(init!.body as Uint8Array)),
        headers: init!.headers as Record<string, string>,
      });
      return new Response(null, { status: 204 });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** One subscriber, wanting everything, at an address the producer will post to. */
  async function subscriber(guildId: number, types = [...EMITTED]) {
    await pool.query(
      `INSERT INTO subscriptions (guild_id, subscriber, target_url, secret, endpoints)
       VALUES ($1, 'morelitea.auto', 'https://auto.example.com/in', $2, $3)`,
      [guildId, seal("subscriber-secret"), types]
    );
  }

  it("tells the guild whose repository it was", async () => {
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, 9011);
    await subscriber(500);

    expect(await handleDelivery("issues", OPENED, "gh-delivery-1")).toEqual({
      resynced: 0,
      published: 1,
    });
    expect(delivered).toHaveLength(1);
    expect(delivered[0].url).toBe("https://auto.example.com/in");
  });

  it("sends an envelope a receiver built for Initiative can parse", async () => {
    // The whole reason the shapes come from the kit: one receiver, two kinds of
    // producer. The outer fields and the integer resource id are what an
    // existing parser checks before it reaches anything app-specific.
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, 9011);
    await subscriber(500);
    await handleDelivery("issues", OPENED, "gh-delivery-1");

    const envelope = delivered[0].body as Record<string, any>;
    expect(typeof envelope.event_id).toBe("string");
    expect(Number.isInteger(envelope.subscription_id)).toBe(true);
    expect(envelope.guild_id).toBe(500);
    expect(envelope.actor_user_id).toBeNull();

    const change = envelope.changes[0];
    expect(change.event_type).toBe("app.morelitea.github.issue-opened");
    expect(change.initiative_id).toBeNull();
    // Named as app-sourced, so a consumer knows to read the payload rather than
    // re-read a row that does not exist.
    expect(change.source).toEqual({ type: "app", public_id: "morelitea.github" });
    // And still naming a resource, which is the install rather than the issue.
    expect(change.resource).toEqual({ type: "apps", id: 11 });
  });

  it("carries what a trigger narrows itself by, and not the whole delivery", async () => {
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, 9011);
    await subscriber(500);
    await handleDelivery("issues", OPENED, "gh-delivery-1");

    // `repository` matters most: an app event names no initiative, so a payload
    // field is the only thing a guild watching several repositories can narrow
    // an automation by.
    expect((delivered[0].body as any).changes[0].payload).toEqual({
      repository: "widgets",
      owner: "acme",
      number: 42,
      title: "Cache the issue counts",
      url: "https://github.com/acme/widgets/issues/42",
      author: "alice",
      labels: ["bug", "perf"],
    });
  });

  it("gives a redelivery the id the subscriber already has", async () => {
    // GitHub signs the body and not a timestamp, so a delivery it re-sends
    // verifies again. The envelope id is derived from GitHub's delivery id, so
    // the subscriber recognises the second copy rather than acting twice.
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, 9011);
    await subscriber(500);

    await handleDelivery("issues", OPENED, "gh-delivery-1");
    await handleDelivery("issues", OPENED, "gh-delivery-1");
    expect(delivered).toHaveLength(2);
    expect((delivered[0].body as any).event_id).toBe((delivered[1].body as any).event_id);

    // A genuinely different delivery is a different event.
    await handleDelivery("issues", OPENED, "gh-delivery-2");
    expect((delivered[2].body as any).event_id).not.toBe((delivered[0].body as any).event_id);
  });

  it("tells two guilds watching the same repository, and each independently", async () => {
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, 9011);
    await rememberWorkspace(12, 600, { owner: "acme", repos: [] }, 9011);
    await subscriber(500);
    await subscriber(600);

    expect(await handleDelivery("issues", OPENED, "gh-delivery-1")).toEqual({
      resynced: 0,
      published: 2,
    });
    // Different subscriptions, so different envelope ids: each dedups on its
    // own without one guild's redelivery hiding the other's event.
    const ids = delivered.map((d) => (d.body as any).event_id);
    expect(new Set(ids).size).toBe(2);
  });

  it("says nothing to a guild that narrowed itself to another repository", async () => {
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["gadgets"] }, 9011);
    await subscriber(500);

    expect(await handleDelivery("issues", OPENED, "gh-delivery-1")).toEqual({
      resynced: 0,
      published: 0,
      reason: "unwatched",
    });
    expect(delivered).toHaveLength(0);
  });

  it("says nothing to a subscriber that did not ask for that type", async () => {
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, 9011);
    await subscriber(500, ["app.morelitea.github.issue-closed"]);

    expect(await handleDelivery("issues", OPENED, "gh-delivery-1")).toEqual({
      resynced: 0,
      published: 0,
    });
    expect(delivered).toHaveLength(0);
  });

  it("answers GitHub 200 even when the subscriber is down", async () => {
    // A subscriber that is not answering is not GitHub's problem, and asking
    // GitHub to retry would re-run every other subscriber too.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("econnrefused");
    });
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, 9011);
    await subscriber(500);

    expect(await handleDelivery("issues", OPENED, "gh-delivery-1")).toEqual({
      resynced: 0,
      published: 0,
    });
  });

  it("republishes a review request with whose review was asked for", async () => {
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, 9011);
    await subscriber(500);

    await handleDelivery(
      "pull_request",
      {
        action: "review_requested",
        installation: { id: 9011 },
        repository: { name: "widgets", owner: { login: "acme" } },
        pull_request: {
          number: 812,
          title: "Drop the unused index",
          html_url: "https://github.com/acme/widgets/pull/812",
          user: { login: "bob" },
        },
        requested_reviewer: { login: "alice" },
      },
      "gh-delivery-9"
    );

    const change = (delivered[0].body as any).changes[0];
    expect(change.event_type).toBe("app.morelitea.github.review-requested");
    expect(change.payload.reviewer).toBe("alice");
    expect(change.payload.number).toBe(812);
  });
});
