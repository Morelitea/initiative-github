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
import {
  PERMISSIONS,
  WEBHOOK_EVENTS,
  githubAppManifest,
} from "../src/github/registration.js";
import { EVENTS, translate } from "../src/github/webhooks.js";
import { manifest } from "../src/manifest.config.js";
import {
  CALLBACK_PATH,
  CONNECT_PATH,
  INSTALL_PATH,
  SETUP_PATH,
  WEBHOOK_PATH,
} from "../src/routes.js";

const PUBLIC_URL = config.publicUrl;
const registration = githubAppManifest(PUBLIC_URL);

/** One delivery of each kind this app subscribes to, as GitHub sends it. */
const DELIVERIES: Record<string, Array<Record<string, unknown>>> = {
  issues: [
    { action: "opened", issue: { number: 1, title: "t", html_url: "u", labels: [] } },
    { action: "closed", issue: { number: 1, title: "t", html_url: "u", labels: [] } },
  ],
  pull_request: [
    { action: "review_requested", pull_request: { number: 2, title: "t", html_url: "u" } },
  ],
};

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
  it("builds every URL from the one public address", () => {
    // A callback on one host and a webhook on another is a deployment that
    // half-works, and nothing at either end says which half.
    const urls = [
      registration.url,
      registration.hook_attributes.url,
      registration.redirect_url,
      registration.setup_url,
      ...registration.callback_urls,
    ];
    for (const url of urls) expect(url.startsWith(PUBLIC_URL)).toBe(true);
  });

  it("names the routes this app serves, not ones it might", () => {
    expect(registration.hook_attributes.url).toBe(`${PUBLIC_URL}${WEBHOOK_PATH}`);
    expect(registration.setup_url).toBe(`${PUBLIC_URL}${SETUP_PATH}`);
    expect(registration.callback_urls).toEqual([`${PUBLIC_URL}${CALLBACK_PATH}`]);
    // The redirect after installing has to be the same place as the redirect
    // after authorizing, because with `request_oauth_on_install` they are one
    // journey and one handler.
    expect(registration.redirect_url).toBe(registration.callback_urls[0]);
  });

  it("sends the member's connection to the callback it registered", () => {
    // The manifest tells Initiative where to start the flow; the registration
    // tells GitHub where to end it. Different files, one round trip.
    const account = manifest.connections?.find((c) => c.id === "account");
    expect(account?.connect_path).toBe(CONNECT_PATH);
    expect(registration.callback_urls[0]).toBe(`${PUBLIC_URL}${CALLBACK_PATH}`);
  });

  it("makes installing and connecting one trip", () => {
    // Without this an org owner installs the app and is then asked, separately
    // and later, to authorize it — and most of them do not.
    expect(registration.request_oauth_on_install).toBe(true);
    expect(INSTALL_PATH.startsWith("/")).toBe(true);
  });

  it("is installable by organizations that did not deploy it", () => {
    // A marketplace listing implies exactly this: the guilds installing it are
    // not the operator running the container.
    expect(registration.public).toBe(true);
  });
});

describe("asking for no more than it uses", () => {
  it("asks for three permissions and no others", () => {
    // Written out rather than derived, because this is the list an organization
    // reviews, and a test that computed it from the code would agree with any
    // change the code made.
    expect(PERMISSIONS).toEqual({
      issues: "write",
      pull_requests: "read",
      metadata: "read",
    });
    expect(registration.default_permissions).toEqual(PERMISSIONS);
  });

  it("asks for nothing about the organization or its people", () => {
    // A GitHub App can ask for members, teams, billing and administration. This
    // one reads a repository and opens issues in it.
    for (const permission of Object.keys(PERMISSIONS)) {
      expect(permission).not.toMatch(/^(members|organization|administration)/);
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

describe("subscribing to exactly what it handles", () => {
  it("handles every event it subscribed to", () => {
    // An event nobody translates is a delivery answered `unhandled` forever,
    // and GitHub reports it as a green tick.
    for (const event of WEBHOOK_EVENTS) {
      const payloads = DELIVERIES[event];
      expect(payloads, `no sample delivery for ${event}`).toBeDefined();
      for (const payload of payloads) {
        expect(translate(event, payload), `${event} is not translated`).not.toBeNull();
      }
    }
  });

  it("subscribed to every event it handles", () => {
    // The direction that fails silently: a trigger node that can never fire,
    // because the delivery that would fire it was never asked for.
    for (const event of Object.keys(DELIVERIES)) {
      expect(WEBHOOK_EVENTS).toContain(event);
    }
  });

  it("produces exactly the events the manifest declares", () => {
    // Initiative refuses an event the pinned definition does not name, so a
    // translator that produced a fourth would emit into a wall.
    const produced = new Set<string>();
    for (const [event, payloads] of Object.entries(DELIVERIES)) {
      for (const payload of payloads) {
        const translated = translate(event, payload);
        if (translated) produced.add(translated.type);
      }
    }
    expect([...produced].sort()).toEqual([...(manifest.events ?? [])].sort());
    expect([...produced].sort()).toEqual([...Object.values(EVENTS)].sort());
  });
});
