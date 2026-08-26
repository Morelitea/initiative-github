import { mkdirSync, writeFileSync } from "node:fs";
import { validateListing } from "initiative-app-kit";

import { listings } from "../src/listing.config.js";

const version = process.env.LISTING_VERSION ?? "0.0.0-dev";

let failed = false;
mkdirSync("catalog", { recursive: true });

for (const listing of listings(version)) {
  const problems = validateListing(listing);
  for (const problem of problems) {
    process.stderr.write(`${listing.public_id}${problem.where}: ${problem.message}\n`);
    failed = true;
  }
  if (problems.length > 0) continue;

  const path = `catalog/${listing.public_id}.json`;
  writeFileSync(path, `${JSON.stringify(listing, null, 2)}\n`, "utf-8");
  process.stdout.write(`wrote ${path} (${listing.kind}, ${version})\n`);
}

process.exit(failed ? 1 : 0);
