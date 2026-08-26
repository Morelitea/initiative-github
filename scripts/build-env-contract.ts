/**
 * Publish what this app needs from its environment, as JSON a deployment can read.
 *
 * A chart supplying this app has to set every required name, and something has
 * to check that it does. The check used to live in the infrastructure repository
 * and read `src/config.ts`, pulling names out with a pattern — which worked
 * until a value was read through a helper rather than a literal call, and then
 * reported a clean bill for a chart missing a setting the container dies
 * without. `GITHUB_APP_PRIVATE_KEY` was that setting, for as long as the app has
 * been a GitHub App.
 *
 * So the contract is published rather than inferred. This writes it; the test
 * beside it keeps the committed copy current; and the deployment reads JSON
 * instead of parsing somebody else's language.
 *
 * The file is committed, not generated at install time, because whoever reads
 * it has a checkout and not a build.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SETTINGS } from "../src/settings.js";
import { PUBLIC_ID } from "../src/public-id.js";

export const CONTRACT_PATH = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "env-contract.json"
);

/** The document, rendered the one way, so a rewrite is a no-op diff. */
export function envContract(): string {
  return `${JSON.stringify(
    {
      service: "initiative-github",
      public_id: PUBLIC_ID,
      required: [...SETTINGS.required],
      optional: [...SETTINGS.optional],
    },
    null,
    2
  )}\n`;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  writeFileSync(CONTRACT_PATH, envContract(), "utf-8");
  process.stdout.write("wrote env-contract.json\n");
}
