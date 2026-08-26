/**
 * What this app tells a deployment it is.
 *
 * Authored in TypeScript and built to `manifest.json`, so the compiler catches
 * a malformed manifest before `initiative-app validate` does and before a
 * deployment does. `npm run manifest` writes it.
 *
 * The whole surface is here: the connections a person fills in or authorizes,
 * the endpoints anything may call, and the widgets drawn from them. Nothing
 * here is an address — a route is a path and an endpoint is an id, and the
 * operator's registration says where the app lives.
 *
 * **No embedded page.** This app deliberately mounts no surface of its own:
 * everything it offers lands inside Initiative's own — dashboard widgets, and
 * the companion dashboard that arranges them — rather than in an iframe holding
 * a second UI. An embed is for an app whose product *is* a page; an integration
 * is better as parts.
 */

import type { Endpoint, EndpointParam, Manifest } from "initiative-app-kit";

import { EMIT_ENDPOINTS } from "./github/emissions.js";
import { PERMISSIONS } from "./github/registration.js";
import { PUBLIC_ID, declare } from "./public-id.js";
import { CONNECT_PATH } from "./routes.js";

/**
 * The reads this app answers, named so a widget and an automation can bind the
 * same id.
 *
 * Namespaced like everything else here: one id space across reads, writes and
 * emissions means a caller resolves an id without being told which kind it is.
 */
export const READ_IDS = {
  openIssues: declare("open-issues"),
  reviewQueue: declare("review-queue"),
  dependabotAlerts: declare("dependabot-alerts"),
  issueThroughput: declare("issue-throughput"),
} as const;

/** Every write id the caller may name, in one place. */
export const WRITE_IDS = {
  openIssue: declare("open-issue"),
  comment: declare("comment"),
  closeIssue: declare("close-issue"),
  reopenIssue: declare("reopen-issue"),
  label: declare("label"),
  requestReview: declare("request-review"),
  moveProjectItem: declare("move-project-item"),
} as const;

/**
 * One parameter, in the four languages this app's settings are written in.
 *
 * Typed and labelled rather than named, because these are what a person filling
 * in an automation step is shown. A bare list of keys is enough for a machine
 * and leaves whoever is wiring it up guessing at `option_id`.
 */
function param(
  key: string,
  type: EndpointParam["type"],
  en: string,
  de: string,
  es: string,
  fr: string
): EndpointParam {
  return { key, type, label: { en, de, es, fr } };
}

/** Which repository, on every write that acts inside one. */
const REPO = param("repo", "string", "Repository", "Repository", "Repositorio", "Dépôt");

/** Which issue or pull request. They share a number space at GitHub. */
const NUMBER = param("number", "int", "Number", "Nummer", "Número", "Numéro");

/**
 * What this app will do at GitHub, and whose credential each runs on.
 *
 * **Every one of them runs as the member**, and nothing here runs as the app.
 * That is the same rule the read path follows and it is the same reason: a
 * write the app performed on its own credential is a write inside whatever the
 * organization granted, which is not the same set as what the person whose
 * automation fired it may touch. An automation that could reach further than
 * its owner is an escalation with a scheduler in front of it.
 *
 * So `actors` is uniform now, and it stays a list rather than collapsing to a
 * single value because the shape is the kit's and other apps have other
 * answers — an app whose vendor has no per-person identity at all can only ever
 * act as itself.
 *
 * The cost is that an endpoint refuses outright when the member behind a
 * delegated call cannot be resolved. That is deliberate. Substituting the app
 * would look like success and would be a different act performed by a different
 * party, which is the sort of difference nobody notices until they are reading
 * an audit log wondering who closed something.
 */
