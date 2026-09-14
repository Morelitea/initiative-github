import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Configuration is read at module load, so it has to exist before the
    // first import in any test file that reaches it.
    setupFiles: ["test/setup.ts"],
    // The database-backed tests share one schema and truncate between cases;
    // running files in parallel against it would be a race with itself.
    fileParallelism: false,
    // Finding no test files is a failure, not a pass. This is half the guard:
    // it does NOT cover files found and every test inside them filtered out,
    // which exits 0 with a skip count. `scripts/assert-tests-ran.mjs` is the
    // other half and the one that catches that.
    passWithNoTests: false,
  },
});
