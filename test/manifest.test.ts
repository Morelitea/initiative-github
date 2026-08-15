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
import { appDocument, validateDocument, validateManifest } from "initiative-app-kit";

import { PUBLIC_ID, manifest } from "../src/manifest.config.js";

/** The opaque block, typed just enough for these assertions. */
const automation = () =>
  (manifest.automation ?? {}) as {
    contract?: number;
    domain?: { id?: string };
    nodes?: Array<{
      key: string;
      category: string;
      event?: string;
      operation?: string;
      fields?: Array<{ type: string }>;
    }>;
    operations?: Array<{ id: string; path: string }>;
  };

describe("the manifest", () => {
  it("has nothing the kit can object to", () => {
    expect(validateManifest(manifest)).toEqual([]);
  });

  it("is servable as the document a registrar fetches", () => {
    // The assertion above passes for a manifest that cannot be registered at
    // all: a registrar never fetches a bare `Manifest`, it fetches the envelope
    // around it. This app served the bare one and was unregisterable, with
    // nothing on either side saying so — hence both checks, not one.
    const document = appDocument(manifest);

    expect(validateDocument(document)).toEqual([]);
    expect(document.protocol_version).toBe(1);
    expect(document.public_id).toBe(PUBLIC_ID);
    expect(document.kind).toBe("app");
    expect(document.definition).toBe(manifest);
  });

  it("names every route as a path, never an address", () => {
    // A manifest states *which route*; the operator's registration states
    // where. Anything with a scheme in it would be an address.
    const paths = [
      ...(manifest.connections ?? []).map((c) => c.connect_path),
      ...(manifest.data_sources ?? []).map((s) => s.path),
      ...(manifest.embeds ?? []).map((e) => e.path),
      ...(automation().operations ?? []).map((o: { path: string }) => o.path),
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

describe("the automation surface", () => {
  it("declares a domain and a contract version", () => {
    expect(automation().contract).toBe(1);
    expect(automation().domain?.id).toBeTruthy();
  });

  it("only triggers on events this manifest actually emits", () => {
    // A trigger naming an event the app never emits could never fire, and
    // nothing downstream would say so.
    const emitted = new Set(manifest.events ?? []);
    for (const node of automation().nodes ?? []) {
      if (node.category !== "trigger") continue;
      expect(node.event).toBeTruthy();
      expect(emitted.has(node.event!)).toBe(true);
    }
  });

  it("only acts through operations this manifest serves", () => {
    const served = new Set((automation().operations ?? []).map((o) => o.id));
    for (const node of automation().nodes ?? []) {
      if (node.category !== "action") continue;
      expect(node.operation).toBeTruthy();
      expect(served.has(node.operation!)).toBe(true);
    }
  });

  it("keeps secrets out of node config", () => {
    // A node's config lives in an automation's graph and is shown in an editor.
    // A credential belongs in a connection, which is held in custody.
    for (const node of automation().nodes ?? []) {
      for (const field of node.fields ?? []) {
        expect(field.type).not.toBe("secret");
      }
    }
  });

  it("has both directions — something to start on, something to do", () => {
    const categories = new Set((automation().nodes ?? []).map((n) => n.category));
    expect(categories.has("trigger")).toBe(true);
    expect(categories.has("action")).toBe(true);
  });
});

describe("who a source is answered for", () => {
  const sourceById = (id: string) =>
    manifest.data_sources?.find((source) => source.id === id);
  const namedBy = (id: string) => sourceById(id)?.requires?.all_of ?? [];

  it("answers a question about the repository from the guild's own access", () => {
    // The rule this file exists to hold. How many issues are open is one
    // answer for every member, so asking each of them to hand over a personal
    // GitHub account to see it would be asking for a credential to do a job
    // that needs none.
    for (const id of ["open-issues", "issue-throughput"]) {
      expect(namedBy(id)).toContain("shared_account");
      expect(namedBy(id)).not.toContain("account");
    }
  });

  it("answers a question about a person from that person's own account", () => {
    // "Waiting on my review" resolves against whoever's credential it runs on,
    // so the caller's is the only one that answers the question asked.
    expect(namedBy("review-queue")).toContain("account");
    expect(namedBy("review-queue")).not.toContain("shared_account");
  });

  it("names the repository setting on every source", () => {
    for (const source of manifest.data_sources ?? []) {
      expect(source.requires?.all_of).toContain("workspace");
    }
  });

  it("writes only as a member, never as the guild", () => {
    // An action opens an issue under somebody's name, so it runs on that
    // member's own credential — the issue is theirs, and it stops working when
    // they disconnect.
    const automation = manifest.automation as
      | { operations?: Array<{ id: string; requires?: { all_of?: string[] } }> }
      | undefined;
    for (const operation of automation?.operations ?? []) {
      expect(operation.requires?.all_of).toContain("account");
      expect(operation.requires?.all_of).not.toContain("shared_account");
    }
  });
});

describe("the choices this app makes", () => {
  it("holds no credential of its own — every one belongs to somebody", () => {
    // This app does write at GitHub (the create-issue action), so the
    // least-privilege story is not "read only". It is that no credential here
    // is the app's: each is either a member's, authorized by them and gone
    // when they disconnect, or the guild's, supplied by an admin and gone when
    // they clear it. Nothing is shared between guilds and nothing is the
    // vendor's view of this app as a party in its own right.
    const reaching = (manifest.connections ?? []).filter((c) => c.access_hint?.api);
    expect(reaching.length).toBeGreaterThan(0);
    for (const connection of reaching) {
      expect(["interactive", "static"]).toContain(connection.scope);
    }
    // And the two tiers are both actually present, since the whole scoping
    // story collapses if one of them quietly goes away.
    const scopes = new Set(reaching.map((c) => c.scope));
    expect(scopes).toEqual(new Set(["interactive", "static"]));
  });

  it("says what it will use each credential for", () => {
    const account = manifest.connections?.find((c) => c.id === "account");
    // Shown beside the form at install, so an admin sees the write scope
    // before anybody authorizes rather than after.
    expect(account?.access_hint?.scopes).toContain("repo");

    // The shared one is asked to read and nothing else — which is the point of
    // having split it out.
    const shared = manifest.connections?.find((c) => c.id === "shared_account");
    expect(shared?.access_hint?.scopes).toEqual(["issues:read"]);
  });

  it("mounts no embedded surface", () => {
    // Everything this app offers lands inside Initiative's own surfaces —
    // widgets and automation nodes — rather than in an iframe holding a second
    // UI. An embed is for an app whose product *is* a page.
    expect(manifest.embeds).toBeUndefined();
    expect(manifest.features).not.toContain("embeds");
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

  it("takes the guild's shared access as a secret, from an admin", () => {
    const shared = manifest.connections?.find((c) => c.id === "shared_account");
    // Static, so it is the install's rather than any member's, and one admin
    // fills it in once for everyone.
    expect(shared?.scope).toBe("static");
    // No vendor flow: a static connection is typed, and only an interactive
    // one may carry a connect_path.
    expect(shared?.connect_path).toBeUndefined();
    // `secret` rather than `string`, so it is sealed at rest and never read
    // back to the form.
    expect(shared?.fields.map((field) => field.type)).toEqual(["secret"]);
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
