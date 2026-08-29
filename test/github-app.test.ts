/**
 * The other registration, and the two ways it silently stops matching the code.
 *
 * This app is registered twice, by two people, for two audiences. Initiative's
 * registration is checked continuously — the document is fetched, hashed and
 * re-verified — so drift there is loud. GitHub's is a *form*, filled in once and
 * then invisible, and it fails in two directions that both look like nothing
 * happening:
 *
 *   * an event the code handles but nobody subscribed to simply never arrives;
 *   * a URL the code moved and the form did not is a redirect mismatch at
 *     GitHub, at the moment somebody tries to connect.
 *
 * A permission is worse than either, because it cannot be quietly corrected:
 * widening one asks every organization that already installed the app to
 * approve it again, and until they do the app keeps the grant it had.
 *
 * So the registration is generated from constants, and this is what checks
 * those constants against what the code actually does.
 */

import { createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";

import { config } from "../src/config.js";
import { appJwt } from "../src/github/app.js";
import { SUBSCRIBED_EVENTS } from "../src/endpoints/emissions.js";
import {
  HOMEPAGE,
  PERMISSIONS,
  githubAppManifest,
} from "../src/github/app.js";
import { WRITES } from "../src/endpoints/index.js";
import { READ_IDS, WRITE_IDS } from "../src/vocabulary.js";
import { manifest } from "../src/manifest.config.js";
import {
  CALLBACK_PATH,
  CONNECT_PATH,
  INSTALL_PATH,
  SETUP_PATH,
  VERIFY_PATH,
  WEBHOOK_PATH,
} from "../src/vocabulary.js";

const PUBLIC_URL = config.publicUrl;
const registration = githubAppManifest(PUBLIC_URL);

/** What the writes say about themselves, off the list that implements them. */
const WRITE_DECLARATIONS = WRITES.map((write) => write.declaration);

describe("saying who this app is", () => {
  it("signs a JWT the private key actually backs", () => {
    // The one assertion that proves the whole ladder: everything this app does
    // as itself is minted from this signature, so a key that does not verify is
    // an app that can reach no installation at all.
    const [header, payload, signature] = appJwt().split(".");
    expect(
      createVerify("RSA-SHA256")
        .update(`${header}.${payload}`)
        .verify(process.env.TEST_GITHUB_APP_PUBLIC_KEY!, Buffer.from(signature, "base64url"))
    ).toBe(true);
  });

  it("uses the algorithm GitHub accepts and no other", () => {
    const header = JSON.parse(
      Buffer.from(appJwt().split(".")[0], "base64url").toString()
    );
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
  });

  it("claims the identity GitHub matches the key against", () => {
    const claims = JSON.parse(
      Buffer.from(appJwt().split(".")[1], "base64url").toString()
    );
    expect(claims.iss).toBe(config.github.clientId);
  });

  it("backdates itself and expires inside GitHub's ceiling", () => {
    const now = Date.UTC(2026, 0, 1) ;
    const claims = JSON.parse(
      Buffer.from(appJwt(now).split(".")[1], "base64url").toString()
    );
    const seconds = Math.floor(now / 1000);
    // Issued in the past, because GitHub refuses a JWT from its own future and
    // two machines' clocks disagree by more than nothing.
    expect(claims.iat).toBeLessThan(seconds);
    // Ten minutes is the ceiling; asking for exactly it leaves no room for the
    // backdating above.
    expect(claims.exp - seconds).toBeLessThan(600);
    expect(claims.exp).toBeGreaterThan(seconds);
  });
});

describe("the registration this app needs at GitHub", () => {
  it("builds every address it answers on from the one public address", () => {
    // A callback on one host and a webhook on another is a deployment that
    // half-works, and nothing at either end says which half.
    const served = [
      registration.hook_attributes.url,
      registration.setup_url,
      ...registration.callback_urls,
    ];
    for (const url of served) expect(url.startsWith(PUBLIC_URL)).toBe(true);
  });

  it("points its homepage somewhere a reader can actually go", () => {
    // The one field on the registration that is not an address this deployment
    // answers on — it is a link, shown to whoever is deciding whether to
    // install. Defaulting it to the deployment's own URL would send every
    // reader at a container that serves them no page, and on a private
    // deployment at a host they cannot resolve.
    expect(registration.url).toBe(HOMEPAGE);
    expect(registration.url.startsWith("https://")).toBe(true);
    expect(registration.url.startsWith(PUBLIC_URL)).toBe(false);
  });

  it("lets an operator send readers somewhere of their own", () => {
    const own = githubAppManifest(PUBLIC_URL, { homepage: "https://runbook.acme.test" });
    expect(own.url).toBe("https://runbook.acme.test");
    // And changing it moves nothing that GitHub matches.
    expect(own.callback_urls).toEqual(registration.callback_urls);
    expect(own.hook_attributes.url).toBe(registration.hook_attributes.url);
  });

  it("names the routes this app serves, not ones it might", () => {
    expect(registration.hook_attributes.url).toBe(`${PUBLIC_URL}${WEBHOOK_PATH}`);
    expect(registration.setup_url).toBe(`${PUBLIC_URL}${SETUP_PATH}`);
    expect(registration.callback_urls).toEqual([
      `${PUBLIC_URL}${CALLBACK_PATH}`,
      `${PUBLIC_URL}${VERIFY_PATH}`,
    ]);
  });

  it("keeps its two redirects apart", () => {
    // Both are "where GitHub sends somebody afterwards", which is exactly why
    // they get conflated. They have two audiences and two moments: a member
    // every time they authorize, and an organization owner when they install.
    // Pointing one at the other's route fails only when somebody happens to
    // exercise that path.
    const redirects = [registration.callback_urls[0], registration.setup_url];
    expect(new Set(redirects).size).toBe(2);
  });

  it("sends the member's connection to the callback it registered", () => {
    // The manifest tells Initiative where to start the flow; the registration
    // tells GitHub where to end it. Different files, one round trip.
    const account = manifest.connections?.find((c) => c.id === "account");
    expect(account?.connect_path).toBe(CONNECT_PATH);
    expect(registration.callback_urls[0]).toBe(`${PUBLIC_URL}${CALLBACK_PATH}`);
  });

  it("keeps installing and authorizing apart, because they are", () => {
    // With this on, GitHub sends an installation through the authorization
    // step and returns it to the callback carrying a code — one trip, and an
    // app left re-deriving from a query parameter which of the two it had
    // started. Off, GitHub keeps them apart itself: an installation goes to
    // the setup URL and a person authorizing goes to the callback.
    //
    // Installing is not a login. Nobody is authorized by it, and the
    // credential it implies is minted from this app's own key.
    expect(registration.request_oauth_on_install).toBe(false);
    expect(registration.setup_url).toContain(SETUP_PATH);
    expect(registration.callback_urls[0]).toContain(CALLBACK_PATH);
    expect(INSTALL_PATH.startsWith("/")).toBe(true);
  });

  it("does not send somebody back for a change GitHub already reports", () => {
    // A repository ticked at GitHub arrives as an `installation_repositories`
    // delivery, which every app receives whether or not it subscribes. Sending
    // the person here as well would be a second telling of the same thing, on
    // a trip carrying no state to bind it to a guild.
    expect(registration.setup_on_update).toBe(false);
  });

  it("registers a callback for each question it asks", () => {
    // One for a member signing in, one for an installer proving the
    // installation they claimed is theirs. GitHub matches whichever
    // `redirect_uri` a request names against this list, so neither route ever
    // sees the other's traffic — and neither has to work out which it is
    // looking at.
    expect(new Set(registration.callback_urls).size).toBe(2);
    expect(registration.callback_urls).toContain(`${PUBLIC_URL}${VERIFY_PATH}`);
  });

  it("is installable by organizations that did not deploy it", () => {
    // A marketplace listing implies exactly this: the guilds installing it are
    // not the operator running the container.
    expect(registration.public).toBe(true);
  });
});

describe("asking for no more than it uses", () => {
  it("asks for these permissions and no others", () => {
    // Written out rather than derived, because this is the list an organization
    // reviews, and a test that computed it from the code would agree with any
    // change the code made. Two keys are worth reading twice:
    //
    //   * `vulnerability_alerts`, not `dependabot_alerts` — the permission has
    //     a name for people and a key for machines, and GitHub does not
    //     complain about the wrong one, it just grants nothing.
    //   * `organization_projects`, not `repository_projects` — Projects v2 is
    //     organization-scoped and the repository key is the older, classic
    //     board. Same trap, one letter further apart.
    expect(PERMISSIONS).toEqual({
      issues: "write",
      pull_requests: "write",
      vulnerability_alerts: "read",
      organization_projects: "write",
      metadata: "read",
    });
    expect(registration.default_permissions).toEqual(PERMISSIONS);
  });

  it("has something behind every permission it asks for", () => {
    // The rule the list follows. A permission with no feature behind it is one
    // an organization grants for nothing, and a reviewer cannot tell "not used
    // yet" from "used for something not described".
    const declared = new Set((manifest.endpoints ?? []).map((endpoint) => endpoint.id));
    const uses: Record<string, string[]> = {
      issues: [READ_IDS.getIssue, READ_IDS.findIssues, READ_IDS.listLabels, WRITE_IDS.openIssue],
      pull_requests: [READ_IDS.getPullRequest, READ_IDS.findPullRequests, WRITE_IDS.requestReview],
      vulnerability_alerts: [READ_IDS.listAlerts],
      // Reads now as well as the write. A board's id, its fields and the card an
      // issue has are what made `move-project-item` reachable at all.
      organization_projects: [
        READ_IDS.listProjects,
        READ_IDS.listProjectOptions,
        READ_IDS.findProjectItem,
        WRITE_IDS.moveProjectItem,
      ],
    };
    for (const permission of Object.keys(PERMISSIONS)) {
      // Granted implicitly by the rest and required of every GitHub App.
      if (permission === "metadata") continue;
      expect(uses[permission], `nothing declared uses ${permission}`).toBeDefined();
      for (const user of uses[permission]) expect(declared).toContain(user);
    }
  });

  it("asks to write only where an operation writes", () => {
    // A `write` an organization grants and nothing exercises is the worst kind
    // of over-permission: invisible in the app's behaviour and permanent in the
    // grant. So every one has to be named by something in WRITE_DECLARATIONS.
    const writing = Object.entries(PERMISSIONS)
      .filter(([, level]) => level === "write")
      .map(([permission]) => permission);
    expect(writing.length).toBeGreaterThan(0);
    expect(WRITE_DECLARATIONS.length).toBeGreaterThan(0);
    expect(writing.sort()).toEqual([
      "issues",
      "organization_projects",
      "pull_requests",
    ]);
  });

  it("reaches past a repository in exactly one place, and names it", () => {
    // A GitHub App can ask for members, teams, billing and administration. This
    // one asks for none of that. The single organization-scoped permission is
    // `organization_projects`, and it is org-scoped because a Projects v2 board
    // is — there is no repository-scoped equivalent to prefer instead.
    const organizationWide = Object.keys(PERMISSIONS).filter((permission) =>
      /^(members|organization|administration|team)/.test(permission)
    );
    expect(organizationWide).toEqual(["organization_projects"]);
    // And nothing about people, which is the part that has no repository in it
    // at all.
    for (const permission of Object.keys(PERMISSIONS)) {
      expect(permission).not.toMatch(/^(members|administration|team)/);
    }
  });

  it("shows an admin the same permissions it will actually be granted", () => {
    // The manifest's access hint is what an admin reads before anybody
    // authorizes. Restating it beside the registration is how the two come to
    // disagree, so it is derived from it.
    const account = manifest.connections?.find((c) => c.id === "account");
    expect(account?.access_hint?.scopes).toEqual(
      Object.entries(PERMISSIONS).map(([name, level]) => `${name}:${level}`)
    );
  });
});

describe("subscribing to what it republishes, and nothing else", () => {
  it("asks for exactly the deliveries the translator handles", () => {
    // The failure this catches is the quietest one on the registration: an
    // event handled in code and absent from the form never arrives, and
    // nothing at either end says so. Both readings come from one table.
    expect(registration.default_events).toEqual([...SUBSCRIBED_EVENTS]);
    expect(registration.default_events.length).toBeGreaterThan(0);
  });

  it("subscribes to nothing it is not already permitted to read", () => {
    // A webhook event is not a permission of its own — it is delivered under
    // the permission that covers the resource. So a subscription this app is
    // not permitted for is one GitHub silently never sends.
    const needed: Record<string, string> = {
      issues: "issues",
      pull_request: "pull_requests",
    };
    for (const event of registration.default_events) {
      expect(needed[event], `nothing maps ${event} to a permission`).toBeDefined();
      expect(["read", "write"]).toContain(PERMISSIONS[needed[event]]);
    }
  });

  it("still hears the installation lifecycle, because it cannot not", () => {
    // GitHub's own words: "All GitHub Apps receive this event by default. You
    // cannot manually subscribe to this event." So naming them would be asking
    // for something already arriving — and a webhook endpoint that hears an
    // organization install or uninstall the app either way, which is the one
    // thing this app cannot work out for itself in time to matter.
    for (const event of ["installation", "installation_repositories"]) {
      expect(registration.default_events).not.toContain(event);
    }
    expect(registration.hook_attributes.active).toBe(true);
  });
});
