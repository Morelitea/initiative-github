/**
 * What the workspace row is allowed to forget.
 *
 * It holds two different kinds of thing. The owner and the repositories come
 * from a form an admin filled in, and every sync rewrites them. The
 * installation id comes from GitHub, and the sync only sometimes learns it —
 * which makes "write down what we were told" the wrong rule for that column.
 *
 * The id is what routes a delivery back to a guild and what every guild-scoped
 * source runs on. Clearing it because a lookup failed is invisible from here
 * and looks like the app being uninstalled from over there.
 *
 * Needs a database, because the distinction is a column. `DATABASE_URL` in CI;
 * see README.md to run it locally.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { close, migrate, pool } from "../src/db.js";
import { rememberWorkspace, workspaceFor } from "../src/workspace.js";

const OWNER = "acme";
const COVERS = ["widgets"];

beforeEach(async () => {
  await migrate();
  await pool.query("TRUNCATE workspaces");
});

afterAll(async () => {
  await close();
});

describe("the installation id", () => {
  it("is written down when GitHub named one", async () => {
    await rememberWorkspace(11, 500, OWNER, 9011, COVERS);
    expect((await workspaceFor(11))?.installationId).toBe(9011);
  });

  it("is cleared when GitHub said there is none", async () => {
    // An organization that uninstalled. This has to stop routing, which means
    // the absence is recorded rather than left at the last good answer.
    await rememberWorkspace(11, 500, OWNER, 9011, COVERS);
    await rememberWorkspace(11, 500, OWNER, null, COVERS);

    expect((await workspaceFor(11))?.installationId).toBeNull();
  });

  it("is kept when GitHub did not say", async () => {
    // The case with no symptom. Nothing was learned, so nothing is written:
    // the id stays, deliveries keep routing, and the next sync asks again.
    await rememberWorkspace(11, 500, OWNER, 9011, COVERS);
    await rememberWorkspace(11, 500, OWNER, undefined, COVERS);

    expect((await workspaceFor(11))?.installationId).toBe(9011);
  });

  it("is absent on a row that never had one", async () => {
    await rememberWorkspace(11, 500, OWNER, undefined, COVERS);
    expect((await workspaceFor(11))?.installationId).toBeNull();
  });
});

describe("the boundary", () => {
  it("is replaced by what the installation now covers", async () => {
    // A repository ticked at GitHub reaches the guild on the next sync, with
    // nobody coming back through Initiative to say so.
    await rememberWorkspace(11, 500, OWNER, 9011, COVERS);
    await rememberWorkspace(11, 500, OWNER, 9011, ["widgets", "gadgets"]);

    expect((await workspaceFor(11))?.repos).toEqual(["widgets", "gadgets"]);
  });

  it("is kept when GitHub did not say what it covers", async () => {
    // The same rule the id follows, and for a bigger reason: an unanswered
    // question written down as an empty boundary is every tile in the guild
    // going dark until some later sync happens to succeed.
    await rememberWorkspace(11, 500, OWNER, 9011, COVERS);
    await rememberWorkspace(11, 500, OWNER, 9011, undefined);

    const stored = await workspaceFor(11);
    expect(stored?.repos).toEqual(COVERS);
    expect(stored?.installationId).toBe(9011);
  });

  it("is empty on a row that never learned one", async () => {
    await rememberWorkspace(11, 500, OWNER, undefined, undefined);
    expect((await workspaceFor(11))?.repos).toEqual([]);
  });
});
