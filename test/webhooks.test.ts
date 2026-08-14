/**
 * The ingest half, which is the half nothing else can check for you.
 *
 * Three things have to hold, and none of them is visible from the outside. The
 * signature check has to agree with the way GitHub computes one. The
 * translation has to carry exactly the fields the trigger nodes declared. And
 * the event types this file emits have to be spelled the same as the ones the
 * manifest declares — the platform checks an emitted type against the pinned
 * definition, so a drift between the two lists is an automation that silently
 * never fires.
 *
 * So: the signature, the translation, and the agreement between the two lists.
 */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { EVENTS, translate, verifySignature } from "../src/github/webhooks.js";
import { manifest } from "../src/manifest.config.js";

const SECRET = process.env.GITHUB_WEBHOOK_SECRET!;

function githubWouldSign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("is this really from GitHub", () => {
  const body = JSON.stringify({ action: "opened" });

  it("accepts what GitHub signed", () => {
    expect(
      verifySignature(Buffer.from(body), githubWouldSign(body))
    ).toBe(true);
  });

  it("refuses a signature made with a different secret", () => {
    expect(
      verifySignature(Buffer.from(body), githubWouldSign(body, "some-other-secret"))
    ).toBe(false);
  });

  it("refuses a body that changed after it was signed", () => {
    const signature = githubWouldSign(body);
    const tampered = JSON.stringify({ action: "closed" });
    expect(verifySignature(Buffer.from(tampered), signature)).toBe(false);
  });

  it("refuses a delivery carrying no signature at all", () => {
    expect(verifySignature(Buffer.from(body), undefined)).toBe(false);
    expect(verifySignature(Buffer.from(body), "")).toBe(false);
  });

  it("refuses a signature that is not the algorithm we verify", () => {
    const sha1 = createHmac("sha1", SECRET).update(body).digest("hex");
    expect(verifySignature(Buffer.from(body), `sha1=${sha1}`)).toBe(false);
  });

  it("refuses a malformed signature without throwing", () => {
    // A hex parse of nonsense yields a short buffer, and comparing buffers of
    // different lengths raises rather than returning false — so the length is
    // checked first, and this is what says so.
    expect(verifySignature(Buffer.from(body), "sha256=not-hex-at-all")).toBe(false);
    expect(verifySignature(Buffer.from(body), "sha256=")).toBe(false);
  });
});

describe("what a delivery becomes", () => {
  const issue = {
    number: 42,
    title: "Something is broken",
    html_url: "https://github.com/acme/widgets/issues/42",
    labels: [{ name: "bug" }, { name: "urgent" }],
    // Everything GitHub also sends and no node declared.
    body: "a long description",
    user: { login: "someone", id: 99 },
  };

  it("turns an opened issue into the trigger's declared outputs, and nothing else", () => {
    const result = translate("issues", { action: "opened", issue });
    expect(result).toEqual({
      type: EVENTS.issueOpened,
      payload: {
        issue_number: 42,
        issue_title: "Something is broken",
        issue_url: "https://github.com/acme/widgets/issues/42",
        issue_labels: ["bug", "urgent"],
      },
    });
  });

  it("distinguishes closing from opening", () => {
    expect(translate("issues", { action: "closed", issue })?.type).toBe(
      EVENTS.issueClosed
    );
  });

  it("ignores the verbs no trigger asked about", () => {
    // GitHub sends one `issues` event for every verb. A repository produces far
    // more of these than of the two this app wants.
    for (const action of ["edited", "labeled", "assigned", "reopened"]) {
      expect(translate("issues", { action, issue })).toBeNull();
    }
  });

  it("turns a requested review into its own event", () => {
    const result = translate("pull_request", {
      action: "review_requested",
      pull_request: {
        number: 7,
        title: "Add a thing",
        html_url: "https://github.com/acme/widgets/pull/7",
      },
    });
    expect(result).toEqual({
      type: EVENTS.reviewRequested,
      payload: {
        pull_number: 7,
        pull_title: "Add a thing",
        pull_url: "https://github.com/acme/widgets/pull/7",
      },
    });
  });

  it("ignores events this app never subscribed to", () => {
    expect(translate("push", { ref: "refs/heads/main" })).toBeNull();
    expect(translate("star", { action: "created" })).toBeNull();
  });

  it("survives a payload missing the object it names", () => {
    expect(translate("issues", { action: "opened" })).toBeNull();
    expect(translate("pull_request", { action: "review_requested" })).toBeNull();
  });

  it("reads labels by name and drops anything that is not one", () => {
    const result = translate("issues", {
      action: "opened",
      issue: { ...issue, labels: [{ name: "bug" }, {}, null, "raw-string"] },
    });
    expect(result?.payload.issue_labels).toEqual(["bug"]);
  });
});

describe("the two lists agree", () => {
  it("emits only event types the manifest declares", () => {
    // The platform checks an event against the *pinned* definition, so a type
    // spelled differently here than in the manifest is refused at ingress with
    // the automation simply never firing.
    const declared = new Set(manifest.events ?? []);
    for (const type of Object.values(EVENTS)) {
      expect(declared).toContain(type);
    }
  });

  it("emits every event a trigger node waits on", () => {
    // The other direction: a trigger naming an event nothing emits is a node an
    // admin can place on the canvas that can never fire.
    const nodes = (manifest.automation as { nodes?: Array<{ event?: string }> })
      ?.nodes;
    const waitedOn = (nodes ?? [])
      .map((node) => node.event)
      .filter((event): event is string => typeof event === "string");
    const emitted = new Set<string>(Object.values(EVENTS));

    expect(waitedOn.length).toBeGreaterThan(0);
    for (const event of waitedOn) {
      expect(emitted).toContain(event);
    }
  });
});
