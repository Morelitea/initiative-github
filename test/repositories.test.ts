/**
 * Which repository a call is about, when an install names several.
 *
 * The whole multi-repository design turns on this one function, and so does the
 * boundary it can and cannot draw.
 *
 * **What it enforces**: every call stays inside the list a guild admin wrote
 * down. That list is the boundary in full — it is what a delivery is matched
 * against and what a call is resolved against — so the two cannot drift.
 *
 * **What it cannot**: keeping one team out of another team's repository. A
 * context token names a guild and an install and nothing finer, so this code
 * cannot see teams at all. What pins one initiative to one repository is the
 * `repo` on its dashboard's binding, and what protects that is who may edit the
 * dashboard. Worth being exact about, because "the app checks it" and "the
 * configuration says it" are different promises.
 *
 * **What it never does**: ask GitHub anything. Every answer here comes from the
 * form and the binding, so a tile costs one call — the one that reads the data,
 * on the member's own credential.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveRepository } from "../src/workspace.js";
import type { StoredWorkspace } from "../src/workspace.js";

function workspace(repos: string[]): StoredWorkspace {
  return { owner: "acme", repos, installationId: 4242 };
}

/** Anything reaching the network from here is a bug this asserts against. */
function watchFetch() {
  return vi.spyOn(globalThis, "fetch");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("when nobody said which", () => {
  it("refuses to guess between several", () => {
    // The answer that makes a dashboard say which. Picking the first would be
    // a tile quietly reporting one team's numbers to another.
    expect(resolveRepository(workspace(["widgets", "gadgets"]))).toEqual({
      unavailable: "repository-required",
    });
  });

  it("refuses to guess when there is only one, which is the harder case", () => {
    // This one used to resolve, and it is the reason the inference had to go.
    // It is not wrong on the day it happens — there is one repository, and it
    // is the one meant. It is wrong on the day somebody ticks a second box at
    // GitHub, because the tile that had been answering for a year stops, and
    // nothing about the tile changed. An install grew and a dashboard broke.
    //
    // The parameter costs a dashboard one choice, once. Being right only while
    // an install stays the size it was is the thing being given up here.
    expect(resolveRepository(workspace(["gadgets"]))).toEqual({
      unavailable: "repository-required",
    });
  });

  it("says the same thing whether the name is absent, empty or spaces", () => {
    // One reason, so a widget has one branch to draw. A binding saved with the
    // field cleared is a binding that named nothing.
    for (const said of [undefined, null, "", "   "]) {
      expect(resolveRepository(workspace(["gadgets"]), said)).toEqual({
        unavailable: "repository-required",
      });
    }
  });
});

describe("when a dashboard said which", () => {
  it("takes it", () => {
    expect(resolveRepository(workspace(["widgets", "gadgets"]), "gadgets")).toEqual({
      owner: "acme",
      repo: "gadgets",
    });
  });

  it("matches the way GitHub does, and answers in GitHub's spelling", () => {
    // Names are case-insensitive there and typed by hand here, so the value
    // that goes back into a URL is the one the admin's list gave rather than
    // the one somebody typed into a dashboard.
    expect(resolveRepository(workspace(["Widgets", "gadgets"]), "widgets")).toEqual({
      owner: "acme",
      repo: "Widgets",
    });
  });

  it("refuses one outside the list the guild wrote down", () => {
    // The boundary this code does enforce. A dashboard is a definition somebody
    // edits, so it can name anything; the admin's list is what decides whether
    // anything comes back.
    expect(resolveRepository(workspace(["widgets"]), "payroll")).toEqual({
      unavailable: "repository-not-listed",
    });
  });
});

describe("when there is nothing to resolve against", () => {
  it("says not configured for an install nobody has set up", () => {
    expect(resolveRepository(null, "widgets")).toEqual({
      unavailable: "not-configured",
    });
  });

  it("says not configured for an install that named no repository", () => {
    // An empty list is an unfinished form rather than a wide one. Nothing in
    // this app reads it as "everything", so there is no reading of a blank
    // field that opens a repository the admin did not write down.
    expect(resolveRepository({ owner: "acme", repos: [], installationId: 4242 })).toEqual({
      unavailable: "not-configured",
    });
  });
});

describe("what it asks GitHub", () => {
  it("nothing, on any path", () => {
    const fetching = watchFetch();
    resolveRepository(workspace(["gadgets"]), "gadgets");
    resolveRepository(workspace(["widgets", "gadgets"]), "widgets");
    resolveRepository(workspace(["widgets"]), "payroll");
    resolveRepository(workspace([]));
    resolveRepository(null);
    expect(fetching).not.toHaveBeenCalled();
  });

  it("resolves before an organization has installed the app", () => {
    // The consequence worth having: a guild whose admin filled the form in gets
    // its dashboard without waiting on an organization owner. What still waits
    // on the installation is the webhook, which is a different surface.
    expect(
      resolveRepository(
        { owner: "acme", repos: ["gadgets"], installationId: null },
        "gadgets"
      )
    ).toEqual({ owner: "acme", repo: "gadgets" });
  });
});
