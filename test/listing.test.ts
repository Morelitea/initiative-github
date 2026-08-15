/**
 * Being installable, which is not the same as being registered.
 *
 * This app was live and healthy for a release with no listing at all: the
 * registrar verified it, the container answered, and no guild could add it,
 * because nothing derives a marketplace entry from a served manifest. That
 * failure looks like success from every angle except the marketplace, which is
 * why it is worth a test file rather than a paragraph.
 *
 * Two things are checked here that nothing downstream can check. The uid ties
 * the registration to the listing — get it wrong and the app verifies but names
 * nothing. And a companion dashboard is a standalone file once published, so
 * the only moment its widget ids can be compared against the app that supplies
 * them is here.
 */

import { describe, expect, it } from "vitest";
import { appWidgetParts, validateListing } from "initiative-app-kit";

import { DASHBOARD_UID, LISTING_UID, document, listings } from "../src/listing.config.js";
import { manifest } from "../src/manifest.config.js";

const VERSION = "1.2.3";
const [app, overview] = listings(VERSION);

const dashboardWidgets = () =>
  (overview.definition as { widgets: Array<Record<string, any>> }).widgets;

describe("both listings", () => {
  it("are ones a catalog will take", () => {
    expect(validateListing(app)).toEqual([]);
    expect(validateListing(overview)).toEqual([]);
  });

  it("publish at the version they were built with", () => {
    // The tag is the version here, so it arrives from the environment rather
    // than from a file on main. Both listings carry the same one.
    expect(app.version).toBe(VERSION);
    expect(overview.version).toBe(VERSION);
  });

  it("say who publishes them", () => {
    expect(app.publisher).toBe("Morelitea");
    expect(overview.publisher).toBe(app.publisher);
  });
});

describe("the app listing", () => {
  it("carries the same uid the served document does", () => {
    // The tie. A document without this uid registers cleanly and names no
    // listing, and an install marked mandatory is skipped as "not verified".
    expect(document.uid).toBe(LISTING_UID);
    expect(app.uid).toBe(LISTING_UID);
  });

  it("publishes the manifest this app actually serves", () => {
    // Not a copy of it. A restated definition is how a catalog entry comes to
    // describe a version of an app that no longer exists.
    expect(app.definition).toBe(manifest);
    expect(app.public_id).toBe(manifest.service.public_id);
  });
});

describe("the companion dashboard", () => {
  it("is its own listing, installed separately", () => {
    expect(overview.kind).toBe("dashboard");
    expect(overview.uid).toBe(DASHBOARD_UID);
    expect(overview.uid).not.toBe(app.uid);
    expect(overview.public_id).not.toBe(app.public_id);
  });

  it("draws only widgets this app declares", () => {
    const declared = new Set((manifest.widgets ?? []).map((widget) => widget.id));
    for (const widget of dashboardWidgets()) {
      const parts = appWidgetParts(widget.type);
      expect(parts?.uid).toBe(LISTING_UID);
      expect(declared).toContain(parts?.widgetId);
    }
  });

  it("binds only to sources this app declares", () => {
    const declared = new Set((manifest.data_sources ?? []).map((source) => source.id));
    for (const widget of dashboardWidgets()) {
      expect(widget.binding.app_uid).toBe(LISTING_UID);
      expect(declared).toContain(widget.binding.source_id);
    }
  });

  it("shows every widget this app has", () => {
    // Not a rule of the protocol — a choice for this app. A companion that
    // shipped two of three widgets would leave the third with nowhere to be
    // seen unless a guild built its own dashboard.
    const shown = new Set(
      dashboardWidgets().map((widget) => appWidgetParts(widget.type)?.widgetId)
    );
    expect(shown).toEqual(new Set((manifest.widgets ?? []).map((widget) => widget.id)));
  });

  it("puts both scopes on one dashboard", () => {
    // Deliberate: two tiles answer for the whole guild from its shared access,
    // and one answers for whoever is looking. A member who never connects a
    // personal account still gets a working dashboard with one tile asking.
    const sourceScope = (sourceId: string) =>
      manifest.data_sources?.find((source) => source.id === sourceId)?.requires?.all_of;
    const scopes = dashboardWidgets().map((widget) =>
      sourceScope(widget.binding.source_id)?.includes("account") ? "member" : "guild"
    );
    expect(scopes).toContain("guild");
    expect(scopes).toContain("member");
  });

  it("lays its widgets out inside the grid", () => {
    for (const widget of dashboardWidgets()) {
      expect(widget.grid.x + widget.grid.w).toBeLessThanOrEqual(12);
    }
  });
});
