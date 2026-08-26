/**
 * Writing at GitHub, and the two things that keeps honest.
 *
 * The surface is the only one in this app that mutates anything, so it is worth
 * being specific about what the tests are for. Not "does the HTTP call work" —
 * that is a URL and GitHub's problem. These pin the two properties that would
 * be silently wrong rather than loudly broken:
 *
 *   * **The set is closed.** A caller picks from endpoints written here and
 *     cannot describe a request the app performs. That is the difference
 *     between an integration and a proxy.
 *   * **The actor is whoever the endpoint says, and is always reported.** A
 *     write that ran as the app when the caller expected a person is a
 *     different act, and an app that does not say so is lying by omission.
 *
 * Needs a database, because resolving the guild's repository is the database.
 * `DATABASE_URL` in CI; see README.md to run it locally.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseInvoke } from "initiative-app-kit";

import { close, migrate, pool } from "../src/db.js";
import {
  chooseActor,
  failed,
  run,
  type Actor,
} from "../src/github/writes.js";
import { rememberWorkspace, workspaceFor } from "../src/github/workspace.js";
import { WRITE_ENDPOINTS, WRITE_IDS } from "../src/manifest.config.js";

const MEMBER: Actor = { kind: "member", token: "member-token" };
// No endpoint declares this kind, and it is here so `run` is exercised with an
// actor it did not choose for itself: it takes whatever it is handed, and the
// choosing is `chooseActor`'s job and tested there.
const APP: Actor = { kind: "installation", token: "installation-token" };

/**
 * Every request that went out, so a test can assert on the call not the mock.
 *
 * The installation plumbing is filtered out — minting a token and listing what
 * the organization granted happen on the way to every endpoint, and are the
 * read path's business rather than this one's.
 */
const sent: Array<{ url: string; method: string; body: unknown; auth: string }> = [];

const PLUMBING = /\/app\/installations\/|\/installation\/repositories/;

function github(answer: (url: string) => { status: number; body?: unknown }) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const address = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;

    // Every write resolves which repository it is about the same way a read
    // does, which means minting an installation token and asking GitHub what
    // the organization actually granted. Answered here so each test can be
    // about its own call.
    if (address.includes("/app/installations/")) {
      return Response.json({ token: "ghs_installation", expires_at: "2099-01-01T00:00:00Z" });
    }
    if (address.includes("/installation/repositories")) {
      return Response.json({ repositories: [{ name: "widgets" }, { name: "gadgets" }] });
    }

    if (!PLUMBING.test(address)) {
      sent.push({
        url: address,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        auth: headers.Authorization ?? "",
      });
    }
    const { status, body } = answer(address);
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
    });
  });
}

/** A guild with the app installed on one repository. */
async function installed() {
  await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets"] }, 9011);
  return workspaceFor(11);
}

beforeEach(async () => {
  await migrate();
  await pool.query("TRUNCATE workspaces, subscriptions, delegation_tokens");
  sent.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await close();
});

describe("the closed set", () => {
  it("declares every operation under this app's own name", () => {
    // Two apps offering `open-issue` would be two different things under one
    // name, and a caller resolving the wrong one would do the wrong thing
    // successfully — which is worse than an error.
    for (const operation of WRITE_ENDPOINTS) {
      expect(operation.id.startsWith("app.morelitea.github.")).toBe(true);
    }
    expect(new Set(WRITE_ENDPOINTS.map((o) => o.id)).size).toBe(WRITE_ENDPOINTS.length);
  });

  it("refuses anything not on it, before any credential is chosen", () => {
    expect(parseInvoke({ operation: "app.morelitea.github.rm-rf", guild_id: 1 }, WRITE_ENDPOINTS).ok)
      .toBe(false);
    // Including a real GitHub capability this app deliberately does not offer.
    expect(parseInvoke({ operation: "app.morelitea.github.delete-repo", guild_id: 1 }, WRITE_ENDPOINTS).ok)
      .toBe(false);
  });

  it("names every operation in WRITE_IDS, and no orphans either way", () => {
    // The dispatch switches on these, so an id in one and not the other is
    // either an endpoint nothing runs or a branch nothing can reach.
    expect(WRITE_ENDPOINTS.map((o) => o.id).sort()).toEqual(Object.values(WRITE_IDS).sort());
  });
});

