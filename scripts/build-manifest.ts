import { writeFileSync } from "node:fs";
import { checkLanguages, validateDocument } from "initiative-app-kit";

import { document } from "../src/listing.config.js";

/**
 * The languages this app promises.
 *
 * Not a rule anybody imposes: an app that ships one language is a perfectly
 * good app, and no deployment is entitled to demand four. These four are what
 * this app already writes, so holding itself to them is what stops the fifth
 * endpoint somebody adds from being English-only in three canvases — which
 * degrades visibly on the consumer's side but is nobody's bug there to fix.
 */
const LANGUAGES = ["en", "de", "es", "fr"];

const problems = validateDocument(document);
if (problems.length > 0) {
  for (const problem of problems) {
    process.stderr.write(`manifest${problem.where}: ${problem.message}\n`);
  }
  process.exit(1);
}

const untranslated = checkLanguages(document.definition, LANGUAGES);
if (untranslated.length > 0) {
  for (const problem of untranslated) {
    process.stderr.write(`manifest/definition${problem.where}: ${problem.message}\n`);
  }
  process.exit(1);
}

writeFileSync("manifest.json", `${JSON.stringify(document, null, 2)}\n`, "utf-8");
process.stdout.write("wrote manifest.json\n");
