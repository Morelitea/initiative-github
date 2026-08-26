/**
 * What this app tells a deployment it is.
 *
 * Authored in TypeScript and built to `manifest.json`, so the compiler catches
 * a malformed manifest before `initiative-app validate` does and before a
 * deployment does. `npm run manifest` writes it.
 *
 * Read this file first if you are starting an app. It is the whole surface: a
 * connection each vendor account authorizes, sources the platform fetches, and
 * widgets drawn from those sources. Nothing here is an address — every route is
 * a path, and the operator's registration says where the app lives.
 *
 * **No embedded page.** This app deliberately mounts no surface of its own:
 * everything it offers lands inside Initiative's own — dashboard widgets, and
 * the companion dashboard that arranges them — rather than in an iframe holding
 * a second UI. An embed is for an app whose product *is* a page; an integration
 * is better as parts.
 */

import type { Manifest } from "initiative-app-kit";

import { EVENT_TYPES } from "./github/events.js";
import { PERMISSIONS } from "./github/registration.js";
import { PUBLIC_ID } from "./public-id.js";
import { CONNECT_PATH } from "./routes.js";

/**
 * Namespaces everything this app publishes.
 *
 * Re-exported rather than declared, because the event vocabulary is namespaced
 * under it and lives in a module this one imports — see `public-id.ts`.
 */
export { PUBLIC_ID };

/**
 * What an admin is shown that this app will be able to do, in GitHub's own
 * words, read from the registration rather than restated beside it.
 *
 * A GitHub App has permissions, not scopes — `issues: write` rather than
 * `repo` — and the difference is worth seeing at install time, because it is
 * the difference between "this app can act on issues in the repositories we
 * chose" and "this app can do anything we can do, in everything we own".
 */
const ACCESS_HINT_SCOPES = Object.entries(PERMISSIONS).map(
  ([permission, level]) => `${permission}:${level}`
);

/**
 * What is *not* here, and where it goes.
 *
 * This file is the `definition` — what the app declares. The document served at
 * `/.well-known/initiative-app.json` wraps it with the identity a registration
 * is matched by, built by `appDocument` in `server.ts`. A `Manifest` served bare
 * is well-formed and unregisterable, which is worth knowing before you write
 * the route.
 *
 * The envelope also carries the catalog `uid` — publisher-assigned, immutable,
 * the id that ties a verified registration to its listing. This app passes none,
 * so it registers and names no listing: fine for a reference nobody installs
 * from a catalog, and the one thing to change first if you publish yours.
 */

