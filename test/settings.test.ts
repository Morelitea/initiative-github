/**
 * What this app needs from its environment, and keeping the published copy true.
 *
 * The contract is read by a deployment that has a checkout and not a build, so
 * `env-contract.json` is committed. A committed generated file is only worth
 * anything if something notices when it goes stale, and that is this.
 *
 * **What is deliberately not tested here: that the table names everything the
 * code reads.** The obvious way to check it is to scan `config.ts` for setting
 * names, which is the mistake this whole arrangement exists to undo — a scan
 * over source is what reported a clean bill while `GITHUB_APP_PRIVATE_KEY` was
 * missing from the deployment, because it was read through a helper rather than
 * a literal call.
 *
 * The compiler makes that check instead, and makes it completely: `required()`
 * and `optional()` take a name typed as a member of this table, and they are
 * the only readers of `process.env` in the app. A setting not in the table is
 * not a setting that can be read — it does not compile. That is a stronger
 * guarantee than any test could offer, and it needs no test to hold.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CONTRACT_PATH, envContract } from "../scripts/build-env-contract.js";
import { SETTINGS } from "../src/config.js";

describe("the published contract", () => {
  it("is what the table would write today", () => {
    // `npm run env-contract` if this fails. A stale committed copy is worse
    // than none: a deployment checks against it and is told it is complete.
    expect(readFileSync(CONTRACT_PATH, "utf-8")).toBe(envContract());
  });

  it("keeps the two lists disjoint", () => {
    // A setting in both is one whose requiredness nobody has decided, and a
    // deployment check would take whichever list it read first.
    for (const name of SETTINGS.required) {
      expect(SETTINGS.optional as readonly string[]).not.toContain(name);
    }
  });

  it("names things that could be environment variables", () => {
    // Read character by character rather than matched. A name with a lowercase
    // letter or a hyphen in it is one `process.env` will never find, and the
    // failure is a setting silently absent rather than an error.
    for (const name of [...SETTINGS.required, ...SETTINGS.optional]) {
      expect(name.length).toBeGreaterThan(0);
      for (const character of name) {
        const legal =
          (character >= "A" && character <= "Z") ||
          (character >= "0" && character <= "9") ||
          character === "_";
        expect(legal, `${name} has a character env lookup cannot match`).toBe(true);
      }
    }
  });

  it("requires the key that makes this a GitHub App", () => {
    // The one this whole arrangement exists for. Everything the app does as
    // itself is signed with it — installation discovery, installation tokens,
    // the install page — so a deployment without it serves routes that can
    // answer nothing, and it must not be possible for that to go unnoticed
    // again.
    expect(SETTINGS.required).toContain("GITHUB_APP_PRIVATE_KEY");
  });
});
