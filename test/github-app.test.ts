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
  HOMEPAGE,
  PERMISSIONS,
  githubAppManifest,
} from "../src/github/registration.js";
import { manifest } from "../src/manifest.config.js";
import {
  CALLBACK_PATH,
  CONNECT_PATH,
  INSTALL_PATH,
  REGISTERED_PATH,
  SETUP_PATH,
  WEBHOOK_PATH,
} from "../src/routes.js";

const PUBLIC_URL = config.publicUrl;
const registration = githubAppManifest(PUBLIC_URL);

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
      registration.redirect_url,
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
    expect(registration.callback_urls).toEqual([`${PUBLIC_URL}${CALLBACK_PATH}`]);
    expect(registration.redirect_url).toBe(`${PUBLIC_URL}${REGISTERED_PATH}`);
  });

  it("keeps its three redirects apart", () => {
    // All three are "where GitHub sends somebody afterwards", which is exactly
    // why they get conflated. They have three audiences and three moments: the
    // operator once, at creation; a member every time they authorize; an
    // organization owner when they install. Pointing one at another's route
    // fails only when somebody happens to exercise that path.
    const redirects = [
      registration.redirect_url,
      registration.callback_urls[0],
      registration.setup_url,
    ];
    expect(new Set(redirects).size).toBe(3);
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
  it("asks for these permissions and no others", () => {
    // Written out rather than derived, because this is the list an organization
    // reviews, and a test that computed it from the code would agree with any
    // change the code made. Note `vulnerability_alerts` rather than
    // `dependabot_alerts`: the permission has a name for people and a key for
    // machines, and GitHub does not complain about the wrong one — it just
    // grants nothing.
    expect(PERMISSIONS).toEqual({
      issues: "read",
      pull_requests: "read",
      vulnerability_alerts: "read",
      metadata: "read",
    });
    expect(registration.default_permissions).toEqual(PERMISSIONS);
  });

  it("has something reading every permission it asks for", () => {
    // The rule the list above follows. A permission with no feature behind it
    // is one an organization grants for nothing, and a reviewer cannot tell
    // "not used yet" from "used for something not described".
    const sources = (manifest.data_sources ?? []).map((source) => source.id);
    const readers: Record<string, string> = {
      issues: "open-issues",
      pull_requests: "review-queue",
      vulnerability_alerts: "dependabot-alerts",
    };
    for (const permission of Object.keys(PERMISSIONS)) {
      // Granted implicitly by the rest and required of every GitHub App.
      if (permission === "metadata") continue;
      expect(readers[permission], `nothing declared reads ${permission}`).toBeDefined();
      expect(sources).toContain(readers[permission]);
    }
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

describe("subscribing to nothing, and still hearing what matters", () => {
  it("asks for no repository activity", () => {
    // It took `issues` and `pull_request` to fire automation triggers. With
    // those gone, repository activity tells this app nothing its next source
    // call would not — a webhook that only invalidated a sixty-second cache
    // would be a lot of machinery for a minute.
    expect(registration.default_events).toEqual([]);
  });

  it("still hears the installation lifecycle, because it cannot not", () => {
    // GitHub's own words: "All GitHub Apps receive this event by default. You
    // cannot manually subscribe to this event." So an empty list above and a
    // webhook endpoint that still hears an organization install, uninstall, or
    // re-scope the app — the one thing this app cannot work out for itself in
    // time to matter.
    for (const event of ["installation", "installation_repositories"]) {
      expect(registration.default_events).not.toContain(event);
    }
    expect(registration.hook_attributes.active).toBe(true);
  });
});
