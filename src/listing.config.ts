import { appDocument, appListing, type Listing } from "initiative-app-kit";

import { manifest } from "./manifest.config.js";

export const LISTING_UID = "TYG4VVZKAWRMBZ";

export const document = appDocument(manifest, { uid: LISTING_UID });

const PUBLISHER = "Morelitea";

export function listings(version: string): Listing[] {
  const app = appListing(document, {
    name: "GitHub",
    publisher: PUBLISHER,
    description:
      "Your repository's issues, reviews and dependency alerts, on a dashboard.",
    long_description: [
      "See what your repository is doing without leaving Initiative.",
      "",
      "A guild admin names the organization once. Access is the GitHub App installation that organization granted — nobody pastes a token — so the issue count, the last fortnight's activity and the open Dependabot alerts are there for everybody. Members who want their own review queue connect their own GitHub account; nobody else has to.",
      "",
      "An install can cover several repositories, and each dashboard says which one its tiles are about — so one team's board shows one team's repository.",
    ].join("\n"),
    version,
  });

  return [app];
}
