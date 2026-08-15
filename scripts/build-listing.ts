/**
 * Build the catalog files an operator drops into their marketplace.
 *
 * Written rather than committed, for the same reason `manifest.json` is: the
 * tag is the version in this repository, so a listing carrying one on `main`
 * would let an ordinary commit stage a release. The release workflow runs this
 * with the tag and attaches what it writes, and CI runs it to prove the
 * listings are still valid.
 *
 * A listing that would be refused should never exist as a file. An invalid one
 * fails a *rescan* — skipped, named in a log nobody is reading, with the app
 * registered and healthy and simply absent from the marketplace — so this is
 * the last place the problem is loud.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { validateListing } from "initiative-app-kit";

import { listings } from "../src/listing.config.js";

// The tag, when the release passes one; otherwise something that is obviously
// not a release, so a locally built file cannot be mistaken for one.
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