describe("who the write runs as", () => {
  const openIssue = WRITE_ENDPOINTS.find((o) => o.id === WRITE_IDS.openIssue)!;
  const project = WRITE_ENDPOINTS.find((o) => o.id === WRITE_IDS.moveProjectItem)!;

  it("declares no operation that runs as anything but the member", async () => {
    // The rule, asserted on the declarations rather than on one code path. A
    // write the app performs on its own credential reaches whatever the
    // organization granted, which is not the same set as what the person whose
    // automation fired it may touch — an escalation with a scheduler in front
    // of it.
    for (const operation of WRITE_ENDPOINTS) {
      expect(operation.actors, operation.id).toEqual(["member"]);
    }
  });

  it("runs on the member's credential", async () => {
    const actor = await chooseActor(openIssue, { member: async () => "member-token" });
    expect(failed(actor) === false && actor).toMatchObject({ kind: "member" });
  });

  it("refuses rather than substituting, when the member cannot be resolved", async () => {
    // Running it as the app would look like success and would be a different
    // act by a different party, which is the sort of difference nobody notices
    // until they are reading an audit log wondering who closed something.
    const actor = await chooseActor(openIssue, { member: async () => null });
    expect(failed(actor)).toBe(true);
    expect(failed(actor) && actor.error).toMatch(/runs as the member/);
  });

  it("refuses even where an installation credential exists", async () => {
    // Offered and not taken: the operation declares one actor, so a supplier
    // for another kind is not a fallback, it is unreachable.
    const installation = vi.fn(async () => "installation-token");
    const actor = await chooseActor(openIssue, { member: async () => null, installation });
    expect(failed(actor)).toBe(true);
    expect(installation).not.toHaveBeenCalled();
  });

  it("holds for the organization-scoped one too", async () => {
    // A Projects v2 board belongs to the organization, which is the argument
    // for running this as the member: a board a member cannot see is one they
    // should not be moving cards on.
    const actor = await chooseActor(project, { member: async () => "member-token" });
    expect(failed(actor) === false && actor).toMatchObject({ kind: "member" });
  });

  it("says so when the app supplies no credential of the kind at all", async () => {
    const actor = await chooseActor(openIssue, {});
    expect(failed(actor)).toBe(true);
  });
});

