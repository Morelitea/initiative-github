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

  it("answers a question about the repository without asking anyone for an account", () => {
    // The rule this file exists to hold. How many issues are open is one answer
    // for every member, so asking each of them to hand over a personal GitHub
    // account to see it would be asking for a credential to do a job that needs
    // none. It is answered from the organization's installation — which is not
    // a connection, so it is named by nothing here.
    for (const id of ["open-issues", "issue-throughput"]) {
      expect(namedBy(id)).toEqual(["workspace"]);
    }
  });

  it("answers a question about a person from that person's own account", () => {
    // "Waiting on my review" resolves against whoever's credential it runs on,
    // so the caller's is the only one that answers the question asked.
    expect(namedBy("review-queue")).toContain("account");
  });

  it("names the repository setting on every source", () => {
    for (const source of manifest.data_sources ?? []) {
      expect(source.requires?.all_of).toContain("workspace");
    }
  });

  it("asks a widget for no more than its own sources ask for", () => {
    // The failure this catches is invisible from the source side and was live
    // for a release: a tile answered from the guild's own access, requiring the
    // caller's personal account anyway, refuses with `CONNECTION_REQUIRED` for
    // everyone who has not connected one — and the number behind it never
    // needed them.
    for (const widget of manifest.widgets ?? []) {
      const needed = new Set(
        (widget.sources ?? []).flatMap((id) => namedBy(id))
      );
      for (const term of widget.requires?.all_of ?? []) {
        expect(
          needed.has(term),
          `widget ${widget.id} requires ${term}, which none of its sources do`
        ).toBe(true);
      }
    }
  });

  it("writes only as a member, never as the app", () => {
    // An action opens an issue under somebody's name, so it runs on that
    // member's own credential — the issue is theirs, and it stops working when
    // they disconnect. The app has a credential of its own now and this is
    // exactly where it must not be used.
    const automation = manifest.automation as
      | { operations?: Array<{ id: string; requires?: { all_of?: string[] } }> }
      | undefined;
    for (const operation of automation?.operations ?? []) {
      expect(operation.requires?.all_of).toContain("account");
    }
  });
});

describe("the choices this app makes", () => {
  it("asks a person for exactly one credential, and it is their own", () => {
    // The story changed with the GitHub App and got stronger. This app does
    // hold a credential of its own now — the private key its registration is
    // signed with — and it is the only one it will ever hold: it identifies the
    // app rather than a person, it reaches nothing until an organization
    // installs the app, and it stops reaching the moment they remove it.
    //
    // So what is asked of *people* is one thing: a member's own account, for
    // the two answers that are about them. Everything else the app either works
    // out or is granted.
    const reaching = (manifest.connections ?? []).filter((c) => c.access_hint?.api);
    expect(reaching.map((c) => c.id)).toEqual(["account"]);
    expect(reaching[0].scope).toBe("interactive");
  });

  it("asks an admin for a setting, never for a credential", () => {
    // The regression this guards is the easy one to make and hard to see: a
    // `secret` field on a guild connection is somebody's personal access token
    // wearing the guild's name — it carries everything that person can reach,
    // it outlives their interest in the guild, and revoking it means finding
    // whoever minted it.
    const guildWide = (manifest.connections ?? []).filter((c) => c.scope === "static");
    expect(guildWide.length).toBeGreaterThan(0);
    for (const connection of guildWide) {
      for (const field of connection.fields) {
        expect(field.type).not.toBe("secret");
      }
      // No vendor flow either: a static connection is typed, and only an
      // interactive one may carry a connect_path.
      expect(connection.connect_path).toBeUndefined();
    }
  });

  it("says what it will use the member's credential for", () => {
    const account = manifest.connections?.find((c) => c.id === "account");
    // Shown beside the form, so a member sees the write before they authorize
    // rather than after. `issues:write` is there because the automation action
    // opens issues — an app that only read would ask for less, and should.
    expect(account?.access_hint?.scopes).toContain("issues:write");
    // Permissions, not scopes. `repo` is an OAuth app's vocabulary and grants
    // everything that person can reach in every repository they can reach.
    expect(account?.access_hint?.scopes).not.toContain("repo");
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

  it("takes the repository as two fields rather than one", () => {
    // An admin who typed `acme/widgets` into a single box would produce a path
    // with an extra segment in it, and every call would 404 with nothing saying
    // why. Two required fields is the form making that impossible.
    const workspace = manifest.connections?.find((c) => c.id === "workspace");
    expect(workspace?.scope).toBe("static");
    expect(workspace?.fields.map((field) => field.key)).toEqual(["owner", "repo"]);
    for (const field of workspace?.fields ?? []) {
      expect(field.required).toBe(true);
    }
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
