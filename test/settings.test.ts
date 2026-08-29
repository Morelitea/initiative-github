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

  it("names the key that makes this a GitHub App, as a registration setting", () => {
    // The one this whole arrangement exists for. Everything the app does as
    // itself is signed with it — installation discovery, installation tokens,
    // the install page — so a deployment without it serves routes that can
    // answer nothing, and it must not be possible for that to go unnoticed.
    //
    // It is not required at *boot*, and that is deliberate rather than a
    // loosening: an app cannot be asked to hold the credentials for a
    // registration it has not made yet, and the route that makes one is the
    // only thing an unregistered app serves. So it is published in its own
    // class, and a deployment check can tell "cannot start" from "cannot work
    // until somebody registers it".
    expect(SETTINGS.registration).toContain("GITHUB_APP_PRIVATE_KEY");
    expect(SETTINGS.required).not.toContain("GITHUB_APP_PRIVATE_KEY");
  });

  it("publishes all three classes, because the deployment check reads them", () => {
    const published = JSON.parse(envContract()) as Record<string, string[]>;
    expect(published.required).toEqual([...SETTINGS.required]);
    expect(published.registration).toEqual([...SETTINGS.registration]);
    expect(published.optional).toEqual([...SETTINGS.optional]);
  });

  it("opens the registration route with one setting, and only that one", () => {
    // Set to register, then taken away. It is optional because the state it
    // describes is temporary, and it is the only thing that makes an
    // unregistered app willing to do anything.
    expect(SETTINGS.optional).toContain("INITIATIVE_APP_SETUP_TOKEN");
  });
});
