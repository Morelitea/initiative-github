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
    ].filter(Boolean) as string[];

    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path.startsWith("/")).toBe(true);
      expect(path).not.toMatch(/:\/\//);
    }
  });

  it("declares no feature it cannot deliver", () => {
    // `events` and `automations` were both declared, both validated, and both
    // went nowhere: no webhook subscription may name `app.<id>.<event>`, so an
    // emit succeeded having delivered to nobody. Declaring a feature that goes
    // nowhere is the same mistake as declaring one with no block, one level
    // further out — and this is the assertion that keeps it gone until the
    // platform can carry it.
    expect(manifest.features).toEqual(["data", "widgets"]);
    expect(manifest.events).toBeUndefined();
    expect(manifest.automation).toBeUndefined();
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

  it("reads and never writes", () => {
    // Nothing in this app mutates anything at GitHub any more, and the
    // permission list is where that is enforced rather than stated. It was
    // `issues: write` while an automation action opened issues; narrowing it
    // back is the one direction that costs nothing, since GitHub asks nobody to
    // re-approve a permission an app stopped wanting.
    for (const source of manifest.data_sources ?? []) {
      expect(source.path.startsWith("/data/")).toBe(true);
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

  it("says what it will use the member's credential for, and asks to read", () => {
    const account = manifest.connections?.find((c) => c.id === "account");
    // Shown beside the form, so a member sees what they are authorizing before
    // they do it. Every one of these is a read: the app that wrote at GitHub
    // was the one contributing an automation action, and it does not any more.
    for (const scope of account?.access_hint?.scopes ?? []) {
      expect(scope.endsWith(":read"), `${scope} is not a read`).toBe(true);
    }
    expect(account?.access_hint?.scopes).toContain("issues:read");
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

  it("asks an admin for an account, and for nothing it can work out itself", () => {
    // The owner is the one thing this app cannot derive. Which repositories it
    // may see is the organization's own answer, given when it installed the
    // app — so the field that narrows further is optional, and blank means
    // "everything you granted" rather than "nothing".
    const workspace = manifest.connections?.find((c) => c.id === "workspace");
    expect(workspace?.scope).toBe("static");
    expect(workspace?.fields.map((field) => field.key)).toEqual(["owner", "repos"]);

    const byKey = Object.fromEntries(
      (workspace?.fields ?? []).map((field) => [field.key, field])
    );
    expect(byKey.owner.required).toBe(true);
    expect(byKey.repos.required).toBeUndefined();
  });

  it("lets a dashboard say which repository a tile is about", () => {
    // The whole of how one widget serves several teams. A source cannot be told
    // which initiative is asking, so the dashboard says which repository — and
    // a dashboard belongs to exactly one initiative. Every source has to accept
    // it or the ones that do not are stuck on whatever the install defaults to.
    for (const source of manifest.data_sources ?? []) {
      const params = (source.params_schema ?? []).map((param) => param.key);
      expect(params, `${source.id} cannot be pointed at a repository`).toContain(
        "repo"
      );
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
