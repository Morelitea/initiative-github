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

const WATCHING = { owner: "acme", repos: ["widgets"] };

beforeEach(async () => {
  await migrate();
  await pool.query("TRUNCATE workspaces");
});

afterAll(async () => {
  await close();
});

describe("the installation id", () => {
  it("is written down when GitHub named one", async () => {
    await rememberWorkspace(11, 500, WATCHING, 9011);
    expect((await workspaceFor(11))?.installationId).toBe(9011);
  });

  it("is cleared when GitHub said there is none", async () => {
    // An organization that uninstalled. This has to stop routing, which means
    // the absence is recorded rather than left at the last good answer.
    await rememberWorkspace(11, 500, WATCHING, 9011);
    await rememberWorkspace(11, 500, WATCHING, null);

    expect((await workspaceFor(11))?.installationId).toBeNull();
  });

  it("is kept when GitHub did not say", async () => {
    // The case with no symptom. Nothing was learned, so nothing is written:
    // the id stays, deliveries keep routing, and the next sync asks again.
    await rememberWorkspace(11, 500, WATCHING, 9011);
    await rememberWorkspace(11, 500, WATCHING, undefined);

    expect((await workspaceFor(11))?.installationId).toBe(9011);
  });

  it("is absent on a row that never had one", async () => {
    await rememberWorkspace(11, 500, WATCHING, undefined);
    expect((await workspaceFor(11))?.installationId).toBeNull();
  });
});

describe("what the form says", () => {
  it("is rewritten on every sync, learned id or not", async () => {
    // The half that is always known. An admin editing the repository list has
    // to take effect whether or not GitHub answered on the same pass.
    await rememberWorkspace(11, 500, WATCHING, 9011);
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["gadgets"] }, undefined);

    const stored = await workspaceFor(11);
    expect(stored?.repos).toEqual(["gadgets"]);
    expect(stored?.installationId).toBe(9011);
  });
});
