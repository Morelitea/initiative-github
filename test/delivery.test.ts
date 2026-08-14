/**
 * From a repository name back to a guild.
 *
 * A GitHub delivery carries a repository and no guild — there is no guild
 * anywhere in GitHub's world. Everything that makes the trigger side work is
 * the reverse lookup this exercises, and it is the piece with no equivalent on
 * the outbound path: sources are told which install is calling, and this has to
 * work it out.
 *
 * Needs a database, because the lookup *is* the database. `DATABASE_URL` in CI;
 * see README.md to run it locally.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// `vi.mock` is hoisted above every import, so the double has to be built in a
// hoisted block too — the delivery path must get this rather than a client that
// would try to reach a platform.
const { emitEvent } = vi.hoisted(() => ({
  emitEvent: vi.fn<(guildId: number, type: string, payload: unknown) => Promise<void>>(
    async () => {}
  ),
}));
vi.mock("../src/initiative.js", () => ({ initiative: { emitEvent } }));

import { close, migrate, pool } from "../src/db.js";
import { EVENTS, handleDelivery } from "../src/github/webhooks.js";
import { installsWatching, rememberWorkspace } from "../src/github/workspace.js";

const OPENED = {
  action: "opened",
  repository: { full_name: "acme/widgets" },
  issue: {
    number: 42,
    title: "Something is broken",
    html_url: "https://github.com/acme/widgets/issues/42",
    labels: [{ name: "bug" }],
  },
};

beforeEach(async () => {
  await migrate();
  await pool.query("TRUNCATE workspaces");
  emitEvent.mockClear();
});

afterAll(async () => {
  await close();
});

describe("which installs asked about this repository", () => {
  it("finds the install that named it", async () => {
    await rememberWorkspace(11, 500, { owner: "acme", repo: "widgets" });

    expect(await installsWatching("acme", "widgets")).toEqual([
      { appInstallId: 11, guildId: 500 },
    ]);
  });

  it("matches the way GitHub does, not the way an admin typed it", async () => {
    await rememberWorkspace(11, 500, { owner: "Acme", repo: "Widgets" });

    expect(await installsWatching("acme", "widgets")).toHaveLength(1);
  });

  it("finds nobody for a repository no install named", async () => {
    await rememberWorkspace(11, 500, { owner: "acme", repo: "widgets" });

    expect(await installsWatching("acme", "gadgets")).toEqual([]);
  });

  it("keeps one row per install as its configuration changes", async () => {
    await rememberWorkspace(11, 500, { owner: "acme", repo: "widgets" });
    await rememberWorkspace(11, 500, { owner: "acme", repo: "gadgets" });

    expect(await installsWatching("acme", "widgets")).toEqual([]);
    expect(await installsWatching("acme", "gadgets")).toHaveLength(1);
  });
});

describe("where a delivery goes", () => {
  it("emits into the guild watching the repository", async () => {
    await rememberWorkspace(11, 500, { owner: "acme", repo: "widgets" });

    expect(await handleDelivery("issues", OPENED)).toEqual({ emitted: 1 });
    expect(emitEvent).toHaveBeenCalledWith(500, EVENTS.issueOpened, {
      issue_number: 42,
      issue_title: "Something is broken",
      issue_url: "https://github.com/acme/widgets/issues/42",
      issue_labels: ["bug"],
    });
  });

  it("emits into every guild watching it", async () => {
    // Two guilds can both watch one public repository, and each is entitled to
    // its own event — neither knows the other exists.
    await rememberWorkspace(11, 500, { owner: "acme", repo: "widgets" });
    await rememberWorkspace(12, 600, { owner: "acme", repo: "widgets" });

    expect(await handleDelivery("issues", OPENED)).toEqual({ emitted: 2 });
    expect(emitEvent.mock.calls.map((call) => call[0])).toEqual([500, 600]);
  });

  it("emits nothing for a repository nobody installed against", async () => {
    await rememberWorkspace(11, 500, { owner: "acme", repo: "gadgets" });

    expect(await handleDelivery("issues", OPENED)).toEqual({
      emitted: 0,
      reason: "no-install",
    });
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("emits nothing for a verb no trigger asked about", async () => {
    await rememberWorkspace(11, 500, { owner: "acme", repo: "widgets" });

    expect(await handleDelivery("issues", { ...OPENED, action: "labeled" })).toEqual({
      emitted: 0,
      reason: "unhandled",
    });
    // Checked before the lookup, so a repository that sends a hundred verbs a
    // day does not cost a query for each.
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("emits nothing when the payload names no repository", async () => {
    await rememberWorkspace(11, 500, { owner: "acme", repo: "widgets" });
    const { repository: _dropped, ...noRepo } = OPENED;

    expect(await handleDelivery("issues", noRepo)).toEqual({
      emitted: 0,
      reason: "no-repository",
    });
  });

  it("still reaches the second guild when the first one refuses", async () => {
    // A guild that disabled the app refuses its event. Retrying the delivery to
    // reach the others would deliver it twice everywhere it already landed, so
    // the failure is counted and stepped over.
    await rememberWorkspace(11, 500, { owner: "acme", repo: "widgets" });
    await rememberWorkspace(12, 600, { owner: "acme", repo: "widgets" });
    emitEvent.mockRejectedValueOnce(new Error("refused"));

    expect(await handleDelivery("issues", OPENED)).toEqual({ emitted: 1 });
    expect(emitEvent).toHaveBeenCalledTimes(2);
  });
});
