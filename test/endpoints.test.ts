/**
 * The callable surface, and the handful of things that keep it honest.
 *
 * Not "does the HTTP call work" — that is a URL and GitHub's problem. These pin
 * what would be silently wrong rather than loudly broken:
 *
 *   * **The set is closed.** A caller picks from endpoints written here and
 *     cannot describe a request the app performs. That is the difference
 *     between an integration and a proxy.
 *   * **The actor is whoever the endpoint says, and is always reported.** A
 *     write that ran as the app when the caller expected a person is a
 *     different act, and an app that does not say so is lying by omission.
 *   * **An endpoint hands back exactly what it declared.** A key that arrives
 *     undeclared cannot be wired to at all, and one declared but never sent
 *     leaves a later step reading nothing. Both are silent.
 *   * **The boundary is the guild's list**, on every call, in both directions.
 *
 * Needs a database, because resolving the guild's repository is the database.
 * `DATABASE_URL` in CI; see README.md to run it locally.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseInvoke } from "initiative-app-kit";

import { close, migrate, pool } from "../src/db.js";
import { chooseActor, failed, resolveActor, type Actor } from "../src/github/api.js";
import {
  READS,
  READ_HANDLERS,
  WRITES,
  WRITE_HANDLERS,
  type Caller,
} from "../src/endpoints/index.js";
import { invoke } from "../src/invoke.js";
import { rememberWorkspace, workspaceFor } from "../src/workspace.js";
import { seal } from "../src/db.js";
import { READ_IDS, WRITE_IDS } from "../src/vocabulary.js";

/** What the writes say about themselves, off the list that implements them. */
const WRITE_DECLARATIONS = WRITES.map((write) => write.declaration);

/** What the reads say about themselves, off the same list that implements them. */
const READ_DECLARATIONS = READS.map((read) => read.declaration);

/** A member who has connected, and one who has not. */
const CONNECTED: Caller = { guildId: 500, appInstallId: 11, connectionRef: "ref-a" };
const STRANGER: Caller = { guildId: 500, appInstallId: 11, connectionRef: null };

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
  await rememberWorkspace(11, 500, "acme", 9011, ["widgets"]);
  return workspaceFor(11);
}

beforeEach(async () => {
  await migrate();
  await pool.query("TRUNCATE workspaces, subscriptions, delegation_tokens, connections");
  sent.length = 0;
});

/** A guild with one repository written down, and a member who has connected. */
async function connected(repos = ["widgets"]) {
  await rememberWorkspace(11, 500, "acme", 9011, repos);
  await pool.query(
    "INSERT INTO connections (connection_ref, guild_id, access_token) VALUES ($1, $2, $3)",
    ["ref-a", 500, seal("member-token")]
  );
}

/** What a read sent, as the query and variables rather than as a URL. */
function asked(index = 0) {
  return sent[index].body as { query: string; variables: Record<string, unknown> };
}

/** A GitHub that answers every GraphQL query with the same document. */
function graph(answer: unknown) {
  github(() => ({ status: 200, body: answer }));
}

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
    for (const operation of WRITE_DECLARATIONS) {
      expect(operation.id.startsWith("app.morelitea.github.")).toBe(true);
    }
    expect(new Set(WRITE_DECLARATIONS.map((o) => o.id)).size).toBe(WRITE_DECLARATIONS.length);
  });

  it("refuses anything not on it, before any credential is chosen", () => {
    expect(parseInvoke({ operation: "app.morelitea.github.rm-rf", guild_id: 1 }, WRITE_DECLARATIONS).ok)
      .toBe(false);
    // Including a real GitHub capability this app deliberately does not offer.
    expect(parseInvoke({ operation: "app.morelitea.github.delete-repo", guild_id: 1 }, WRITE_DECLARATIONS).ok)
      .toBe(false);
  });

  it("names every operation in WRITE_IDS, and no orphans either way", () => {
    // The dispatch switches on these, so an id in one and not the other is
    // either an endpoint nothing runs or a branch nothing can reach.
    expect(WRITE_DECLARATIONS.map((o) => o.id).sort()).toEqual(Object.values(WRITE_IDS).sort());
  });
});