export const manifest: Manifest = {
  app_kind: "service",
  service: { public_id: PUBLIC_ID, protocol: 1 },

  // Declared and cross-checked against the blocks below, in both directions.
  // A feature with no block would advertise something this app cannot do.
  //
  // `events` is the contract, and it belongs here rather than only on the wire
  // for that reason: this app holds GitHub's webhook connection, so it is the
  // authority on what a GitHub event means here, and a consumer reads this list
  // to know what it may ask for. Delivery itself does not go through Initiative
  // — see `../events.ts`.
  //
  // `automations` is not declared and will not be. A node an app contributes is
  // a thing that executes inside somebody's deployment, and what executes stays
  // first-party.
  features: ["data", "widgets", "events"],

  default_name: "GitHub",

  connections: [
    {
      // The member's own GitHub account, and **everything here runs on it** —
      // every widget, every source, and a write wherever there is a member to
      // attribute it to.
      //
      // That is the whole permission model. A source cannot ask Initiative
      // whether this person may see a private repository, because a context
      // token names a guild and an install and nothing about what they may
      // reach. GitHub can answer that, and does, if the call runs on their
      // credential. So the app stops deciding and lets the repository's own
      // permissions decide.
      //
      // The cost is that connecting is not optional: a member who has not gets
      // `CONNECTION_REQUIRED` from every tile. That is the correct answer — the
      // alternative is showing them the state of a repository they are not on.
      //
      // GitHub authorizes a *person*, so the app holds one credential per
      // person. Installing never waits for anybody to do this.
      id: "account",
      scope: "interactive",
      label: {
        en: "Your GitHub account",
        de: "Dein GitHub-Konto",
        es: "Tu cuenta de GitHub",
        fr: "Votre compte GitHub",
      },
      // One field, and nobody types it. The vendor flow produces the
      // credential, this app holds it sealed, and what goes here is the GitHub
      // login it was obtained for — `managed`, so only the app may write it.
      //
      // It is not decoration and it is not a credential. The platform decides
      // whether a per-member connection is satisfied from what is *stored
      // against it*, and a connection declaring no fields can never be
      // satisfied by anything — so with `fields: []` a member could authorize
      // GitHub, have their token sealed here, and still be told to connect by
      // every tile they own, permanently.
      //
      // Writing the login rather than the token is the deliberate half: the
      // platform learns that this member connected and as whom, and holds
      // nothing that could act on their behalf.
      fields: [
        {
          key: "account_login",
          type: "string",
          managed: true,
          label: {
            en: "GitHub login",
            de: "GitHub-Anmeldename",
            es: "Usuario de GitHub",
            fr: "Identifiant GitHub",
          },
        },
      ],
      connect_path: CONNECT_PATH,
      access_hint: {
        api: "GitHub",
        // What a GitHub App's user token can do is the installation's
        // permissions narrowed to what this member already reaches — so what is
        // shown here is the app's registration, and it is a ceiling rather than
        // a grant. A member who cannot see the repository still cannot.
        scopes: ACCESS_HINT_SCOPES,
      },
    },
    {
      // The only thing an admin types: which repository this guild cares
      // about. Not a credential — a setting — but it rides the same form
      // machinery.
      //
      // It says *which* repository, and never who may see it. Naming one here
      // grants nobody anything: the call still runs on the caller's own GitHub
      // credential, so a member who is not on that repository gets GitHub's own
      // answer about it, which is that there is no such repository.
      //
      // What used to sit beside it was a token an admin pasted so the whole
      // guild could read the repository. That is gone twice over — a GitHub App
      // needs no pasted credential, and the guild does not read on a shared one
      // at all any more.
      id: "workspace",
      scope: "static",
      label: {
        en: "Repository",
        de: "Repository",
        es: "Repositorio",
        fr: "Dépôt",
      },
      fields: [
        {
          key: "owner",
          type: "string",
          required: true,
          label: {
            en: "Owner or organization",
            de: "Inhaber oder Organisation",
            es: "Propietario u organización",
            fr: "Propriétaire ou organisation",
          },
        },
        {
          // Optional, and blank is the answer to reach for. The organization
          // already chose which repositories to grant when it installed the
          // app; asking an admin to restate that list here is asking them to
          // keep two copies of one decision in step. Filled in only to narrow
          // *further* than the installation does.
          //
          // Comma-separated because a connection's fields draw from one closed
          // set of types and there is no array in it — deliberately, since that
          // is what lets one renderer draw every app's settings page.
          key: "repos",
          type: "string",
          label: {
            en: "Repositories (comma-separated; blank for all)",
            de: "Repositories (kommagetrennt; leer für alle)",
            es: "Repositorios (separados por comas; vacío para todos)",
            fr: "Dépôts (séparés par des virgules ; vide pour tous)",
          },
        },
      ],
    },
  ],

  data_sources: [
    {
      id: "open-issues",
      path: "/data/open-issues",
      visibility: "member",
      // A minute. Long enough that a dashboard of these is not a request storm,
      // short enough that the number means something.
      cache_ttl_seconds: 60,
      params_schema: [
        {
          // Which repository this tile is about, and the whole of how one
          // widget serves several teams. A source cannot be told which
          // initiative is asking — a context token names a guild and an install
          // and nothing finer — so the *dashboard* says, through a fixed value
          // on its binding. A dashboard belongs to exactly one initiative, so
          // binding it there is what pins one team to one repository.
          //
          // Optional: an install covering one repository needs nobody to say so.
          key: "repo",
          type: "string",
          label: {
            en: "Repository",
            de: "Repository",
            es: "Repositorio",
            fr: "Dépôt",
          },
        },
        {
          key: "label",
          type: "string",
          label: { en: "Label", de: "Label", es: "Etiqueta", fr: "Étiquette" },
        },
        {
          key: "milestone",
          type: "string",
          label: {
            en: "Milestone",
            de: "Meilenstein",
            es: "Hito",
            fr: "Jalon",
          },
        },
        {
          key: "assignee",
          type: "string",
          label: {
            en: "Assignee",
            de: "Zuständige Person",
            es: "Persona asignada",
            fr: "Personne assignée",
          },
        },
      ],
      // Per member, like every source here. How many issues are open is one
      // answer for a whole guild and it is still not one every member is
      // entitled to: it is the state of a private repository, and a member who
      // is not on that repository at GitHub has no business reading it here.
      //
      // Naming `account` is what makes that true rather than merely intended —
      // the platform refuses the call before it reaches this app when the
      // caller has not connected one, and the app then runs on their token.
      requires: { all_of: ["workspace", "account"] },
    },
    {
      id: "review-queue",
      path: "/data/review-queue",
      visibility: "member",
      cache_ttl_seconds: 60,
      params_schema: [
        {
          // Which repository this tile is about, and the whole of how one
          // widget serves several teams. A source cannot be told which
          // initiative is asking — a context token names a guild and an install
          // and nothing finer — so the *dashboard* says, through a fixed value
          // on its binding. A dashboard belongs to exactly one initiative, so
          // binding it there is what pins one team to one repository.
          //
          // Optional: an install covering one repository needs nobody to say so.
          key: "repo",
          type: "string",
          label: {
            en: "Repository",
            de: "Repository",
            es: "Repositorio",
            fr: "Dépôt",
          },
        },
      ],
      // Per member, and it could not be anything else: "waiting on me" has no
      // meaning without a me. It was once the only source here that named an
      // account; now it is unremarkable.
      requires: { all_of: ["workspace", "account"] },
    },
    {
      id: "dependabot-alerts",
      path: "/data/dependabot-alerts",
      visibility: "member",
      // Five minutes. An advisory is published, not typed, so this changes on
      // GitHub's schedule rather than a member's.
      cache_ttl_seconds: 300,
      params_schema: [
        {
          // Which repository this tile is about, and the whole of how one
          // widget serves several teams. A source cannot be told which
          // initiative is asking — a context token names a guild and an install
          // and nothing finer — so the *dashboard* says, through a fixed value
          // on its binding. A dashboard belongs to exactly one initiative, so
          // binding it there is what pins one team to one repository.
          //
          // Optional: an install covering one repository needs nobody to say so.
          key: "repo",
          type: "string",
          label: {
            en: "Repository",
            de: "Repository",
            es: "Repositorio",
            fr: "Dépôt",
          },
        },
        {
          // A floor, not a filter: a team that has decided low-severity
          // advisories are noise wants "critical and high", not "high only".
          key: "severity",
          type: "select",
          options: ["critical", "high", "medium", "low"],
          label: {
            en: "Lowest severity to show",
            de: "Niedrigste anzuzeigende Schwere",
            es: "Severidad mínima a mostrar",
            fr: "Gravité minimale à afficher",
          },
        },
      ],
      // Per member, and the consequence is sharpest here: reading Dependabot
      // alerts needs security access on the repository, so this answers for the
      // people who hold it and refuses for everyone else. That is the point
      // rather than a shortcoming — how exposed a repository is is not a fact
      // to hand to whoever opens a dashboard.
      requires: { all_of: ["workspace", "account"] },
    },
    {
      id: "issue-throughput",
      path: "/data/issue-throughput",
      visibility: "member",
      // Five minutes: a fortnight of daily counts does not change by the second,
      // and this is the most expensive call this app makes.
      cache_ttl_seconds: 300,
      params_schema: [
        {
          // Which repository this tile is about, and the whole of how one
          // widget serves several teams. A source cannot be told which
          // initiative is asking — a context token names a guild and an install
          // and nothing finer — so the *dashboard* says, through a fixed value
          // on its binding. A dashboard belongs to exactly one initiative, so
          // binding it there is what pins one team to one repository.
          //
          // Optional: an install covering one repository needs nobody to say so.
          key: "repo",
          type: "string",
          label: {
            en: "Repository",
            de: "Repository",
            es: "Repositorio",
            fr: "Dépôt",
          },
        },
        {
          key: "label",
          type: "string",
          label: { en: "Label", de: "Label", es: "Etiqueta", fr: "Étiquette" },
        },
      ],
      // Per member, and this is the one where the cost is felt: it is the
      // heaviest call this app makes, and it now runs once per member per five
      // minutes rather than once per guild. A longer TTL is the lever if that
      // ever bites.
      requires: { all_of: ["workspace", "account"] },
    },
  ],

  // What this app publishes when something happens at GitHub, and the whole of
  // what a subscriber may ask for. Built from the translator so the list cannot
  // name a type nothing produces — see `github/events.ts` for the table all
  // three readings come from.
  //
  // Note what is not describable here: which initiative an event belongs to. An
  // app has none to name, so an event is guild-wide and a consumer narrows
  // itself by a payload field instead. That is what `repository` is for.
  events: [...EVENT_TYPES],

  // Three shapes a widget takes — one number, a list, and a series — and four
  // widgets, because the fourth is not here to demonstrate a shape. It reuses
  // the list deliberately: it exists because `vulnerability_alerts` is a
  // permission every organization installing this app has to grant, and a
  // permission with nothing reading it is one they should refuse.
  widgets: [
    {
      id: "open-issues",
      meta: {
        name: {
          en: "Open issues",
          de: "Offene Issues",
          es: "Incidencias abiertas",
          fr: "Tickets ouverts",
        },
        description: {
          en: "How many issues are open, and how that is trending.",
          de: "Wie viele Issues offen sind und wie sich das entwickelt.",
          es: "Cuántas incidencias están abiertas y su tendencia.",
          fr: "Combien de tickets sont ouverts, et la tendance.",
        },
      },
      sources: ["open-issues"],
      module_source: METRIC_WIDGET(),
      // Rows for a preview that renders with no network call at all, so the
      // marketplace can show the widget before anything is connected.
      sample_data: { "open-issues": { total: 42, delta: -3 } },
      // The same terms as the source it draws, and that is the rule rather
      // than a coincidence: a widget naming more than its sources do is refused
      // before either is called. What changed is which way the mismatch used to
      // go — this tile named an account its source did not need, and refused
      // for members who would have seen the right number without one. Now the
      // source needs it too, and the two agree.
      requires: { all_of: ["workspace", "account"] },
    },
    {
      id: "review-queue",
      meta: {
        name: {
          en: "Waiting on you",
          de: "Wartet auf dich",
          es: "Esperando por ti",
          fr: "En attente de vous",
        },
        description: {
          en: "Pull requests that asked for your review.",
          de: "Pull Requests, die deine Review angefragt haben.",
          es: "Pull requests que pidieron tu revisión.",
          fr: "Pull requests qui ont demandé votre revue.",
        },
      },
      sources: ["review-queue"],
      module_source: LIST_WIDGET(),
      sample_data: {
        "review-queue": {
          total: 2,
          items: [
            { number: 812, title: "Cache the issue counts", url: "#" },
            { number: 809, title: "Drop the unused index", url: "#" },
          ],
        },
      },
      requires: { all_of: ["workspace", "account"] },
    },
    {
      id: "dependabot-alerts",
      meta: {
        name: {
          en: "Dependabot alerts",
          de: "Dependabot-Warnungen",
          es: "Alertas de Dependabot",
          fr: "Alertes Dependabot",
        },
        description: {
          en: "Open dependency alerts, worst first.",
          de: "Offene Abhängigkeitswarnungen, die schlimmsten zuerst.",
          es: "Alertas de dependencias abiertas, las peores primero.",
          fr: "Alertes de dépendances ouvertes, les pires d'abord.",
        },
      },
      sources: ["dependabot-alerts"],
      module_source: ALERTS_WIDGET(),
      sample_data: {
        "dependabot-alerts": {
          total: 7,
          severities: [
            { severity: "critical", count: 1 },
            { severity: "high", count: 2 },
            { severity: "medium", count: 4 },
          ],
          url: "#",
        },
      },
      requires: { all_of: ["workspace", "account"] },
    },
    {
      id: "issue-throughput",
      meta: {
        name: {
          en: "Issues opened and closed",
          de: "Geöffnete und geschlossene Issues",
          es: "Incidencias abiertas y cerradas",
          fr: "Tickets ouverts et fermés",
        },
        description: {
          en: "A fortnight of opens against closes.",
          de: "Zwei Wochen Öffnungen gegen Schließungen.",
          es: "Dos semanas de aperturas frente a cierres.",
          fr: "Deux semaines d'ouvertures contre fermetures.",
        },
      },
      sources: ["issue-throughput"],
      module_source: SERIES_WIDGET(),
      sample_data: {
        "issue-throughput": {
          points: [
            { day: "Mon", opened: 4, closed: 6 },
            { day: "Tue", opened: 2, closed: 3 },
            { day: "Wed", opened: 7, closed: 5 },
            { day: "Thu", opened: 1, closed: 4 },
            { day: "Fri", opened: 3, closed: 3 },
          ],
        },
      },
      requires: { all_of: ["workspace", "account"] },
    },
  ],
};