describe("what it does at GitHub", () => {
  it("opens an issue on the member's own credential, and reports that", async () => {
    const workspace = await installed();
    github(() => ({ status: 201, body: { number: 42, html_url: "https://gh/42", id: 9 } }));

    const result = await run(WRITE_IDS.openIssue, MEMBER, workspace, {
      title: "It broke",
      body: "here is how",
      labels: ["bug"],
    });

    expect(failed(result)).toBe(false);
    expect(failed(result) === false && result).toEqual({
      actor: "member",
      // Identifiers only. The issue body went to GitHub; it does not come back
      // through this app to whoever asked.
      result: { number: 42, html_url: "https://gh/42", id: 9 },
    });
    expect(sent[0]).toMatchObject({
      url: "https://api.github.com/repos/acme/widgets/issues",
      method: "POST",
      auth: "Bearer member-token",
      body: { title: "It broke", body: "here is how", labels: ["bug"] },
    });
  });

  it("comments on issues and pull requests through one endpoint", async () => {
    // They share a number space and a comments endpoint, which is why this is
    // one endpoint rather than two that differ by a URL segment — and why a
    // comment needs no `pull_requests` permission.
    const workspace = await installed();
    github(() => ({ status: 201, body: { id: 5, html_url: "https://gh/c/5" } }));

    const result = await run(WRITE_IDS.comment, APP, workspace, {
      number: 812,
      body: "on it",
    });

    expect(failed(result) === false && result).toEqual({
      actor: "installation",
      result: { id: 5, html_url: "https://gh/c/5" },
    });
    expect(sent[0].url).toBe("https://api.github.com/repos/acme/widgets/issues/812/comments");
  });

  it("carries a close reason, because GitHub shows the difference", async () => {
    const workspace = await installed();
    github(() => ({ status: 200, body: { number: 42, state: "closed" } }));

    await run(WRITE_IDS.closeIssue, MEMBER, workspace, {
      number: 42,
      reason: "not_planned",
    });
    expect(sent[0]).toMatchObject({
      method: "PATCH",
      body: { state: "closed", state_reason: "not_planned" },
    });

    // And refuses a reason GitHub does not know rather than passing it on.
    sent.length = 0;
    await run(WRITE_IDS.closeIssue, MEMBER, workspace, { number: 42, reason: "vibes" });
    expect(sent[0].body).toEqual({ state: "closed" });
  });

  it("reopens through the same field, which is why it is one endpoint", async () => {
    const workspace = await installed();
    github(() => ({ status: 200, body: { number: 42, state: "open" } }));
    await run(WRITE_IDS.reopenIssue, MEMBER, workspace, { number: 42 });
    expect(sent[0].body).toEqual({ state: "open" });
  });

  it("removes labels before adding them", async () => {
    // So a call that both removes and adds the same name ends with it present
    // rather than absent — which is what somebody writing `remove: ["triage"],
    // add: ["triage", "bug"]` means.
    const workspace = await installed();
    github(() => ({ status: 200, body: [] }));

    await run(WRITE_IDS.label, MEMBER, workspace, {
      number: 42,
      remove: ["triage"],
      add: ["bug"],
    });

    expect(sent.map((call) => call.method)).toEqual(["DELETE", "POST"]);
    expect(sent[0].url).toContain("/labels/triage");
    expect(sent[1].body).toEqual({ labels: ["bug"] });
  });

  it("treats removing a label that was not there as the state being asked for", async () => {
    // This operation is idempotent by design: an automation re-running should
    // not start erroring because it already did its job.
    const workspace = await installed();
    github((url) => (url.includes("/labels/") ? { status: 404, body: {} } : { status: 200, body: [] }));

    const result = await run(WRITE_IDS.label, MEMBER, workspace, {
      number: 42,
      remove: ["gone"],
      add: ["bug"],
    });
    expect(failed(result)).toBe(false);
  });

  it("requests a review through the pull-request endpoint", async () => {
    const workspace = await installed();
    github(() => ({ status: 201, body: { number: 812 } }));

    await run(WRITE_IDS.requestReview, MEMBER, workspace, {
      number: 812,
      reviewers: "alice",
    });

    expect(sent[0].url).toBe(
      "https://api.github.com/repos/acme/widgets/pulls/812/requested_reviewers"
    );
    // A bare string counts as a list of one, because that is what somebody
    // wiring up an automation will type.
    expect(sent[0].body).toEqual({ reviewers: ["alice"] });
  });

  it("moves a project card over GraphQL, naming no repository", async () => {
    // The odd one out three times over: GraphQL only, organization-scoped, and
    // by node id rather than by name.
    const workspace = await installed();
    github(() => ({
      status: 200,
      body: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_x" } } } },
    }));

    const result = await run(WRITE_IDS.moveProjectItem, APP, workspace, {
      project_id: "PVT_1",
      item_id: "PVTI_x",
      field_id: "PVTSSF_1",
      option_id: "opt_done",
    });

    expect(failed(result) === false && result).toEqual({
      actor: "installation",
      result: { item_id: "PVTI_x" },
    });
    expect(sent[0].url).toBe("https://api.github.com/graphql");
    expect((sent[0].body as { variables: unknown }).variables).toEqual({
      project: "PVT_1",
      item: "PVTI_x",
      field: "PVTSSF_1",
      option: "opt_done",
    });
  });

  it("reports a GraphQL refusal as a refusal, not as a success", async () => {
    // GraphQL answers 200 with an `errors` array, so a caller checking only the
    // status would record every failure as a completed move.
    const workspace = await installed();
    github(() => ({ status: 200, body: { errors: [{ message: "not accessible" }] } }));

    const result = await run(WRITE_IDS.moveProjectItem, APP, workspace, {
      project_id: "PVT_1",
      item_id: "PVTI_x",
      field_id: "PVTSSF_1",
      option_id: "opt_done",
    });
    expect(failed(result)).toBe(true);
    expect(failed(result) && result.error).toBe("not accessible");
  });
});