export const WRITE_ENDPOINTS: readonly Endpoint[] = [
  {
    id: WRITE_IDS.openIssue,
    direction: "write",
    actors: ["member"],
    requires: { all_of: ["workspace", "account"] },
    params: [
      REPO,
      param("title", "string", "Title", "Titel", "Título", "Titre"),
      param("body", "string", "Body", "Text", "Cuerpo", "Corps"),
      param("labels", "string", "Labels", "Labels", "Etiquetas", "Étiquettes"),
      param("assignees", "string", "Assignees", "Zuständige", "Asignados", "Assignés"),
    ],
  },
  {
    id: WRITE_IDS.comment,
    direction: "write",
    actors: ["member"],
    requires: { all_of: ["workspace", "account"] },
    // Issues and pull requests share a number space and a comments endpoint, so
    // this is one write rather than two that differ by a URL segment.
    params: [REPO, NUMBER, param("body", "string", "Body", "Text", "Cuerpo", "Corps")],
  },
  {
    id: WRITE_IDS.closeIssue,
    direction: "write",
    actors: ["member"],
    requires: { all_of: ["workspace", "account"] },
    params: [
      REPO,
      NUMBER,
      {
        key: "reason",
        type: "select",
        options: ["completed", "not_planned"],
        label: { en: "Reason", de: "Grund", es: "Motivo", fr: "Raison" },
      },
    ],
  },
  {
    id: WRITE_IDS.reopenIssue,
    direction: "write",
    actors: ["member"],
    requires: { all_of: ["workspace", "account"] },
    params: [REPO, NUMBER],
  },
  {
    id: WRITE_IDS.label,
    direction: "write",
    actors: ["member"],
    requires: { all_of: ["workspace", "account"] },
    params: [
      REPO,
      NUMBER,
      param("add", "string", "Labels to add", "Hinzuzufügende Labels", "Etiquetas a añadir", "Étiquettes à ajouter"),
      param("remove", "string", "Labels to remove", "Zu entfernende Labels", "Etiquetas a quitar", "Étiquettes à retirer"),
    ],
  },
  {
    id: WRITE_IDS.requestReview,
    direction: "write",
    actors: ["member"],
    requires: { all_of: ["workspace", "account"] },
    params: [
      REPO,
      NUMBER,
      param("reviewers", "string", "Reviewers", "Reviewer", "Revisores", "Relecteurs"),
      param("team_reviewers", "string", "Team reviewers", "Team-Reviewer", "Equipos revisores", "Équipes relectrices"),
    ],
  },
  {
    // Projects v2 is organization-scoped, which is the argument for running
    // this one as the member rather than as the app: a board a member cannot
    // see is one they should not be moving cards on, and their own token is
    // what says which boards those are.
    id: WRITE_IDS.moveProjectItem,
    direction: "write",
    actors: ["member"],
    // No `workspace`: a Projects v2 board belongs to the organization rather
    // than to a repository, so the guild's repository setting says nothing
    // about which board this is. The ids name it outright.
    requires: { all_of: ["account"] },
    params: [
      param("project_id", "string", "Project", "Projekt", "Proyecto", "Projet"),
      param("item_id", "string", "Card", "Karte", "Tarjeta", "Carte"),
      param("field_id", "string", "Field", "Feld", "Campo", "Champ"),
      param("option_id", "string", "Value", "Wert", "Valor", "Valeur"),
    ],
  },
];

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
 * and the id that ties a verified registration to its listing. Without one the
 * app registers, verifies, and names no listing, which reads as healthy from
 * every angle except the marketplace. It is set in `listing.config.ts`, beside
 * the listings that publish under it.
 */

