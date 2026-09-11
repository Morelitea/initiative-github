/**
 * What the owner actually granted, and what this app may therefore do.
 *
 * Two questions look alike and are not. **Which repositories** is settled by
 * the installation: `GET /installation/repositories` answers it, an
 * installation token cannot reach past it, and `workspaces.repos` is a copy of
 * that answer. **What may be done to them** is settled separately, by the
 * permissions an owner approved — and GitHub keeps those installation-wide.
 * There is no granting `issues: write` on one repository and `issues: read` on
 * another inside one installation, so there is no writable subset of `repos`
 * to filter down to, and nothing here should invent one.
 *
 * What there is, is drift. An app that widens what it asks for leaves every
 * existing installation on the set its owner already agreed to until an owner
 * approves the new one — so `PERMISSIONS` is a request and the mint response is
 * the answer, and only the second one is true. This pins that the app reads the
 * answer, refuses on it in a way somebody can act on, and — the part that
 * matters more — does not refuse on a question GitHub declined to answer.
 *
 * Needs a database, because resolving the guild's repository is the database.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseInvoke } from "initiative-app-kit";

import { close, migrate, pool, seal } from "../src/db.js";
import { WRITES } from "../src/endpoints/index.js";
import type { Caller } from "../src/endpoints/index.js";
import { forgetInstallationToken, grants } from "../src/github/app.js";
import { failed, type OperationFailure } from "../src/github/api.js";
import { invoke } from "../src/invoke.js";
import { WRITE_IDS } from "../src/vocabulary.js";
import { rememberWorkspace } from "../src/workspace.js";

const WRITE_DECLARATIONS = WRITES.map((write) => write.declaration);

const INSTALLATION = 9011;
const CONNECTED: Caller = { guildRef: "gapp_testguild500", appInstallId: 11, connectionRef: "ref-a" };

/** Everything the write itself sent, so a refusal can be shown to send nothing. */
let sent: string[] = [];

/**
 * GitHub, minting a token that says what it is good for.
 *
 * `permissions` is what the real mint response carries and what this is here to
 * vary; `undefined` stands for the response that arrives without the key at
 * all, which has to be told apart from one that arrives granting nothing.
 */
function github(permissions: Record<string, string> | undefined) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const address = String(url);

    if (address.includes("/access_tokens")) {
      return Response.json({
        token: "ghs_installation",
        expires_at: "2099-01-01T00:00:00Z",
        ...(permissions ? { permissions } : {}),
      });
    }
    if (address.includes("/installation/repositories")) {
      return Response.json({ repositories: [{ name: "widgets" }] });
    }

    sent.push(address);
    return Response.json({ id: 1, number: 7, html_url: "https://github.test/1" }, { status: 201 });
  });
}

/** One guild, one repository, one member who has connected. */
async function installed() {
  await rememberWorkspace(11, "gapp_testguild500", "acme", INSTALLATION, ["widgets"]);
  await pool.query(
    "INSERT INTO connections (connection_ref, guild_ref, access_token) VALUES ($1, $2, $3)",
    ["ref-a", 500, seal("member-token")]
  );
}

async function attempt(endpoint: string, params: Record<string, unknown>) {
  const asked = parseInvoke({ endpoint, guild_ref: "gapp_testguild500", params }, WRITE_DECLARATIONS);
  expect(asked.ok).toBe(true);
  return invoke(CONNECTED, asked.ok ? asked.request : ({} as never));
}

beforeEach(async () => {
  await migrate();
  await pool.query("TRUNCATE workspaces, subscriptions, delegation_tokens, connections");
  // The mint is cached in module state for the hour GitHub gives it, so a test
  // that did not clear it would be asserting against the previous test's grant.
  forgetInstallationToken(INSTALLATION);
  sent = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await close();
});