describe("what it refuses", () => {
  it("a call naming no repository when the install covers several", async () => {
    await rememberWorkspace(11, 500, { owner: "acme", repos: ["widgets", "gadgets"] }, 9011);
    const result = await run(WRITE_IDS.openIssue, MEMBER, await workspaceFor(11), {
      title: "which one?",
    });
    expect(failed(result)).toBe(true);
    expect(failed(result) && result.error).toBe("repository-required");
  });

  it("a call missing what the operation needs", async () => {
    const workspace = await installed();
    github(() => ({ status: 200, body: {} }));

    for (const [operation, params] of [
      [WRITE_IDS.openIssue, {}],
      [WRITE_IDS.comment, { number: 1 }],
      [WRITE_IDS.comment, { body: "hi" }],
      [WRITE_IDS.label, { number: 1 }],
      [WRITE_IDS.requestReview, { number: 1 }],
      [WRITE_IDS.moveProjectItem, { project_id: "PVT_1" }],
    ] as const) {
      const result = await run(operation, MEMBER, workspace, params);
      expect(failed(result), `${operation} accepted ${JSON.stringify(params)}`).toBe(true);
    }
    // And refused before reaching GitHub, every time.
    expect(sent).toHaveLength(0);
  });

  it("passes GitHub's own words through, and nothing else from the body", async () => {
    // "Resource not accessible by integration" is the most useful sentence
    // available to whoever is holding the credential. The rest of the body is
    // not passed on: it can carry repository content.
    const workspace = await installed();
    github(() => ({
      status: 403,
      body: { message: "Resource not accessible by integration", secret: "leak" },
    }));

    const result = await run(WRITE_IDS.openIssue, MEMBER, workspace, { title: "x" });
    expect(failed(result)).toBe(true);
    expect(failed(result) && result.error).toBe("Resource not accessible by integration");
    expect(JSON.stringify(result)).not.toContain("leak");
  });

  it("survives GitHub being unreachable", async () => {
    const workspace = await installed();
    github(() => {
      throw new Error("econnrefused");
    });
    const result = await run(WRITE_IDS.openIssue, MEMBER, workspace, { title: "x" });
    expect(failed(result) && result.status).toBe(502);
  });
});

describe("what a write says it hands back", () => {
  /**
   * The smallest call each write accepts.
   *
   * Every one of them, so the assertion below is about the whole surface
   * rather than the three that happened to be convenient — and the last test
   * here is what keeps the table from falling behind the declarations.
   */
  const CALLS: Record<string, Record<string, unknown>> = {
    [WRITE_IDS.openIssue]: { title: "It broke" },
    [WRITE_IDS.comment]: { number: 1, body: "here is how" },
    [WRITE_IDS.closeIssue]: { number: 1, reason: "completed" },
    [WRITE_IDS.reopenIssue]: { number: 1 },
    [WRITE_IDS.label]: { number: 1, add: ["bug"] },
    [WRITE_IDS.requestReview]: { number: 1, reviewers: ["someone"] },
    [WRITE_IDS.moveProjectItem]: {
      project_id: "PVT_1",
      item_id: "PVTI_1",
      field_id: "PVTF_1",
      option_id: "opt_1",
    },
  };

  /** A GitHub that answers every write with more than any one of them keeps. */
  function generous() {
    github((url) =>
      url.endsWith("/graphql")
        ? {
            status: 200,
            body: { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_2" } } } },
          }
        : {
            status: 200,
            body: {
              number: 42,
              html_url: "https://gh/42",
              id: 9,
              state: "closed",
              // Not an identifier, and the thing `identifiers` exists to drop.
              body: "somebody's prose",
            },
          }
    );
  }

  it("hands back nothing it did not declare", async () => {
    // The declaration is what an automation binds a later step to before this
    // app has ever run. A key that arrives undeclared cannot be wired to at
    // all, and one declared but never sent leaves that step reading nothing —
    // both silent, which is why this is asserted over every write rather than
    // spot-checked.
    const workspace = await installed();
    generous();

    for (const operation of WRITE_ENDPOINTS) {
      const result = await run(operation.id, MEMBER, workspace, CALLS[operation.id]);
      expect(failed(result), `${operation.id} refused its own smallest call`).toBe(false);

      const declared = new Set((operation.returns ?? []).map((value) => value.key));
      for (const key of Object.keys(failed(result) ? {} : result.result)) {
        expect(declared.has(key), `${operation.id} returns undeclared '${key}'`).toBe(true);
      }
    }
  });

  it("declares nothing it cannot hand back", async () => {
    // The other direction. GitHub answers above with every field any write
    // here reads, so a declared key missing from the result is a promise this
    // app cannot keep.
    const workspace = await installed();
    generous();

    for (const operation of WRITE_ENDPOINTS) {
      const result = await run(operation.id, MEMBER, workspace, CALLS[operation.id]);
      const sent = new Set(Object.keys(failed(result) ? {} : result.result));
      for (const value of operation.returns ?? []) {
        expect(sent.has(value.key), `${operation.id} promises '${value.key}' and sends nothing`)
          .toBe(true);
      }
    }
  });

  it("calls every write this app declares", () => {
    expect(Object.keys(CALLS).sort()).toEqual(WRITE_ENDPOINTS.map((o) => o.id).sort());
  });
});
