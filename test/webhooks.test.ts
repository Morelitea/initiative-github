/**
 * Is this really from GitHub?
 *
 * The webhook URL is public, so the signature is the only reason to believe a
 * delivery came from GitHub at all — and this app acts on what arrives by
 * re-running a sync, so a forged one would be somebody else deciding when it
 * talks to the platform.
 *
 * One secret, on the app's own registration, covering every organization that
 * installs it. An OAuth app would have needed a webhook added by hand to every
 * repository, and would have received nothing from the one somebody forgot.
 */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import { verifySignature } from "../src/github/webhooks.js";

const SECRET = process.env.GITHUB_WEBHOOK_SECRET!;

function githubWouldSign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("is this really from GitHub", () => {
  const body = JSON.stringify({ action: "created" });

  it("accepts what GitHub signed", () => {
    expect(verifySignature(Buffer.from(body), githubWouldSign(body))).toBe(true);
  });

  it("refuses a signature made with a different secret", () => {
    expect(
      verifySignature(Buffer.from(body), githubWouldSign(body, "some-other-secret"))
    ).toBe(false);
  });

  it("refuses a body that changed after it was signed", () => {
    const signature = githubWouldSign(body);
    const tampered = JSON.stringify({ action: "deleted" });
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