export const manifest: Manifest = {
  app_kind: "service",
  service: { public_id: PUBLIC_ID, protocol: 1 },

  // Declared and cross-checked against the blocks below, in both directions.
  // A feature with no block would advertise something this app cannot do.
  //
  // `endpoints` is the whole callable surface — what this app answers, what it
  // does, and what it announces — and it belongs here rather than only on the
  // wire because this app holds GitHub's webhook connection and is therefore
  // the authority on what any of it means. A consumer reads this list to know
  // what it may ask for.
  features: ["endpoints", "widgets"],

  default_name: "GitHub",

  connections: [
    {
      // The member's own GitHub account, and **everything here runs on it** —
      // every widget, every read, and every write.
      //
      // That is the whole permission model. An endpoint cannot ask Initiative
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

  endpoints: [
    {
      id: READ_IDS.openIssues,
      direction: "read",
      // Every read runs on the caller's own GitHub credential, so there is one
      // actor and no fallback. An installation-wide answer would be the state
      // of a private repository handed to whoever opened a dashboard.
      actors: ["member"],
      visibility: "member",
      // A minute. Long enough that a dashboard of these is not a request storm,
      // short enough that the number means something.
      cache_ttl_seconds: 60,
      params: [
        {
          // Which repository this tile is about, and the whole of how one
          // endpoint serves several teams. A read cannot be told which
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
      // Per member, like every read here. How many issues are open is one
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
      id: READ_IDS.reviewQueue,
      direction: "read",
      actors: ["member"],
      visibility: "member",
      cache_ttl_seconds: 60,
      params: [
        {
          // Which repository this tile is about, and the whole of how one
          // endpoint serves several teams. A read cannot be told which
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
      // meaning without a me.
      requires: { all_of: ["workspace", "account"] },
    },
    {
      id: READ_IDS.dependabotAlerts,
      direction: "read",
      actors: ["member"],
      visibility: "member",
      // Five minutes. An advisory is published, not typed, so this changes on
      // GitHub's schedule rather than a member's.
      cache_ttl_seconds: 300,
      params: [
        {
          // Which repository this tile is about, and the whole of how one
          // endpoint serves several teams. A read cannot be told which
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
      id: READ_IDS.issueThroughput,
      direction: "read",
      actors: ["member"],
      visibility: "member",
      // Five minutes: a fortnight of daily counts does not change by the second,
      // and this is the most expensive call this app makes.
      cache_ttl_seconds: 300,
      params: [
        {
          // Which repository this tile is about, and the whole of how one
          // endpoint serves several teams. A read cannot be told which
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
      // heaviest call this app makes, and it runs once per member per five
      // minutes. A longer TTL is the lever if that ever bites.
      requires: { all_of: ["workspace", "account"] },
    },

    // What this app will do at GitHub on somebody's behalf, and what it will
    // announce when GitHub tells it something happened. Both come from the
    // modules that implement them, so a declaration cannot name a write with no
    // handler or an emission nothing translates.
    ...WRITE_ENDPOINTS,
    ...EMIT_ENDPOINTS,
  ],

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
      endpoints: [READ_IDS.openIssues],
      module_source: METRIC_WIDGET(),
      // Rows for a preview that renders with no network call at all, so the
      // marketplace can show the widget before anything is connected.
      sample_data: { [READ_IDS.openIssues]: { total: 42, delta: -3 } },
      // The same terms as the endpoint it draws, and that is the rule rather
      // than a coincidence: a widget naming more than its endpoints do is
      // refused before either is called.
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
      endpoints: [READ_IDS.reviewQueue],
      module_source: LIST_WIDGET(),
      sample_data: {
        [READ_IDS.reviewQueue]: {
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
      endpoints: [READ_IDS.dependabotAlerts],
      module_source: ALERTS_WIDGET(),
      sample_data: {
        [READ_IDS.dependabotAlerts]: {
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
      endpoints: [READ_IDS.issueThroughput],
      module_source: SERIES_WIDGET(),
      sample_data: {
        [READ_IDS.issueThroughput]: {
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
 * each is handed the data its `endpoints` returned and returns a scene to draw.
 * Kept as strings here because that is what a manifest carries; a larger app
 * would build these from their own files with the bundler of its choice.
 */
function METRIC_WIDGET(): string {
  return `
export default function render({ data }) {
  const rows = data[${JSON.stringify(READ_IDS.openIssues)}] ?? {};
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
  const rows = data[${JSON.stringify(READ_IDS.reviewQueue)}] ?? {};
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
  const rows = data[${JSON.stringify(READ_IDS.dependabotAlerts)}] ?? {};
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
  const rows = data[${JSON.stringify(READ_IDS.issueThroughput)}] ?? {};
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
