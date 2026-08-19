/**
 * Which repository a call is about, when an install covers several.
 *
 * The whole multi-repository design turns on this one function, and so does the
 * boundary it can and cannot draw.
 *
 * **What it enforces**: every call stays inside what the organization granted.
 * That is GitHub's answer, not this app's — an organization that installed the
 * app on two of its forty repositories granted two, and no configuration on the
 * Initiative side can widen it.
 *
 * **What it cannot**: keeping one team out of another team's repository. A
 * context token names a guild and an install and nothing finer, so this code
 * cannot see teams at all. What pins one initiative to one repository is the
 * `repo` on its dashboard's binding, and what protects that is who may edit the
 * dashboard. Worth being exact about, because "the app checks it" and "the
 * configuration says it" are different promises.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  forgetInstallation,
  forgetRepositories,
  resolveRepository,
} from "../src/github/app.js";
import type { StoredWorkspace } from "../src/github/workspace.js";

const INSTALLATION = 4242;

/** An installation covering these repositories, and a token to read them with. */
function githubGrants(names: string[]) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/access_tokens")) {
      return new Response(
        JSON.stringify({
          token: "ghs_test",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        { status: 200 }
      );
    }
    return new Response(
      JSON.stringify({ repositories: names.map((name) => ({ name })) }),
      { status: 200 }
    );
  });
}

function workspace(repos: string[]): StoredWorkspace {
  return { owner: "acme", repos, installationId: INSTALLATION };
}

afterEach(() => {
  vi.restoreAllMocks();
  forgetInstallation(INSTALLATION);
  forgetRepositories(INSTALLATION);
});

describe("when nobody said which", () => {
  it("uses the one the guild named", async () => {
    githubGrants(["widgets", "gadgets"]);
    await expect(resolveRepository(workspace(["gadgets"]))).resolves.toEqual({
      owner: "acme",
      repo: "gadgets",
    });
  });

  it("uses the one the installation covers, when the guild named none", async () => {
    // The useful default. The organization already chose when it installed the
    // app, and making an admin restate that is two copies of one decision.
    githubGrants(["widgets"]);
    await expect(resolveRepository(workspace([]))).resolves.toEqual({
      owner: "acme",
      repo: "widgets",
    });
  });

  it("refuses to guess between several", async () => {
    // The answer that makes a dashboard say which. Picking the first would be
    // a tile quietly reporting one team's numbers to another.
    githubGrants(["widgets", "gadgets"]);
    await expect(resolveRepository(workspace([]))).resolves.toEqual({
      unavailable: "repository-required",
    });
    await expect(resolveRepository(workspace(["widgets", "gadgets"]))).resolves.toEqual({
      unavailable: "repository-required",
    });
  });
});

describe("when a dashboard said which", () => {
  it("takes it", async () => {
    githubGrants(["widgets", "gadgets"]);
    await expect(resolveRepository(workspace([]), "gadgets")).resolves.toEqual({
      owner: "acme",
      repo: "gadgets",
    });
  });

  it("matches the way GitHub does, and answers in GitHub's spelling", async () => {
    // Names are case-insensitive there and typed by hand here, so the value
    // that goes back into a URL is the one GitHub gave rather than the one
    // somebody typed into a dashboard.
    githubGrants(["Widgets"]);
    await expect(resolveRepository(workspace([]), "widgets")).resolves.toEqual({
      owner: "acme",
      repo: "Widgets",
    });
  });

  it("refuses one the organization did not grant", async () => {
    // The boundary this code does enforce. A dashboard is a definition somebody
    // edits, so it can name anything; the installation is what decides whether
    // anything comes back.
    githubGrants(["widgets"]);
    await expect(resolveRepository(workspace([]), "secrets")).resolves.toEqual({
      unavailable: "repository-not-granted",
    });
  });

  it("refuses one outside the list the guild narrowed itself to", async () => {
    // Granted by the organization and still not this install's to read: an
    // admin who listed one repository meant the others were not theirs.
    githubGrants(["widgets", "payroll"]);
    await expect(resolveRepository(workspace(["widgets"]), "payroll")).resolves.toEqual({
      unavailable: "repository-not-granted",
    });
  });
});

describe("when there is nothing to resolve against", () => {
  it("says not configured before it says anything else", async () => {
    const fetching = githubGrants(["widgets"]);
    await expect(resolveRepository(null, "widgets")).resolves.toEqual({
      unavailable: "not-configured",
    });
    // And asks GitHub nothing: an install with no owner typed has no account to
    // ask about.
    expect(fetching).not.toHaveBeenCalled();
  });

  it("says not installed when no installation was found", async () => {
    const fetching = githubGrants(["widgets"]);
    await expect(
      resolveRepository({ owner: "acme", repos: [], installationId: null })
    ).resolves.toEqual({ unavailable: "not-installed" });
    expect(fetching).not.toHaveBeenCalled();
  });

  it("says not installed when the grant has gone away since", async () => {
    // Recorded as installed and GitHub now refusing: the organization removed
    // the app between the last sync and this call.
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response("{}", { status: 404 })
    );
    await expect(resolveRepository(workspace([]))).resolves.toEqual({
      unavailable: "not-installed",
    });
  });
});

describe("how often it asks", () => {
  it("reads the granted list once and reuses it", async () => {
    // Checked on every source call that names a repository, so a round trip per
    // call would put one in front of every dashboard tile.
    const fetching = githubGrants(["widgets", "gadgets"]);
    await resolveRepository(workspace([]), "widgets");
    await resolveRepository(workspace([]), "gadgets");
    // One mint, one listing, and nothing for the second call.
    expect(fetching).toHaveBeenCalledTimes(2);
  });

  it("reads it again once the delivery says it changed", async () => {
    const fetching = githubGrants(["widgets"]);
    await resolveRepository(workspace([]), "widgets");
    forgetRepositories(INSTALLATION);
    await resolveRepository(workspace([]), "widgets");
    expect(fetching).toHaveBeenCalledTimes(3);
  });
});
