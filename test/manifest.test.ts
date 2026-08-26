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

import { EVENT_TYPES, translate } from "../src/github/events.js";
import { WEBHOOK_EVENTS } from "../src/github/registration.js";
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
    // A feature with no block behind it advertises something the app cannot do,
    // and the platform refuses it — in both directions.
    //
    // `automations` is absent on purpose rather than for want of a block: a
    // node an app contributes is a thing that executes inside somebody's
    // deployment, and what executes stays first-party.
    expect(manifest.features).toEqual(["data", "widgets", "events"]);
    expect(manifest.automation).toBeUndefined();
  });

  it("declares an event vocabulary the code actually produces", () => {
    // The declaration is the contract: this app holds GitHub's webhook
    // connection, so it is the authority on what these mean, and a consumer
    // reads this list to know what it may ask for. A type here that nothing
    // translates would be a subscription that never fires, with the subscriber
    // having no way to find out.
    expect(manifest.events).toEqual([...EVENT_TYPES]);
    expect(manifest.events?.length).toBeGreaterThan(0);
  });

  it("namespaces every event under its own service id", () => {
    // The prefix the platform checks against the emitting registration. A type
    // outside it is refused, and the refusal names a prefix rather than the
    // mistake.
    for (const type of manifest.events ?? []) {
      expect(type.startsWith(`app.${PUBLIC_ID}.`)).toBe(true);
      expect(type.length).toBeGreaterThan(`app.${PUBLIC_ID}.`.length);
    }
  });

  it("subscribes to every delivery it needs to produce those", () => {
    // The registration is a form somebody fills in once. An event handled in
    // code but missing from it simply never arrives — so both come from the
    // same table, and this is what says so.
    expect(WEBHOOK_EVENTS.length).toBeGreaterThan(0);
    for (const delivery of WEBHOOK_EVENTS) {
      expect(translate(delivery, { action: "\u0000none" })).toBeNull();
    }
  });
});

describe("who a source is answered for", () => {
  const sourceById = (id: string) =>
    manifest.data_sources?.find((source) => source.id === id);
  const namedBy = (id: string) => sourceById(id)?.requires?.all_of ?? [];

  it("answers every question from the credential of whoever asked", () => {
    // The rule this file exists to hold, and it is the reverse of what it used
    // to hold. "How many issues are open" is one answer for every member and
    // still not one every member is entitled to: it is the state of a private
    // repository, and answering it from the organization's installation shows
    // that state to members with no access to the repository at all.
    //
    // The app cannot make that judgement — a context token names a guild and an
    // install and nothing about what this person may see. GitHub can, and does,
    // if the call runs on their credential. So every source names one.
    for (const source of manifest.data_sources ?? []) {
      expect(
        namedBy(source.id),
        `${source.id} is answered from something other than the caller`
      ).toContain("account");
    }
  });

  it("costs every member a connection, which is the price of that", () => {
    // Stated as a test because it is the thing somebody will later want to
    // "fix" by making a tile work without one. A member who has connected no
    // GitHub account gets `CONNECTION_REQUIRED` from every tile, and that is
    // correct: the alternative is showing them a private repository's state.
    expect((manifest.widgets ?? []).length).toBeGreaterThan(0);
    for (const widget of manifest.widgets ?? []) {
      expect(widget.requires?.all_of, `${widget.id}`).toContain("account");
    }
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

  it("keeps every source on the read path", () => {
    // This app writes now, and the separation is what keeps that honest: a
    // source is answered on a context token Initiative minted for a dashboard,
    // and a write is answered on a delegation token an automation signed. A
    // source that mutated anything would be a write reachable by whoever can
    // render a widget.
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

  it("says what it will use the member's credential for, writes included", () => {
    const account = manifest.connections?.find((c) => c.id === "account");
    const scopes = account?.access_hint?.scopes ?? [];
    // Shown beside the form, so a member sees what they are authorizing before
    // they do it — and it has to include the writes, because a member's own
    // credential is what an operation runs on wherever there is one. Hiding
    // that behind a list of reads would be asking for one thing and doing
    // another.
    expect(scopes).toContain("issues:write");
    expect(scopes).toContain("pull_requests:write");
    // Still a ceiling rather than a grant: a GitHub App's user token carries
    // the installation's permissions narrowed to what that member already
    // reaches, so a member who cannot write to the repository still cannot.
    //
    // Permissions, not scopes. `repo` is an OAuth app's vocabulary and grants
    // everything that person can reach in every repository they can reach.
    expect(scopes).not.toContain("repo");
    for (const scope of scopes) {
      expect(scope, `${scope} is not a permission:level pair`).toMatch(
        /^[a-z_]+:(read|write)$/
      );
    }
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
