/**
 * What this app tells a deployment it is.
 *
 * Authored in TypeScript and built to `manifest.json`, so the compiler catches
 * a malformed manifest before `initiative-app validate` does and before a
 * deployment does. `npm run manifest` writes it.
 *
 * Read this file first if you are starting an app. It is the whole surface: a
 * connection each vendor account authorizes, sources the platform fetches,
 * widgets drawn from those sources, an embedded page, and the events this app
 * emits. Nothing here is an address — every route is a path, and the operator's
 * registration says where the app lives.
 */

import type { Manifest } from "initiative-app-kit";

/** Namespaces everything this app publishes: widgets, events, its audience. */
export const PUBLIC_ID = "morelitea.github";

export const manifest: Manifest = {
  app_kind: "service",
  service: { public_id: PUBLIC_ID, protocol: 1 },

  // Declared and cross-checked against the blocks below, in both directions.
  // A feature with no block would advertise something this app cannot do.
  features: ["data", "widgets", "embeds", "events"],

  default_name: "GitHub",

  connections: [
    {
      // GitHub authorizes a *person*, so each member connects their own
      // account and the app holds one credential per person rather than one
      // for the whole guild. Installing never waits for anybody to do this.
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
        // Read-only, and said out loud so an admin can see it before anyone
        // authorizes. This app holds no write credential anywhere.
        scopes: ["read:user", "repo:status", "public_repo"],
      },
    },
    {
      // The guild-wide half: which repositories this guild cares about. Not a
      // credential — a setting — but it rides the same form machinery.
      id: "workspace",
      scope: "static",
      label: {
        en: "Repositories",
        de: "Repositories",
        es: "Repositorios",
        fr: "Dépôts",
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
      // Both: the guild says which repository, the member says who is asking.
      requires: { all_of: ["workspace", "account"] },
    },
    {
      id: "review-queue",
      path: "/data/review-queue",
      visibility: "member",
      cache_ttl_seconds: 60,
      requires: { all_of: ["workspace", "account"] },
    },
  ],

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
      module_source: OPEN_ISSUES_WIDGET(),
      // Rows for a preview that renders with no network call at all, so the
      // marketplace can show the widget before anything is connected.
      sample_data: {
        "open-issues": { total: 42, delta: -3 },
      },
      requires: { all_of: ["workspace", "account"] },
    },
  ],

  embeds: [
    {
      id: "board",
      path: "/embed/board",
      name: { en: "GitHub", de: "GitHub", es: "GitHub", fr: "GitHub" },
      // Guild-wide and inside each initiative: the same page, told which
      // initiative it was opened in.
      scopes: ["guild", "initiative"],
      visibility: "member",
      // A frame is granted nothing it does not name, and this page needs one
      // thing: copying an issue link.
      capabilities: ["clipboard-write"],
      requires: { all_of: ["workspace"] },
    },
  ],

  // Namespaced under this app's own service id, and checked again at ingress
  // against the registration that emits them.
  events: [
    `app.${PUBLIC_ID}.issue-opened`,
    `app.${PUBLIC_ID}.issue-closed`,
    `app.${PUBLIC_ID}.review-requested`,
  ],
};

/**
 * The widget's browser-side module, as source.
 *
 * It runs in the platform's sandbox with no network, no DOM and no globals —
 * it is handed the data its `sources` declared and returns a scene to draw.
 * Kept as a string here because that is what a manifest carries; a larger app
 * would build this from its own file with the bundler of its choice.
 */
function OPEN_ISSUES_WIDGET(): string {
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
