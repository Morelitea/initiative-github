/**
 * Build `manifest.json` from `manifest.config.ts`, refusing to write a bad one.
 *
 * Authoring the manifest in TypeScript means the compiler catches most
 * mistakes; this catches the rest that the kit can see — the envelope, the
 * features cross-check and every id reference — before the file exists at all.
 * A manifest that would be refused should never be servable.
 */

import { writeFileSync } from "node:fs";
import { validateDocument } from "initiative-app-kit";

import { document } from "../src/listing.config.js";

// The DOCUMENT, which is what a registrar fetches — the manifest is its
// `definition`. Validating the manifest alone would pass a file that cannot be
// registered, which is the failure this script exists to make impossible.
//
// Taken from `listing.config.ts` so the catalog uid it carries is the one the
// listings publish under, and so the server serves this same object.
const problems = validateDocument(document);
if (problems.length > 0) {
  for (const problem of problems) {
    process.stderr.write(`manifest${problem.where}: ${problem.message}\n`);
  }
  process.exit(1);
}

writeFileSync("manifest.json", `${JSON.stringify(document, null, 2)}\n`, "utf-8");
process.stdout.write("wrote manifest.json\n");
