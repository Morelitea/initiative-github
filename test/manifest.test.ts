/**
 * The manifest this app serves is one a deployment will take.
 *
 * This is the test worth copying into your own app. It is cheap, it runs
 * offline, and it fails at the moment you break the manifest rather than when
 * an operator tries to register you.
 *
 * The cases below the first one are about the choices this app makes as a
 * *reference*: least privilege, and asking for nothing it does not use. They
 * are assertions about this app, not about the protocol — but they are the
 * habits the protocol is shaped to reward.
 */

import { describe, expect, it } from "vitest";
import { validateManifest } from "initiative-app-kit";

import { PUBLIC_ID, manifest } from "../src/manifest.config.js";

describe("the manifest", () => {
  it("has nothing the kit can object to", () => {
    expect(validateManifest(manifest)).toEqual([]);
  });

  it("names every route as a path, never an address", () => {
    // A manifest states *which route*; the operator's registration states
    // where. Anything with a scheme in it would be an address.
    const paths = [
      ...(manifest.connections ?? []).map((c) => c.connect_path),
      ...(manifest.data_sources ?? []).map((s) => s.path),
      ...(manifest.embeds ?? []).map((e) => e.path),
    ].filter(Boolean) as string[];

    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path.startsWith("/")).toBe(true);
      expect(path).not.toMatch(/:\/\//);
    }
  });

  it("namespaces every event under its own service id", () => {
    for (const event of manifest.events ?? []) {
      expect(event.startsWith(`app.${PUBLIC_ID}.`)).toBe(true);
    }
  });
});

describe("the choices this app makes", () => {
  it("asks GitHub for read access only", () => {
    // The reference app holds no write credential anywhere, which is what makes
    // it a demonstration of the least-privilege default rather than a claim.
    const account = manifest.connections?.find((c) => c.id === "account");
    const scopes = account?.access_hint?.scopes ?? [];
    expect(scopes.length).toBeGreaterThan(0);
    for (const scope of scopes) {
      expect(scope).not.toMatch(/\b(write|admin|delete)\b/);
    }
  });

  it("asks for the one browser capability its page actually uses", () => {
    // A frame gets nothing it did not name, and a guild admin sees the list at
    // install — so a surface should name what it uses and stop there.
    const board = manifest.embeds?.find((e) => e.id === "board");
    expect(board?.capabilities).toEqual(["clipboard-write"]);
  });

  it("lets a member connect their own account rather than sharing one", () => {
    // GitHub authorizes a person, so the connection is interactive: what the
    // credential reaches is what that member reaches.
    const account = manifest.connections?.find((c) => c.id === "account");
    expect(account?.scope).toBe("interactive");
    expect(account?.connect_path).toBeTruthy();
    // And nothing for anyone to type: the vendor flow produces it.
    expect(account?.fields).toEqual([]);
  });

  it("ships sample data so a preview renders with no network call", () => {
    for (const widget of manifest.widgets ?? []) {
      expect(widget.sample_data).toBeDefined();
      for (const source of widget.sources ?? []) {
        expect(Object.keys(widget.sample_data ?? {})).toContain(source);
      }
    }
  });
});
