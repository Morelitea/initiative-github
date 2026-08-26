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
 * nothing. And the companion dashboard becomes a standalone listing once
 * published, so this is the last moment the widgets and endpoints it names can
 * be compared against the app that supplies them.
 *
 * That second one is the reason the dashboard is declared in the manifest rather
 * than written out as a second catalog file. Both produce the same entry; only
 * one of them can be checked against the thing it draws from.
 */

import { describe, expect, it } from "vitest";
import { validateListing } from "initiative-app-kit";

import { LISTING_UID, document, listings } from "../src/listing.config.js";
import { DASHBOARD_UID, manifest } from "../src/manifest.config.js";

const VERSION = "1.2.3";
const [app, ...rest] = listings(VERSION);

const dashboard = () => (manifest.dashboards ?? [])[0];
const tiles = () => dashboard().widgets;

describe("the app listing", () => {
  it("is one a catalog will take", () => {
    expect(validateListing(app)).toEqual([]);
  });

  it("is the only file this repository writes", () => {
    // The companion dashboard rides in the manifest now, so publishing the app
    // publishes it. A second file would be the same entry written twice, and
    // the copy is the one that goes stale.
    expect(rest).toEqual([]);
  });

  it("publishes at the version it was built with", () => {
    // The tag is the version here, so it arrives from the environment rather
    // than from a file on main.
    expect(app.version).toBe(VERSION);
    expect(app.publisher).toBe("Morelitea");
  });

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
  it("is its own entry, installed separately", () => {
    expect(dashboard().uid).toBe(DASHBOARD_UID);
    expect(dashboard().uid).not.toBe(app.uid);
    expect(dashboard().public_id).not.toBe(app.public_id);
  });

  it("draws only widgets this app declares", () => {
    const declared = new Set((manifest.widgets ?? []).map((widget) => widget.id));
    for (const tile of tiles()) {
      expect(declared, `${tile.id} draws ${tile.type}`).toContain(tile.type);
    }
  });

  it("shows every widget this app has", () => {
    // A choice rather than a rule. A companion shipping only some of them
    // leaves the rest with nowhere to be seen unless a guild assembles a
    // dashboard itself, which is the work this listing exists to save.
    expect(new Set(tiles().map((tile) => tile.type))).toEqual(
      new Set((manifest.widgets ?? []).map((widget) => widget.id))
    );
  });

  it("binds each tile to the endpoint its own widget draws from", () => {
    // A tile is filled by whatever its binding names, and the module inside the
    // widget reads whatever id it was written against. Those are two spellings
    // of the same thing and nothing but this compares them — a binding pointing
    // at another endpoint draws zeros with no error anywhere.
    for (const tile of tiles()) {
      const widget = (manifest.widgets ?? []).find((candidate) => candidate.id === tile.type);
      expect(widget?.endpoints, `${tile.id}`).toContain(tile.binding.endpoint_id);
    }
  });

  it("binds only to read endpoints, and only with parameters they declare", () => {
    // Two ways a binding goes quietly wrong. A binding to a write or an
    // emission is a tile nothing draws; a parameter the endpoint does not
    // declare is dropped on the way, so the tile renders and is simply not
    // narrowed by the thing somebody wrote down.
    const reads = new Map(
      (manifest.endpoints ?? [])
        .filter((endpoint) => endpoint.direction === "read")
        .map((endpoint) => [endpoint.id, endpoint])
    );
    for (const tile of tiles()) {
      const read = reads.get(tile.binding.endpoint_id);
      expect(read, `${tile.id} binds ${tile.binding.endpoint_id}`).toBeDefined();

      const declared = new Set((read!.params ?? []).map((param) => param.key));
      for (const key of Object.keys(tile.binding.params ?? {})) {
        expect(declared.has(key), `${tile.id} sets '${key}', which ${read!.id} ignores`).toBe(true);
      }
    }
  });

  it("answers every tile for whoever is looking", () => {
    // A tile drawn from a guild's shared access would show the state of a
    // private repository to members who may have no access to it. So every one
    // of them runs on the caller's own credential: a member who has connected
    // no GitHub account gets a dashboard of tiles asking them to, and a member
    // who has gets exactly what they can see at GitHub.
    for (const tile of tiles()) {
      const read = manifest.endpoints?.find(
        (endpoint) => endpoint.id === tile.binding.endpoint_id
      );
      expect(
        read?.requires?.all_of,
        `${tile.binding.endpoint_id} is answered from something other than the caller`
      ).toContain("account");
    }
  });

  it("lays its widgets out inside the grid", () => {
    const columns = dashboard().layout?.columns ?? 12;
    for (const tile of tiles()) {
      expect((tile.grid?.x ?? 0) + (tile.grid?.w ?? 0)).toBeLessThanOrEqual(columns);
    }
  });
});
