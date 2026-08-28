/**
 * The manifest this app serves is one a deployment will take.
 *
 * Cheap, offline, and it fails the moment the manifest breaks rather than when
 * an operator tries to register the app — which is the only other place anybody
 * would find out.
 *
 * Most of what follows is not the protocol's rules but this app's own: every
 * permission has something behind it, every source runs on the caller's
 * credential, and a widget never asks for more than its endpoints do. Each is a
 * decision that would otherwise be re-made by accident.
 */

import { describe, expect, it } from "vitest";
import { appDocument, validateDocument, validateManifest } from "initiative-app-kit";

import { EMIT_ENDPOINTS, EMITTED, translate } from "../src/endpoints/emissions.js";
import { WEBHOOK_EVENTS } from "../src/github/app.js";
import { INSTALL_PATH, READ_IDS } from "../src/vocabulary.js";
import { WRITES } from "../src/endpoints/index.js";
import { PUBLIC_ID, manifest } from "../src/manifest.config.js";

/** What the writes say about themselves, off the list that implements them. */
const WRITE_DECLARATIONS = WRITES.map((write) => write.declaration);

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
    expect(manifest.features).toEqual(["dashboards", "endpoints", "widgets"]);
  });

  it("declares one vocabulary for every direction", () => {
    // The declaration is the contract, and it is one list: what this app
    // answers, what it does, and what it announces. A caller resolves an id
    // without being told which kind it is first, which is the whole reason
    // reads, writes and emissions share a namespace.
    const byDirection = (direction: string) =>
      (manifest.endpoints ?? []).filter((e) => e.direction === direction);

    // Ten reads, and none of them a tile: each is a question at GitHub, and a
    // widget draws one of these rather than one of its own.
    expect(byDirection("read").map((e) => e.id).sort()).toEqual(
      Object.values(READ_IDS).slice().sort()
    );
    expect(byDirection("write")).toEqual([...WRITE_DECLARATIONS]);
    expect(byDirection("emit").map((e) => e.id)).toEqual([...EMITTED]);
  });

  it("namespaces every endpoint under its own service id", () => {
    // The prefix the platform checks against the declaring registration. An id
    // outside it is refused, and the refusal names a prefix rather than the
    // mistake.
    for (const endpoint of manifest.endpoints ?? []) {
      expect(endpoint.id.startsWith(`app.${PUBLIC_ID}.`)).toBe(true);
      expect(endpoint.id.length).toBeGreaterThan(`app.${PUBLIC_ID}.`.length);
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

describe("who an endpoint is answered for", () => {
  const reads = () => (manifest.endpoints ?? []).filter((e) => e.direction === "read");
  const byId = (id: string) => manifest.endpoints?.find((e) => e.id === id);
  const namedBy = (id: string) => byId(id)?.requires?.all_of ?? [];

  it("answers every question from the credential of whoever asked", () => {
    // The rule this file exists to hold. "How many issues are open" is one
    // answer for every member and still not one every member is entitled to:
    // it is the state of a private repository, and answering it from the
    // organization's installation would show that state to members with no
    // access to the repository at all.
    //
    // The app cannot make that judgement — a context token names a guild and an
    // install and nothing about what this person may see. GitHub can, and does,
    // if the call runs on their credential. So every read names one.
    for (const read of reads()) {
      expect(
        namedBy(read.id),
        `${read.id} is answered from something other than the caller`
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

  it("names the repository setting on every read", () => {
    for (const read of reads()) {
      expect(read.requires?.all_of).toContain("workspace");
    }
  });

  it("asks a widget for no more than its own endpoints ask for", () => {
    // A tile that requires more than what fills it refuses with
    // `CONNECTION_REQUIRED` for people the number behind it never needed.
    for (const widget of manifest.widgets ?? []) {
      const needed = new Set((widget.endpoints ?? []).flatMap((id) => namedBy(id)));
      for (const term of widget.requires?.all_of ?? []) {
        expect(
          needed.has(term),
          `widget ${widget.id} requires ${term}, which none of its endpoints do`
        ).toBe(true);
      }
    }
  });

  it("separates what a widget may reach from what a caller may do", () => {
    // One route serves both directions, so `direction` is what keeps them
    // apart rather than the URL somebody found. A widget binds reads only, and
    // the platform will not mint a token for an id the tile does not name — so
    // rendering a dashboard cannot reach a write.
    const readable = new Set(
      (manifest.endpoints ?? []).filter((e) => e.direction === "read").map((e) => e.id)
    );
    for (const widget of manifest.widgets ?? []) {
      for (const id of widget.endpoints ?? []) {
        expect(readable.has(id), `${widget.id} binds ${id}`).toBe(true);
      }
    }
  });
});

describe("the choices this app makes", () => {
  it("asks a person for exactly one credential, and it is their own", () => {
    // This app holds one credential of its own — the private key its
    // registration is signed with — and it is the only one it will ever hold:
    // it identifies the app rather than a person, it reaches nothing until an
    // organization installs the app, and it stops reaching the moment they
    // remove it.
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
      // A guild connection may run a vendor flow of its own, and this one
      // does. What it must not do is end by holding a person's credential: an
      // install flow records an installation, and the only field kinds here
      // are the facts GitHub reported about it.
      expect(connection.access_hint).toBeUndefined();
    }
  });

  it("says what it will use the member's credential for, writes included", () => {
    const account = manifest.connections?.find((c) => c.id === "account");
    const scopes = account?.access_hint?.scopes ?? [];
    // Shown beside the form, so a member sees what they are authorizing before
    // they do it — and it has to include the writes, because a member's own
    // credential is what a write runs on wherever there is one. Hiding
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
    // widgets, and the companion dashboard arranging them — rather than in an
    // iframe holding a second UI. An embed is for an app whose product *is* a
    // page, and this one's is a set of tiles.
    expect(manifest.embeds).toBeUndefined();
    expect(manifest.features).not.toContain("embeds");
  });

  it("lets a member connect their own account rather than sharing one", () => {
    // GitHub authorizes a person, so the connection is interactive: what the
    // credential reaches is what that member reaches.
    const account = manifest.connections?.find((c) => c.id === "account");
    expect(account?.scope).toBe("interactive");
    expect(account?.connect_path).toBeTruthy();

    // And nothing for anyone to type: the vendor flow produces it, so every
    // field is `managed`. There has to be at least one — the platform can never
    // satisfy a connection that declares none, so a member who connected would
    // be told to connect forever.
    expect(account?.fields.length).toBeGreaterThan(0);
    for (const field of account?.fields ?? []) {
      expect(field.managed, `${field.key} is typed by a person`).toBe(true);
      expect(field.required, `${field.key} is required of a person`).toBeUndefined();
    }
  });

  it("stores a name against the connection, never a credential", () => {
    // What the platform holds for a member is a login. The token stays sealed
    // in this app's own database — Initiative learns that somebody connected
    // and as whom, and holds nothing that could act for them.
    const account = manifest.connections?.find((c) => c.id === "account");
    for (const field of account?.fields ?? []) {
      expect(field.type, `${field.key} is a secret`).not.toBe("secret");
    }
    expect(account?.fields.map((field) => field.key)).toEqual(["account_login"]);
  });

  it("has an admin install at GitHub rather than describe an install", () => {
    // The boundary is still the whole of what this install is about, and it is
    // no longer typed. An owner in a text box is a claim that some account
    // somewhere installed this app; nothing checked it, and a typo was an
    // install that looked configured and answered nothing.
    //
    // So: a `connect_path` that sends a guild admin to GitHub's own install
    // page, and three fields that are all `managed` — written by this app from
    // what GitHub said when they came back. Required, still, and for the same
    // reason: a blank repository list read as "everything the account has"
    // would make the widest possible setting the one nobody chose.
    const workspace = manifest.connections?.find((c) => c.id === "workspace");
    expect(workspace?.scope).toBe("static");
    expect(workspace?.connect_path).toBe(INSTALL_PATH);
    expect(workspace?.fields.map((field) => field.key)).toEqual([
      "owner",
      "installation_id",
      "repos",
    ]);

    for (const field of workspace?.fields ?? []) {
      expect(field.required, `${field.key} is optional`).toBe(true);
      expect(field.managed, `${field.key} is typed`).toBe(true);
    }
  });

  it("lets a dashboard say which repository a tile is about", () => {
    // The whole of how one widget serves several teams. A read cannot be told
    // which initiative is asking, so the dashboard says which repository — and
    // a dashboard belongs to exactly one initiative. Every read that resolves
    // one has to accept it, or the ones that do not are stuck on whatever the
    // install defaults to.
    //
    // Four do not resolve a repository, and they are listed rather than
    // detected so that a fifth cannot join them quietly. Two are about the
    // account — which repositories there are, and which boards it has — and the
    // other two name a board by id. A `repo` on any of them would be a
    // parameter accepted and ignored.
    const ACCOUNT_WIDE = [
      READ_IDS.listRepositories,
      READ_IDS.listProjects,
      READ_IDS.listProjectFields,
      READ_IDS.listProjectOptions,
    ];
    for (const read of (manifest.endpoints ?? []).filter((e) => e.direction === "read")) {
      const params = (read.params ?? []).map((param) => param.key);
      if (ACCOUNT_WIDE.includes(read.id)) {
        expect(params, `${read.id} resolves no repository`).not.toContain("repo");
        continue;
      }
      expect(params, `${read.id} cannot be pointed at a repository`).toContain("repo");
    }
  });

  it("labels every parameter a person is asked to fill in", () => {
    // Reads and writes both. A bare key is enough for a machine and leaves
    // whoever is wiring up an automation guessing at `option_id`.
    for (const endpoint of manifest.endpoints ?? []) {
      for (const param of endpoint.params ?? []) {
        expect(param.label.en, `${endpoint.id}/${param.key}`).toBeTruthy();
      }
    }
  });

  it("draws from the ids it binds, in the module itself", () => {
    // The id is spelled three times — the binding, the sample rows, and the
    // module's own lookup — and only the first two are data this file can
    // cross-check. The third is a string inside a string, so it is asserted
    // here: a module reading a key nothing supplies draws zeros with no error
    // anywhere, which is the quietest way a widget can be wrong.
    for (const widget of manifest.widgets ?? []) {
      for (const id of widget.endpoints ?? []) {
        expect(
          widget.module_source.includes(JSON.stringify(id)),
          `${widget.id} does not read ${id}`
        ).toBe(true);
      }
    }
  });

  it("ships sample data so a preview renders with no network call", () => {
    for (const widget of manifest.widgets ?? []) {
      expect(widget.sample_data).toBeDefined();
      for (const id of widget.endpoints ?? []) {
        expect(Object.keys(widget.sample_data ?? {})).toContain(id);
      }
    }
  });
});

describe("what an endpoint says about itself", () => {
  const endpoints = () => manifest.endpoints ?? [];

  // The languages everything else this app declares is written in. An endpoint
  // that names itself in one of them is an endpoint half of Initiative reads in
  // English regardless of what they picked.
  const LANGUAGES = ["en", "de", "es", "fr"];

  it("names and describes every one of them, in all four languages", () => {
    // An endpoint is also a step on somebody's automation canvas, and a canvas
    // with no label has to scrape a title off the id — which cannot be
    // translated and cannot say anything the id does not.
    for (const endpoint of endpoints()) {
      expect(Object.keys(endpoint.label ?? {}).sort(), `${endpoint.id} label`).toEqual(LANGUAGES.slice().sort());
      expect(Object.keys(endpoint.description ?? {}).sort(), `${endpoint.id} description`).toEqual(LANGUAGES.slice().sort());
    }
  });

  it("names an emission most of all", () => {
    // The one endpoint chosen without ever being called: a consumer building a
    // menu of triggers has the declaration and nothing else.
    for (const emission of endpoints().filter((e) => e.direction === "emit")) {
      expect(emission.label?.en, emission.id).toBeTruthy();
      expect(emission.returns?.length, `${emission.id} announces nothing`).toBeGreaterThan(0);
    }
  });

  it("files all twenty into a handful of drawers", () => {
    // A heading, not another level of nesting. Twenty in one flat list is the
    // thing this exists to avoid, and twenty drawers would be the same list
    // wearing a hat.
    const groups = new Set(endpoints().map((endpoint) => endpoint.group));
    expect(groups.has(undefined), "an endpoint with no group falls out of the drawers").toBe(false);
    expect([...groups].sort()).toEqual([
      "issues",
      "projects",
      "repositories",
      "reviews",
      "security",
    ]);
  });

  it("returns nothing twice under one name", () => {
    // A consumer binds by name, so one of the two would silently never be
    // reachable.
    for (const endpoint of endpoints()) {
      const keys = (endpoint.returns ?? []).map((value) => value.key);
      expect(new Set(keys).size, `${endpoint.id} returns a name twice`).toBe(keys.length);
    }
  });

  it("labels a return only where its key does not already say it", () => {
    // A return's key IS the word a caller reads it by, so `title` labelled
    // "Title" in four languages is four strings that say what `key` said — and
    // a fifth language nobody wrote makes the set incomplete rather than the
    // value unreadable. What earns a label is a fact the key does not carry:
    // `head_ref` is a branch but not which end, `created_at` on an issue is
    // when it was *opened*, `count` beside `total` is which of the two.
    const echoes = (key: string) => key.replace(/_/g, " ").toLowerCase();
    for (const endpoint of endpoints()) {
      for (const value of endpoint.returns ?? []) {
        const label = value.label?.en;
        if (!label) continue;
        expect(label.toLowerCase(), `${endpoint.id}/${value.key} is labelled with its own key`)
          .not.toBe(echoes(value.key));
      }
    }
  });

  it("translates every label it does write", () => {
    // The other half of the rule. A label is worth four languages or it is
    // worth none; one written in English alone is the case a member in another
    // language reads raw, which is worse than the key they could have read.
    for (const endpoint of endpoints()) {
      for (const value of endpoint.returns ?? []) {
        if (!value.label) continue;
        expect(Object.keys(value.label).sort(), `${endpoint.id}/${value.key}`).toEqual([
          "de",
          "en",
          "es",
          "fr",
        ]);
      }
    }
  });

  it("says why there is no answer, on every read", () => {
    // Unavailability travels in the body rather than as a status — a widget
    // draws "connect your account" and draws nothing at all from a 4xx — which
    // makes it part of every read's shape rather than an error path. An
    // automation binding `total` and quietly getting nothing is the failure.
    for (const read of endpoints().filter((e) => e.direction === "read")) {
      const keys = (read.returns ?? []).map((value) => value.key);
      expect(keys, `${read.id} cannot say why it has no answer`).toContain("unavailable");
    }
  });

  it("claims no subject, because nothing here needs the run to be about one", () => {
    // Every endpoint here NAMES what it acts on — a repository, an issue
    // number, a board — which is exactly what makes them reusable from a
    // nightly schedule that is about nothing at all. Claiming a need this app
    // does not have warns somebody off an arrangement that would have worked.
    for (const endpoint of endpoints()) {
      expect(endpoint.needs_subject, endpoint.id).toBeUndefined();
    }
  });

  it("says nothing about how a caller should ASK for any of it", () => {
    // The rule this manifest keeps and the reason `picker` and everything
    // after it is gone: a repository picker is a decision about somebody
    // else's product, and this app is not the party making it. What this app
    // owes is a read that answers "which repositories can you see" — which is
    // `list-repositories`, and it is right there.
    const surface = ["resource", "source", "default", "optional", "constraints"];
    for (const endpoint of endpoints()) {
      for (const param of endpoint.params ?? []) {
        for (const term of surface) {
          expect(term in param, `${endpoint.id}/${param.key}.${term}`).toBe(false);
        }
        // A written label on a choice is the same mistake one level down.
        for (const option of param.options ?? []) {
          expect(typeof option, `${endpoint.id}/${param.key}`).toBe("string");
        }
      }
      for (const value of endpoint.returns ?? []) {
        expect("filter" in value, `${endpoint.id}/${value.key}.filter`).toBe(false);
      }
    }
  });

  it("answers every list a caller could need to fill a control", () => {
    // The other half of the same fact. Saying nothing about pickers is only
    // honest if the lists behind them exist: a repository, a repository's
    // labels, a board, a board's fields, and one field's values.
    const reads = new Set(
      endpoints()
        .filter((endpoint) => endpoint.direction === "read")
        .map((endpoint) => endpoint.id)
    );
    for (const id of [
      READ_IDS.listRepositories,
      READ_IDS.listLabels,
      READ_IDS.listProjects,
      READ_IDS.listProjectFields,
      READ_IDS.listProjectOptions,
    ]) {
      expect(reads.has(id), id).toBe(true);
    }
  });

  it("holds several values wherever GitHub takes several", () => {
    // Cardinality survived the pruning because it is a fact about the VALUE: a
    // caller building a request has to know whether this takes an array, and
    // only this app can say. These were comma-separated strings by convention.
    const lists = endpoints().flatMap((endpoint) =>
      (endpoint.params ?? []).filter((param) => param.list).map((param) => param.key)
    );
    expect(new Set(lists)).toEqual(
      new Set(["labels", "assignees", "add", "remove", "reviewers", "team_reviewers"])
    );
  });

  it("says what a write touched, and says it the same way an emission does", () => {
    // The join that closes echo suppression, and the only thing about it that
    // matters: an automation service can keep a change this app made from
    // firing that same automation again ONLY if `open-issue` and
    // `issue-opened` describe an issue identically. Two `kind`s that disagreed
    // by a word would look configured and suppress nothing.
    const byKind = new Map<string, Set<string>>();
    for (const endpoint of endpoints()) {
      if (!endpoint.identity) continue;
      const shapes = byKind.get(endpoint.identity.kind) ?? new Set();
      shapes.add(JSON.stringify(endpoint.identity.key));
      byKind.set(endpoint.identity.kind, shapes);
    }
    // One key per kind, whoever declares it.
    for (const [kind, shapes] of byKind) {
      expect([...shapes], kind).toHaveLength(1);
    }
    // And the issue kind is declared on both sides of the wire, which is what
    // makes it a join rather than a label.
    const issueSides = new Set(
      endpoints()
        .filter((endpoint) => endpoint.identity?.kind === "issue")
        .map((endpoint) => endpoint.direction)
    );
    expect(issueSides).toEqual(new Set(["write", "emit"]));
  });

  it("declares an identity on every write and every emission", () => {
    for (const endpoint of endpoints()) {
      if (endpoint.direction === "read") {
        expect(endpoint.identity, endpoint.id).toBeUndefined();
      } else {
        expect(endpoint.identity, endpoint.id).toBeDefined();
      }
    }
  });

});

describe("what an emission promises to carry", () => {
  /**
   * One delivery of each kind this app publishes, as GitHub sends it.
   *
   * Written out rather than derived, because the point is to check the
   * declaration against a payload built the way a real one is. The last
   * assertion is what keeps the table honest: an emission added without a
   * delivery here fails rather than going unchecked.
   */
  const DELIVERIES = [
    {
      event: "issues",
      payload: {
        action: "opened",
        repository: { name: "widgets", owner: { login: "acme" } },
        issue: {
          number: 7,
          title: "It broke",
          html_url: "https://gh/7",
          user: { login: "someone" },
          labels: [{ name: "bug" }],
        },
      },
    },
    {
      event: "issues",
      payload: {
        action: "closed",
        repository: { name: "widgets", owner: { login: "acme" } },
        issue: {
          number: 7,
          title: "It broke",
          html_url: "https://gh/7",
          user: { login: "someone" },
          labels: [],
        },
      },
    },
    {
      event: "pull_request",
      payload: {
        action: "review_requested",
        repository: { name: "widgets", owner: { login: "acme" } },
        pull_request: {
          number: 8,
          title: "Fix it",
          html_url: "https://gh/8",
          user: { login: "someone" },
        },
        requested_reviewer: { login: "reviewer" },
      },
    },
  ];

  it("sends exactly the fields it declared, on every one of them", () => {
    // The declaration is what an automation wires a later step to, before this
    // app has ever fired. A field promised here and not sent leaves that step
    // reading nothing, and one sent without being promised cannot be wired to
    // at all — both are silent, which is why this is a test.
    for (const delivery of DELIVERIES) {
      const translated = translate(delivery.event, delivery.payload);
      expect(translated, `${delivery.event}/${delivery.payload.action}`).not.toBeNull();

      const declared = EMIT_ENDPOINTS.find((e) => e.id === translated!.endpoint);
      expect(declared, `${translated!.endpoint} is announced but not declared`).toBeDefined();

      expect(Object.keys(translated!.payload).sort()).toEqual(
        (declared!.returns ?? []).map((value) => value.key).sort()
      );
    }
  });

  it("says which of them is a list, because a list fills no single slot", () => {
    // `labels` is the only one, and saying so is what lets a consumer with
    // room for exactly one value refuse it when somebody wires it up rather
    // than discover at run time that it was handed several.
    for (const emission of EMIT_ENDPOINTS) {
      for (const value of emission.returns ?? []) {
        expect(value.list === true, `${emission.id}/${value.key}`).toBe(value.key === "labels");
      }
    }
  });

  it("covers every emission this app publishes", () => {
    const covered = DELIVERIES.map((delivery) => translate(delivery.event, delivery.payload)?.endpoint);
    expect([...new Set(covered)].sort()).toEqual([...EMITTED].sort());
  });
});