describe("reading the level, not the word", () => {
  it("counts a wider level as covering a narrower one", () => {
    // `admin` is not the string `write`, and an app matching on equality would
    // refuse the owner who granted it the most.
    expect(grants({ issues: "admin" }, "issues", "write")).toBe(true);
    expect(grants({ issues: "write" }, "issues", "write")).toBe(true);
    expect(grants({ issues: "write" }, "issues", "read")).toBe(true);
  });

  it("does not count a narrower level as covering a wider one", () => {
    expect(grants({ issues: "read" }, "issues", "write")).toBe(false);
    expect(grants({ issues: "triage" }, "issues", "write")).toBe(false);
  });

  it("says no to a permission that was never mentioned", () => {
    expect(grants({ issues: "write" }, "pull_requests", "write")).toBe(false);
    expect(grants({}, "issues", "write")).toBe(false);
  });

  it("says no to a level it does not recognise, rather than assuming", () => {
    // A word GitHub adds after this was written is not quietly read as enough,
    // in either position.
    expect(grants({ issues: "sudo" }, "issues", "write")).toBe(false);
    expect(grants({ issues: "admin" }, "issues", "sudo")).toBe(false);
  });
});

describe("a write the installation was not granted", () => {
  it("is refused with the remedy in it, rather than as GitHub's 403", () => {
    // The case this exists for: an installation still on a read-only grant
    // because nobody has approved the wider set. GitHub refuses it, but as an
    // unexplained failure — so the automation looks broken instead of
    // un-approved, and nothing tells anybody who can fix it what to do.
    return installed().then(async () => {
      github({ issues: "read", metadata: "read" });

      const outcome = (await attempt(WRITE_IDS.openIssue, {
        repo: "widgets",
        title: "A bug",
      })) as OperationFailure;

      expect(failed(outcome)).toBe(true);
      expect(outcome.status).toBe(403);
      expect(outcome.error).toContain("issues");
      expect(outcome.error).toContain("An owner has to approve");
    });
  });

  it("never reaches GitHub with it", async () => {
    // A refusal that still sent the request would be a comment posted and an
    // error reported, which is the worst of both.
    await installed();
    github({ issues: "read" });

    await attempt(WRITE_IDS.comment, { repo: "widgets", number: 7, body: "hello" });
    expect(sent).toEqual([]);
  });

  it("asks for the right permission per write, not one blanket one", async () => {
    await installed();
    github({ issues: "write", metadata: "read" });

    // Granted `issues` and not `pull_requests`, so the one that only ever
    // touches `/pulls` is refused and the one that only ever makes an issue
    // goes through.
    const review = (await attempt(WRITE_IDS.requestReview, {
      repo: "widgets",
      number: 7,
      reviewers: ["ada"],
    })) as OperationFailure;
    expect(review.error).toContain("pull_requests");

    expect(failed(await attempt(WRITE_IDS.openIssue, { repo: "widgets", title: "A bug" })))
      .toBe(false);
  });

  it("accepts either permission where GitHub itself would check either", async () => {
    // A comment, a close, a reopen and a label all go to `/issues/{number}`,
    // and whether that number is an issue or a pull request decides which
    // permission GitHub checks. An app requiring `issues` for all of them would
    // refuse a guild that granted `pull_requests` a write GitHub would allow.
    await installed();
    github({ pull_requests: "write" });

    expect(
      failed(await attempt(WRITE_IDS.comment, { repo: "widgets", number: 7, body: "hi" }))
    ).toBe(false);
  });
});

describe("a question GitHub did not answer", () => {
  it("is not read as a refusal", async () => {
    // The direction this has to lean. A mint response without a permissions
    // block is GitHub not saying, and treating that as "granted nothing" would
    // be this app inventing a restriction no owner ever set — every write in
    // every guild refused on a missing key.
    await installed();
    github(undefined);

    expect(
      failed(await attempt(WRITE_IDS.openIssue, { repo: "widgets", title: "A bug" }))
    ).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it("is not read as a refusal when there is no installation to ask about", async () => {
    // A guild whose installation is gone still has a member with a credential
    // of their own. What that reaches is GitHub's to decide, not this app's to
    // pre-empt from a workspace row.
    await rememberWorkspace(11, "gapp_testguild500", "acme", null, ["widgets"]);
    await pool.query(
      "INSERT INTO connections (connection_ref, guild_ref, access_token) VALUES ($1, $2, $3)",
      ["ref-a", 500, seal("member-token")]
    );
    github({ issues: "read" });

    expect(
      failed(await attempt(WRITE_IDS.openIssue, { repo: "widgets", title: "A bug" }))
    ).toBe(false);
  });
});
