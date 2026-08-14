/**
 * Build `manifest.json` from `manifest.config.ts`, refusing to write a bad one.
 *
 * Authoring the manifest in TypeScript means the compiler catches most
 * mistakes; this catches the rest that the kit can see — the features
 * cross-check and every id reference — before the file exists at all. A
 * manifest that would be refused should never be servable.
 */

import { writeFileSync } from "node:fs";
import { validateManifest } from "initiative-app-kit";

import { manifest } from "../src/manifest.config.js";

const problems = validateManifest(manifest);
if (problems.length > 0) {
  for (const problem of problems) {
    process.stderr.write(`manifest${problem.where}: ${problem.message}\n`);
  }
  process.exit(1);
}

writeFileSync("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
process.stdout.write("wrote manifest.json\n");
