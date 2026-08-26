import { writeFileSync } from "node:fs";
import { validateDocument } from "initiative-app-kit";

import { document } from "../src/listing.config.js";

const problems = validateDocument(document);
if (problems.length > 0) {
  for (const problem of problems) {
    process.stderr.write(`manifest${problem.where}: ${problem.message}\n`);
  }
  process.exit(1);
}

writeFileSync("manifest.json", `${JSON.stringify(document, null, 2)}\n`, "utf-8");
process.stdout.write("wrote manifest.json\n");
