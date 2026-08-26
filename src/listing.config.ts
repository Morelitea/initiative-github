/**
 * What this app publishes, as opposed to what it serves.
 *
 * Serving a manifest and being installable are two different things, and this
 * is the second one. `/.well-known/initiative-app.json` is what a *registrar*
 * fetches to verify a container an operator has already decided to run. A
 * **listing** is what a guild admin browses and installs. Nothing derives one
 * from the other — so an app that ships only a manifest is registered, live,
 * healthy, and cannot be added by anybody. That is a real failure mode and it
 * looks like success from every angle except the one that matters.
 *
 * Two listings, and they are separate installs:
 *
 * 1. **The app.** Its definition is the manifest itself, read from the document
 *    this app serves rather than restated — restating it is how a catalog entry
 *    comes to describe a version of an app that no longer exists.
 * 2. **A companion dashboard.** A second entry in the same marketplace, shipping
 *    a ready-made arrangement of this app's own widgets. It carries no code: it
 *    is a layout naming widget types the app's pinned definition already
 *    declares. A guild installs the app, installs the dashboard, and has
 *    something to look at without assembling it.
 *
 * The only thing tying them together is the uid, which is also what ties the
 * verified registration to the listing. Publisher-assigned, immutable, never
 * reused — minted once with `npx initiative-app uid` and written here.
 *
 * The version is *not* here. The tag is the version in this repository, so
 * `npm run catalog` takes it from the environment and the release stamps it —
 * a file carrying the next version means an ordinary commit can bump a release.
 */

import {
  appDocument,
  appListing,
  appWidgetType,
  dashboardListing,
  type Listing,
} from "initiative-app-kit";

import { manifest } from "./manifest.config.js";

/** This app's catalog id. Immutable: changing it publishes a second app. */
export const LISTING_UID = "TYG4VVZKAWRMBZ";

/** The companion dashboard's own id — a separate entry, installed separately. */
export const DASHBOARD_UID = "J9H7S9T7GP7FAG";

/** The document a registrar fetches, carrying the uid that names the listing. */
export const document = appDocument(manifest, { uid: LISTING_UID });

const PUBLISHER = "Morelitea";

/** Build both listings at one version. */
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

  const overview = dashboardListing(app, {
    uid: DASHBOARD_UID,
    public_id: "morelitea.github-overview",
    meta: {
      name: "GitHub overview",
      publisher: PUBLISHER,
      description: "The repository at a glance: open issues, reviews, throughput.",
      long_description:
        "A ready-made arrangement of the GitHub app's four widgets. Install the GitHub app first — this dashboard draws its data from it, and without it the tiles have nothing to read.",
      version,
    },
    layout: { columns: 12 },
    widgets: [
      {
        id: "open",
        type: appWidgetType(LISTING_UID, "open-issues"),
        title: "Open issues",
        grid: { x: 0, y: 0, w: 3, h: 3 },
        binding: { source_id: "open-issues" },
      },
      {
        // Guild-scoped either side of per-member on one dashboard, deliberately:
        // the tiles around it answer for the whole guild, and this one answers
        // for whoever is looking. A member who has not connected their account
        // sees this tile ask them to, and the other three work.
        id: "reviews",
        type: appWidgetType(LISTING_UID, "review-queue"),
        title: "Waiting on your review",
        grid: { x: 3, y: 0, w: 6, h: 3 },
        binding: { source_id: "review-queue" },
      },
      {
        id: "alerts",
        type: appWidgetType(LISTING_UID, "dependabot-alerts"),
        title: "Dependabot alerts",
        grid: { x: 9, y: 0, w: 3, h: 3 },
        binding: { source_id: "dependabot-alerts" },
      },
      {
        id: "throughput",
        type: appWidgetType(LISTING_UID, "issue-throughput"),
        title: "Opened and closed",
        grid: { x: 0, y: 3, w: 12, h: 4 },
        binding: { source_id: "issue-throughput" },
      },
    ],
  });

  return [app, overview];
}