describe("who the write runs as", () => {
  const openIssue = WRITE_DECLARATIONS.find((o) => o.id === WRITE_IDS.openIssue)!;
  const project = WRITE_DECLARATIONS.find((o) => o.id === WRITE_IDS.moveProjectItem)!;

  it("declares no operation that runs as anything but the member", async () => {
    // The rule, asserted on the declarations rather than on one code path. A
    // write the app performs on its own credential reaches whatever the
    // organization granted, which is not the same set as what the person whose
    // automation fired it may touch — an escalation with a scheduler in front
    // of it.
    for (const operation of WRITE_DECLARATIONS) {
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

    const result = await WRITE_HANDLERS[WRITE_IDS.openIssue](MEMBER, workspace, {
      title: "It broke",
      body: "here is how",
      labels: ["bug"],
    });

    expect(failed(result)).toBe(false);
    expect(failed(result) === false && result).toEqual({
      actor: "member",
      // Identifiers only. The issue body went to GitHub; it does not come back
      // through this app to whoever asked.
      //
      // `repository` is among them because the endpoint's `identity` names it:
      // an automation service tells this write apart from another repository's
      // by the pair, and it can only build one out of what comes back.
      result: { repository: "widgets", number: 42, html_url: "https://gh/42", id: 9 },
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

    const result = await WRITE_HANDLERS[WRITE_IDS.comment](APP, workspace, {
      number: 812,
      body: "on it",
    });

    // A comment is a change to the ISSUE, which is what its identity names —
    // so a flow watching issues does not re-fire on a comment it left.
    expect(failed(result) === false && result).toEqual({
      actor: "installation",
      result: { repository: "widgets", number: 812, id: 5, html_url: "https://gh/c/5" },
    });
    expect(sent[0].url).toBe("https://api.github.com/repos/acme/widgets/issues/812/comments");
  });

  it("carries a close reason, because GitHub shows the difference", async () => {
    const workspace = await installed();
    github(() => ({ status: 200, body: { number: 42, state: "closed" } }));

    await WRITE_HANDLERS[WRITE_IDS.closeIssue](MEMBER, workspace, {
      number: 42,
      reason: "not_planned",
    });
    expect(sent[0]).toMatchObject({
      method: "PATCH",
      body: { state: "closed", state_reason: "not_planned" },
    });

    // And refuses a reason GitHub does not know rather than passing it on.
    sent.length = 0;
    await WRITE_HANDLERS[WRITE_IDS.closeIssue](MEMBER, workspace, { number: 42, reason: "vibes" });
    expect(sent[0].body).toEqual({ state: "closed" });
  });

  it("reopens through the same field, which is why it is one endpoint", async () => {
    const workspace = await installed();
    github(() => ({ status: 200, body: { number: 42, state: "open" } }));
    await WRITE_HANDLERS[WRITE_IDS.reopenIssue](MEMBER, workspace, { number: 42 });
    expect(sent[0].body).toEqual({ state: "open" });
  });

  it("removes labels before adding them", async () => {
    // So a call that both removes and adds the same name ends with it present
    // rather than absent — which is what somebody writing `remove: ["triage"],
    // add: ["triage", "bug"]` means.
    const workspace = await installed();
    github(() => ({ status: 200, body: [] }));

    await WRITE_HANDLERS[WRITE_IDS.label](MEMBER, workspace, {
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

    const result = await WRITE_HANDLERS[WRITE_IDS.label](MEMBER, workspace, {
      number: 42,
      remove: ["gone"],
      add: ["bug"],
    });
    expect(failed(result)).toBe(false);
  });

  it("requests a review through the pull-request endpoint", async () => {
    const workspace = await installed();
    github(() => ({ status: 201, body: { number: 812 } }));

    await WRITE_HANDLERS[WRITE_IDS.requestReview](MEMBER, workspace, {
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

    const result = await WRITE_HANDLERS[WRITE_IDS.moveProjectItem](APP, workspace, {
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

    const result = await WRITE_HANDLERS[WRITE_IDS.moveProjectItem](APP, workspace, {
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
    await rememberWorkspace(11, 500, "acme", 9011, ["widgets", "gadgets"]);
    const result = await WRITE_HANDLERS[WRITE_IDS.openIssue](MEMBER, await workspaceFor(11), {
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
      const result = await WRITE_HANDLERS[operation](MEMBER, workspace, params);
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

    const result = await WRITE_HANDLERS[WRITE_IDS.openIssue](MEMBER, workspace, { title: "x" });
    expect(failed(result)).toBe(true);
    expect(failed(result) && result.error).toBe("Resource not accessible by integration");
    expect(JSON.stringify(result)).not.toContain("leak");
  });

  it("survives GitHub being unreachable", async () => {
    const workspace = await installed();
    github(() => {
      throw new Error("econnrefused");
    });
    const result = await WRITE_HANDLERS[WRITE_IDS.openIssue](MEMBER, workspace, { title: "x" });
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

    for (const operation of WRITE_DECLARATIONS) {
      const result = await WRITE_HANDLERS[operation.id](MEMBER, workspace, CALLS[operation.id]);
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

    for (const operation of WRITE_DECLARATIONS) {
      const result = await WRITE_HANDLERS[operation.id](MEMBER, workspace, CALLS[operation.id]);
      const sent = new Set(Object.keys(failed(result) ? {} : result.result));
      for (const value of operation.returns ?? []) {
        expect(sent.has(value.key), `${operation.id} promises '${value.key}' and sends nothing`)
          .toBe(true);
      }
    }
  });

  it("calls every write this app declares", () => {
    expect(Object.keys(CALLS).sort()).toEqual(WRITE_DECLARATIONS.map((o) => o.id).sort());
  });
});

describe("who a read is answered for", () => {
  it("says so when the member has connected nothing", async () => {
    await connected();
    graph({ data: {} });
    // An answer about them, with a remedy they own — and travelling in the body
    // rather than as a status, because a widget draws nothing from a 4xx.
    expect(
      await READ_HANDLERS[READ_IDS.getIssue](STRANGER, new URLSearchParams({ number: "1" }))
    ).toEqual({ unavailable: "not-connected" });
    expect(sent).toHaveLength(0);
  });

  it("says so before the repository, so nobody learns its name from a refusal", async () => {
    // No workspace at all, and still `not-connected`: the credential is
    // resolved first on purpose.
    graph({ data: {} });
    expect(
      await READ_HANDLERS[READ_IDS.listLabels](STRANGER, new URLSearchParams())
    ).toEqual({ unavailable: "not-connected" });
  });

  it("says so when the guild has written nothing down", async () => {
    await pool.query(
      "INSERT INTO connections (connection_ref, guild_id, access_token) VALUES ($1, $2, $3)",
      ["ref-a", 500, seal("member-token")]
    );
    graph({ data: {} });
    expect(
      await READ_HANDLERS[READ_IDS.listLabels](CONNECTED, new URLSearchParams())
    ).toEqual({ unavailable: "not-configured" });
  });

  it("prefers the member's own credential whenever they have one", async () => {
    // The order matters more than the fallback does. Answered as themselves,
    // somebody sees exactly what they can see at GitHub — so the app's own
    // credential is what happens when there is no better answer, never what
    // happens by default.
    await connected();
    graph({ data: { repository: { labels: { totalCount: 0, nodes: [] } } } });

    const asking: Caller = { ...CONNECTED, actors: ["member", "installation"] };
    asking.resolved = await resolveActor(asking);
    await READ_HANDLERS[READ_IDS.listLabels](asking, new URLSearchParams());

    expect(sent[0].auth).toBe("Bearer member-token");
  });

  it("answers a member who has connected nothing as the installation", async () => {
    // What the organization granted is a fact about the repository, and it is
    // true whether or not the person looking has ever signed in. Before this,
    // a guild could be fully set up and every tile still said "connect your
    // account" to everybody.
    await rememberWorkspace(11, 500, "acme", 9011, ["widgets"]);
    graph({ data: { repository: { labels: { totalCount: 0, nodes: [] } } } });

    const asking: Caller = { ...STRANGER, actors: ["member", "installation"] };
    asking.resolved = await resolveActor(asking);
    await READ_HANDLERS[READ_IDS.listLabels](asking, new URLSearchParams());

    expect(sent[0].auth).toBe("Bearer ghs_installation");
  });

  it("will not answer `@me` as the app, which has no me", async () => {
    // `@me` is GitHub's word for whoever the token belongs to, and an
    // installation token belongs to nobody — so a search carrying one runs as
    // a person or does not run. Narrowed off the value rather than the
    // parameter name, because it is a convention of the search syntax.
    await rememberWorkspace(11, 500, "acme", 9011, ["widgets"]);
    graph({ data: {} });

    const asked = parseInvoke(
      {
        endpoint: READ_IDS.findPullRequests,
        guild_id: 500,
        params: { review_requested: "@me" },
      },
      READ_DECLARATIONS
    );
    expect(asked.ok).toBe(true);
    const outcome = await invoke(STRANGER, asked.ok ? asked.request : ({} as never));

    expect(failed(outcome) ? null : outcome.result).toEqual({
      unavailable: "not-connected",
    });
    expect(sent).toHaveLength(0);
  });
});

describe("the boundary, on the way in", () => {
  it("refuses a repository the guild did not list", async () => {
    await connected();
    graph({ data: {} });
    expect(
      await READ_HANDLERS[READ_IDS.listLabels](CONNECTED, new URLSearchParams({ repo: "secrets" }))
    ).toEqual({ unavailable: "repository-not-listed" });
    // Refused here, so the name is never even asked about at GitHub.
    expect(sent).toHaveLength(0);
  });

  it("refuses to guess when the install covers several", async () => {
    await connected(["widgets", "gadgets"]);
    graph({ data: {} });
    expect(
      await READ_HANDLERS[READ_IDS.listLabels](CONNECTED, new URLSearchParams())
    ).toEqual({ unavailable: "repository-required" });
  });

  it("refuses a board belonging to somebody else's account", async () => {
    // A node id names a board outright, so without this check the read would
    // reach any board the member happens to be on — which is not the same set
    // as what this install is about.
    await connected();
    graph({ data: { node: { owner: { login: "someone-else" }, fields: { nodes: [] } } } });
    expect(
      await READ_HANDLERS[READ_IDS.listProjectOptions](
        CONNECTED,
        new URLSearchParams({ project_id: "PVT_1", field: "Status" })
      )
    ).toEqual({ unavailable: "project-not-listed" });
  });

  it("refuses a login that could add a qualifier of its own", async () => {
    // The one caller value that reaches a query as words. A value that could
    // close the qualifier and open another is refused rather than quoted.
    await connected();
    graph({ data: { search: { issueCount: 0, nodes: [] } } });
    expect(
      await READ_HANDLERS[READ_IDS.findPullRequests](
        CONNECTED,
        new URLSearchParams({ review_requested: "me repo:other/thing" })
      )
    ).toEqual({ unavailable: "bad-login" });
    expect(sent).toHaveLength(0);
  });

  it("takes `@me`, which is how one tile is a different list per member", async () => {
    await connected();
    graph({ data: { search: { issueCount: 1, nodes: [{ number: 8 }] } } });
    await READ_HANDLERS[READ_IDS.findPullRequests](
      CONNECTED,
      new URLSearchParams({ review_requested: "@me" })
    );
    expect(asked().variables.query).toBe(
      "repo:acme/widgets is:pr review-requested:@me is:open"
    );
  });

  it("refuses filters the search path cannot honour, rather than ignoring them", async () => {
    // A parameter accepted and silently not applied is worse than one refused:
    // the answer looks narrowed and is not.
    await connected();
    graph({ data: { search: { issueCount: 0, nodes: [] } } });
    expect(
      await READ_HANDLERS[READ_IDS.findPullRequests](
        CONNECTED,
        new URLSearchParams({ review_requested: "@me", labels: "bug" })
      )
    ).toEqual({ unavailable: "unsupported-combination" });
  });

  it("sends repository names as variables, never as part of the query", async () => {
    await connected(["widgets", "gadgets"]);
    graph({ data: { r0: { name: "widgets" }, r1: { name: "gadgets" } } });
    await READ_HANDLERS[READ_IDS.listRepositories](CONNECTED, new URLSearchParams());
    expect(asked().variables).toEqual({ owner: "acme", n0: "widgets", n1: "gadgets" });
    expect(asked().query).not.toContain("widgets");
  });
});

describe("what a read makes of the answer", () => {
  it("keeps a partial answer, because a null the caller cannot see is the answer", async () => {
    // Each repository is an aliased field. One the member cannot see comes back
    // null — often with an error beside it — and that is not a failed call.
    await connected(["widgets", "secret-thing"]);
    graph({
      data: { r0: { name: "widgets" }, r1: null },
      errors: [{ message: "Could not resolve to a Repository" }],
    });
    expect(
      await READ_HANDLERS[READ_IDS.listRepositories](CONNECTED, new URLSearchParams())
    ).toEqual({ names: ["widgets"], owner: "acme", count: 1 });
  });

  it("reports a refusal as a refusal, not as an answer", async () => {
    // GraphQL answers 200 with an `errors` array and no data, so a caller
    // checking only the status records every failure as a result.
    await connected();
    graph({ errors: [{ message: "API rate limit exceeded" }] });
    expect(
      await READ_HANDLERS[READ_IDS.listLabels](CONNECTED, new URLSearchParams())
    ).toEqual({ unavailable: "vendor-error" });
  });

  it("says `not-found` for a repository that is not there, or not theirs", async () => {
    await connected();
    graph({ data: { repository: null } });
    expect(
      await READ_HANDLERS[READ_IDS.findIssues](CONNECTED, new URLSearchParams())
    ).toEqual({ unavailable: "not-found" });
  });

  it("normalises GitHub's enums to the words the writes take", async () => {
    // `state_reason` is read off a read and handed to `close-issue`, so the two
    // have to be spelled the same way. GraphQL shouts them and REST does not.
    await connected();
    graph({
      data: {
        repository: {
          issueOrPullRequest: {
            __typename: "Issue",
            number: 7,
            state: "CLOSED",
            stateReason: "NOT_PLANNED",
          },
        },
      },
    });
    expect(
      await READ_HANDLERS[READ_IDS.getIssue](CONNECTED, new URLSearchParams({ number: "7" }))
    ).toMatchObject({ state: "closed", state_reason: "not_planned" });
  });

  it("says medium where GitHub's two halves disagree with each other", async () => {
    // GraphQL says MODERATE and the rest of GitHub says medium. The tile draws
    // the second spelling and a step compares against it.
    await connected();
    graph({
      data: {
        repository: {
          vulnerabilityAlerts: {
            totalCount: 1,
            nodes: [
              {
                number: 3,
                securityVulnerability: { severity: "MODERATE", package: { name: "qs" } },
              },
            ],
          },
        },
      },
    });
    expect(
      await READ_HANDLERS[READ_IDS.listAlerts](CONNECTED, new URLSearchParams())
    ).toMatchObject({ severities: ["medium"], packages: ["qs"] });
  });

  it("counts what came back and what matched, which are different numbers", async () => {
    await connected();
    graph({
      data: { repository: { issues: { totalCount: 240, nodes: [{ number: 1 }, { number: 2 }] } } },
    });
    expect(
      await READ_HANDLERS[READ_IDS.findIssues](CONNECTED, new URLSearchParams({ limit: "2" }))
    ).toMatchObject({ count: 2, total: 240, numbers: [1, 2] });
  });

  it("resolves a board field by the name a person reads off their own board", async () => {
    await connected();
    graph({
      data: {
        node: {
          owner: { login: "ACME" },
          fields: {
            nodes: [
              { id: "PVTSSF_1", name: "Status", options: [{ id: "opt_1", name: "In review" }] },
            ],
          },
        },
      },
    });
    expect(
      await READ_HANDLERS[READ_IDS.listProjectOptions](
        CONNECTED,
        new URLSearchParams({ project_id: "PVT_1", field: "status" })
      )
    ).toEqual({
      field_id: "PVTSSF_1",
      field_name: "Status",
      option_ids: ["opt_1"],
      option_names: ["In review"],
    });
  });

  it("treats not being on a board as a state rather than a failure", async () => {
    await connected();
    graph({
      data: {
        repository: {
          issueOrPullRequest: {
            projectItems: { nodes: [{ id: "PVTI_x", project: { id: "PVT_other" } }] },
          },
        },
      },
    });
    expect(
      await READ_HANDLERS[READ_IDS.findProjectItem](
        CONNECTED,
        new URLSearchParams({ project_id: "PVT_1", number: "7" })
      )
    ).toEqual({ unavailable: "not-on-that-board" });
  });
});

describe("what a read says it hands back", () => {
  /** The smallest call each read accepts, so the assertions cover every one. */
  const CALLS: Record<string, Record<string, string>> = {
    [READ_IDS.listRepositories]: {},
    [READ_IDS.listLabels]: {},
    [READ_IDS.getIssue]: { number: "7" },
    [READ_IDS.findIssues]: {},
    [READ_IDS.getPullRequest]: { number: "8" },
    [READ_IDS.findPullRequests]: {},
    [READ_IDS.listAlerts]: {},
    [READ_IDS.listProjects]: {},
    [READ_IDS.listProjectFields]: { project_id: "PVT_1" },
    [READ_IDS.listProjectOptions]: { project_id: "PVT_1", field: "Status" },
    [READ_IDS.findProjectItem]: { project_id: "PVT_1", number: "7" },
  };

  /** A GitHub that answers every read with every field any of them asks for. */
  function generous() {
    const node = {
      __typename: "Issue",
      number: 7,
      title: "It broke",
      url: "https://gh/7",
      state: "OPEN",
      stateReason: null,
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt: "2026-08-02T00:00:00Z",
      closedAt: null,
      author: { login: "someone" },
      milestone: { title: "v1" },
      comments: { totalCount: 2 },
      labels: { nodes: [{ name: "bug" }] },
      assignees: { nodes: [{ login: "alice" }] },
      isDraft: false,
      merged: true,
      mergedAt: "2026-08-03T00:00:00Z",
      headRefName: "fix",
      baseRefName: "main",
      changedFiles: 3,
      commits: { totalCount: 4 },
      projectItems: { nodes: [{ id: "PVTI_x", project: { id: "PVT_1" } }] },
    };
    const connection = { totalCount: 1, nodes: [node] };
    graph({
      data: {
        r0: { name: "widgets" },
        repository: {
          labels: connection,
          issues: connection,
          pullRequests: connection,
          issueOrPullRequest: node,
          pullRequest: node,
          vulnerabilityAlerts: {
            totalCount: 1,
            nodes: [
              { number: 3, securityVulnerability: { severity: "HIGH", package: { name: "qs" } } },
            ],
          },
        },
        search: { issueCount: 1, nodes: [node] },
        repositoryOwner: {
          projectsV2: {
            totalCount: 1,
            nodes: [{ id: "PVT_1", title: "Roadmap", number: 2, url: "https://gh/p/2" }],
          },
        },
        node: {
          owner: { login: "acme" },
          fields: {
            nodes: [{ id: "PVTSSF_1", name: "Status", options: [{ id: "opt_1", name: "Done" }] }],
          },
        },
      },
    });
  }

  it("hands back nothing it did not declare", async () => {
    await connected();
    generous();
    for (const read of READ_DECLARATIONS) {
      const result = await READ_HANDLERS[read.id](
        CONNECTED,
        new URLSearchParams(CALLS[read.id])
      );
      expect(result.unavailable, `${read.id} refused its own smallest call`).toBeUndefined();

      const declared = new Set((read.returns ?? []).map((value) => value.key));
      for (const key of Object.keys(result)) {
        expect(declared.has(key), `${read.id} returns undeclared '${key}'`).toBe(true);
      }
    }
  });

  it("declares nothing it cannot hand back", async () => {
    // The other direction. `unavailable` is the one exception: it is part of
    // every read's shape and is exactly what is absent when there is an answer.
    await connected();
    generous();
    for (const read of READ_DECLARATIONS) {
      const result = await READ_HANDLERS[read.id](
        CONNECTED,
        new URLSearchParams(CALLS[read.id])
      );
      const got = new Set(Object.keys(result));
      for (const value of read.returns ?? []) {
        if (value.key === "unavailable") continue;
        expect(got.has(value.key), `${read.id} promises '${value.key}' and sends nothing`)
          .toBe(true);
      }
    }
  });

  it("says which of them is a list, because a list fills no single slot", async () => {
    await connected();
    generous();
    for (const read of READ_DECLARATIONS) {
      const result = await READ_HANDLERS[read.id](
        CONNECTED,
        new URLSearchParams(CALLS[read.id])
      );
      for (const value of read.returns ?? []) {
        if (value.key === "unavailable") continue;
        expect(
          Array.isArray(result[value.key]),
          `${read.id}/${value.key} is ${value.list ? "declared" : "not declared"} a list`
        ).toBe(value.list === true);
      }
    }
  });

  it("calls every read this app declares", () => {
    expect(Object.keys(CALLS).sort()).toEqual(READ_DECLARATIONS.map((r) => r.id).sort());
  });
});
