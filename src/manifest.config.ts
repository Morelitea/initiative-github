/**
 * What this app tells a deployment it is.
 *
 * Authored in TypeScript and built to `manifest.json`, so the compiler catches
 * a malformed manifest before `initiative-app validate` does and before a
 * deployment does. `npm run manifest` writes it.
 *
 * Read this file first if you are starting an app. It is the whole surface: a
 * connection each vendor account authorizes, sources the platform fetches,
 * widgets drawn from those sources, the events this app emits, and the
 * automation nodes it contributes. Nothing here is an address — every route is
 * a path, and the operator's registration says where the app lives.
 *
 * **No embedded page.** This app deliberately mounts no surface of its own:
 * everything it offers lands inside Initiative's own — dashboard widgets and
 * automation nodes — rather than in an iframe holding a second UI. An embed is
 * for an app whose product *is* a page; an integration is better as parts.
 */

import type { Manifest } from "initiative-app-kit";

/** Namespaces everything this app publishes: widgets, events, automation nodes. */
export const PUBLIC_ID = "morelitea.github";

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
  features: ["data", "widgets", "events", "automations"],

  default_name: "GitHub",

  connections: [
    {
      // The member's own GitHub account, for the two things that are about
      // them specifically: which pull requests are waiting on their review,
      // and opening an issue as themselves. Everything a whole guild sees the
      // same answer to runs on `shared_account` below instead, so connecting
      // this is optional and nobody is asked for it to read a number.
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
      // No fields: the vendor flow produces the credential, and this app writes
      // it back itself rather than anyone typing it in.
      fields: [],
      connect_path: "/connect/github",
      access_hint: {
        api: "GitHub",
        // Said out loud so an admin sees it before anyone authorizes. `repo` is
        // here because the automation action below opens issues — an app that
        // only read would ask for less, and should.
        scopes: ["read:user", "repo"],
      },
    },
    {
      // The guild-wide half: which repository this guild cares about. Not a
      // credential — a setting — but it rides the same form machinery.
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
          key: "repo",
          type: "string",
          required: true,
          label: {
            en: "Repository",
            de: "Repository",
            es: "Repositorio",
            fr: "Dépôt",
          },
        },
      ],
    },
    {
      // The guild's own read access, approved once by an admin and used for
      // everyone. What it buys is that the repository's numbers — how many
      // issues are open, how the last fortnight went — are the same answer for
      // every member, so nobody should have to hand over a personal account to
      // see one. The platform caches a source that names no per-member
      // connection once per guild, so this is also one upstream call rather
      // than one per person.
      id: "shared_account",
      scope: "static",
      label: {
        en: "Shared read access",
        de: "Gemeinsamer Lesezugriff",
        es: "Acceso de lectura compartido",
        fr: "Accès en lecture partagé",
      },
      fields: [
        {
          key: "token",
          type: "secret",
          required: true,
          label: {
            en: "GitHub token with read access to the repository",
            de: "GitHub-Token mit Lesezugriff auf das Repository",
            es: "Token de GitHub con acceso de lectura al repositorio",
            fr: "Jeton GitHub avec accès en lecture au dépôt",
          },
        },
      ],
      access_hint: {
        api: "GitHub",
        // A fine-grained token restricted to this repository, with `Issues:
        // read` and nothing else, is enough for everything this connection is
        // used for. Said here so an admin sees it before minting one.
        scopes: ["issues:read"],
      },
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
          key: "label",
          type: "string",
          label: { en: "Label", de: "Label", es: "Etiqueta", fr: "Étiquette" },
        },
      ],
      // Guild-scoped, and this is the choice worth copying. How many issues
      // are open is one answer for the whole guild, so it runs on the guild's
      // own access and nobody has to connect a personal account to see it.
      // Naming no per-member connection is also what lets the platform cache
      // it once per guild instead of once per member.
      requires: { all_of: ["workspace", "shared_account"] },
    },
    {
      id: "review-queue",
      path: "/data/review-queue",
      visibility: "member",
      cache_ttl_seconds: 60,
      // Per member, and it could not be anything else: "waiting on me" has no
      // meaning without a me. This is the one source that needs the member's
      // own account, and the only reason this app asks for one.
      requires: { all_of: ["workspace", "account"] },
    },
    {
      id: "issue-throughput",
      path: "/data/issue-throughput",
      visibility: "member",
      // Five minutes: a fortnight of daily counts does not change by the second,
      // and this is the most expensive call this app makes.
      cache_ttl_seconds: 300,
      // Guild-scoped for the same reason as the issue count, and it matters
      // more here: this is the heaviest call, and it now runs once per guild
      // per five minutes rather than once per member.
      requires: { all_of: ["workspace", "shared_account"] },
    },
  ],

  // Three, because they show the three shapes a widget takes: one number, a
  // list, and a series. A fourth of the same shape would teach nothing.
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

  // Namespaced under this app's own service id, and checked again at ingress
  // against the registration that emits them.
  events: [
    `app.${PUBLIC_ID}.issue-opened`,
    `app.${PUBLIC_ID}.issue-closed`,
    `app.${PUBLIC_ID}.review-requested`,
  ],

  // What this app contributes to the automation canvas. Opaque to Initiative,
  // which stores it verbatim; the automation service parses it against its own
  // contract. See AUTOMATION.md for the shape and what it maps onto.
  automation: {
    contract: 1,
    domain: {
      id: "github",
      label: { en: "GitHub", de: "GitHub", es: "GitHub", fr: "GitHub" },
      icon: "Braces",
    },
    nodes: [
      {
        key: "issue-opened",
        category: "trigger",
        icon: "Zap",
        label: {
          en: "A GitHub issue is opened",
          de: "Ein GitHub-Issue wird geöffnet",
          es: "Se abre una incidencia de GitHub",
          fr: "Un ticket GitHub est ouvert",
        },
        description: {
          en: "Starts when someone opens an issue in the connected repository.",
          de: "Startet, wenn jemand ein Issue im verbundenen Repository öffnet.",
          es: "Empieza cuando alguien abre una incidencia en el repositorio conectado.",
          fr: "Démarre quand quelqu'un ouvre un ticket dans le dépôt connecté.",
        },
        // Which emitted event fires it. Must be one this manifest declares —
        // a trigger naming an event the app never emits could never fire.
        event: `app.${PUBLIC_ID}.issue-opened`,
        // The same closed field vocabulary a connection uses, so one renderer
        // draws a node's form and a connection's alike.
        fields: [
          {
            key: "label",
            type: "string",
            label: {
              en: "Only issues with this label",
              de: "Nur Issues mit diesem Label",
              es: "Solo incidencias con esta etiqueta",
              fr: "Uniquement les tickets avec ce label",
            },
          },
        ],
        // What the event carries into the run, for later nodes to read.
        outputs: ["issue_number", "issue_title", "issue_url", "issue_labels"],
      },
      {
        key: "review-requested",
        category: "trigger",
        icon: "Zap",
        label: {
          en: "A review is requested",
          de: "Eine Review wird angefragt",
          es: "Se solicita una revisión",
          fr: "Une revue est demandée",
        },
        description: {
          en: "Starts when a pull request asks someone for review.",
          de: "Startet, wenn ein Pull Request jemanden um Review bittet.",
          es: "Empieza cuando un pull request pide revisión a alguien.",
          fr: "Démarre quand une pull request demande une revue.",
        },
        event: `app.${PUBLIC_ID}.review-requested`,
        fields: [],
        outputs: ["pull_number", "pull_title", "pull_url"],
      },
      {
        key: "create-issue",
        category: "action",
        icon: "FolderPlus",
        label: {
          en: "Open a GitHub issue",
          de: "Ein GitHub-Issue öffnen",
          es: "Abrir una incidencia de GitHub",
          fr: "Ouvrir un ticket GitHub",
        },
        description: {
          en: "Opens an issue in the connected repository, as the member who owns the automation.",
          de: "Öffnet ein Issue im verbundenen Repository, als das Mitglied, dem die Automatisierung gehört.",
          es: "Abre una incidencia en el repositorio conectado, como el miembro dueño de la automatización.",
          fr: "Ouvre un ticket dans le dépôt connecté, au nom du membre propriétaire de l'automatisation.",
        },
        // The operation this node calls, served at `operations[].path`.
        operation: "create-issue",
        fields: [
          {
            key: "title",
            type: "string",
            required: true,
            label: { en: "Title", de: "Titel", es: "Título", fr: "Titre" },
          },
          {
            key: "body",
            type: "string",
            label: { en: "Body", de: "Text", es: "Cuerpo", fr: "Corps" },
          },
          {
            key: "label",
            type: "string",
            label: { en: "Label", de: "Label", es: "Etiqueta", fr: "Étiquette" },
          },
        ],
        outputs: ["issue_number", "issue_url"],
      },
    ],
    // Where each action is served. Called with a context token scoped to
    // `action`, naming this operation and nothing else.
    operations: [
      {
        id: "create-issue",
        path: "/actions/create-issue",
        // A write at the vendor, so it runs as the member who authorized it —
        // never from an app-wide credential.
        requires: { all_of: ["workspace", "account"] },
      },
    ],
  },
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