/**
 * The widgets' browser-side modules, as source.
 *
 * They run in the platform's sandbox with no network, no DOM and no globals —
 * each is handed the data its `sources` declared and returns a scene to draw.
 * Kept as strings here because that is what a manifest carries; a larger app
 * would build these from their own files with the bundler of its choice.
 */
function METRIC_WIDGET(): string {
  return `
export default function render({ data }) {
  const rows = data["open-issues"] ?? {};
  const total = rows.total ?? 0;
  const delta = rows.delta ?? 0;
  return {
    kind: "metric",
    value: String(total),
    label: "Open issues",
    delta: delta === 0 ? null : {
      value: (delta > 0 ? "+" : "") + delta,
      tone: delta > 0 ? "negative" : "positive",
    },
  };
}
`.trim();
}

function LIST_WIDGET(): string {
  return `
export default function render({ data }) {
  const rows = data["review-queue"] ?? {};
  const items = rows.items ?? [];
  if (!items.length) {
    return { kind: "empty", label: "Nothing is waiting on you" };
  }
  return {
    kind: "list",
    items: items.map((item) => ({
      label: "#" + item.number + " " + item.title,
      href: item.url,
    })),
  };
}
`.trim();
}

function ALERTS_WIDGET(): string {
  return `
export default function render({ data }) {
  const rows = data["dependabot-alerts"] ?? {};
  const severities = rows.severities ?? [];
  if (!severities.length) {
    return { kind: "empty", label: "No open Dependabot alerts" };
  }
  return {
    kind: "list",
    items: severities.map((entry) => ({
      label: entry.severity.charAt(0).toUpperCase() + entry.severity.slice(1)
        + " \u00b7 " + entry.count,
      href: rows.url,
    })),
  };
}
`.trim();
}

function SERIES_WIDGET(): string {
  return `
export default function render({ data }) {
  const rows = data["issue-throughput"] ?? {};
  const points = rows.points ?? [];
  return {
    kind: "series",
    x: points.map((point) => point.day),
    series: [
      { label: "Opened", values: points.map((point) => point.opened) },
      { label: "Closed", values: points.map((point) => point.closed) },
    ],
  };
}
`.trim();
}
