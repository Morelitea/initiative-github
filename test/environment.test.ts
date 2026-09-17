import { describe, expect, it } from "vitest";

import { restoreEnvironment } from "./support/environment.js";

describe("environment restoration", () => {
  it("deletes variables that were originally absent", () => {
    const environment: NodeJS.ProcessEnv = { PRESENT: "changed", ADDED: "temporary" };

    restoreEnvironment(
      { PRESENT: "original", ADDED: undefined },
      environment
    );

    expect(environment).toEqual({ PRESENT: "original" });
    expect("ADDED" in environment).toBe(false);
  });
});
