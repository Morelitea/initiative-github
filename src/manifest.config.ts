import type {
  Endpoint,
  EndpointParam,
  EndpointReturn,
  LocalizedText,
  Manifest,
} from "initiative-app-kit";

import { READ_IDS, WRITE_IDS } from "./vocabulary.js";
import { EMIT_ENDPOINTS } from "./endpoints/emissions.js";
import { PERMISSIONS } from "./github/app.js";
import { PUBLIC_ID } from "./vocabulary.js";
import { ENDPOINTS } from "./endpoints/index.js";
import { WIDGETS } from "./widgets/index.js";
import { CONNECT_PATH, INSTALL_PATH } from "./vocabulary.js";

export { READ_IDS, WRITE_IDS } from "./vocabulary.js";

export const DASHBOARD_UID = "J9H7S9T7GP7FAG";

export { PUBLIC_ID };

const ACCESS_HINT_SCOPES = Object.entries(PERMISSIONS).map(
  ([permission, level]) => `${permission}:${level}`
);

export const manifest: Manifest = {
  app_kind: "service",
  service: { public_id: PUBLIC_ID, protocol: 1 },

  features: ["dashboards", "endpoints", "widgets"],

  default_name: "GitHub",

  connections: [
    {
      id: "account",
      scope: "interactive",
      label: {
        en: "Your GitHub account",
        de: "Dein GitHub-Konto",
        es: "Tu cuenta de GitHub",
        fr: "Votre compte GitHub",
      },

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

        scopes: ACCESS_HINT_SCOPES,
      },
    },
    /**
     * The half GitHub owns, written down rather than typed.
     *
     * This was two text boxes — an owner and a comma-separated list of
     * repositories — and both of them were an admin restating, from memory,
     * something that already existed at GitHub. Nothing checked that the name
     * matched an account anybody had installed the app on, or that the
     * repositories were among the ones that install was granted. A typo was an
     * install that looked configured and answered nothing.
     *
     * A GitHub App is not installed by naming it. Somebody who owns the
     * account opens GitHub's own install page, chooses the account and picks
     * which repositories the app may see, and what exists afterwards is an
     * *installation* with an id. `connect_path` is what sends a guild admin
     * there; every field here is `managed`, because all three are things
     * GitHub said and none is a thing to be typed.
     */
    {
      id: "workspace",
      scope: "static",
      connect_path: INSTALL_PATH,
      label: {
        en: "GitHub organization",
        de: "GitHub-Organisation",
        es: "Organización de GitHub",
        fr: "Organisation GitHub",
      },
      fields: [
        {
          key: "owner",
          type: "string",
          required: true,
          managed: true,
          label: {
            en: "Owner or organization",
            de: "Inhaber oder Organisation",
            es: "Propietario u organización",
            fr: "Propriétaire ou organisation",
          },
        },
        {
          key: "installation_id",
          type: "int",
          required: true,
          managed: true,
          label: {
            en: "Installation",
            de: "Installation",
            es: "Instalación",
            fr: "Installation",
          },
        },
        {
          key: "repos",
          type: "string",
          required: true,
          managed: true,
          label: {
            en: "Repositories",
            de: "Repositories",
            es: "Repositorios",
            fr: "Dépôts",
          },
        },
      ],
      // No `access_hint`. It exists so somebody about to mint a credential can
      // mint the smallest one that works, and nobody mints anything here: the
      // permissions are the ones GitHub's own install page lists, granted by
      // whoever owns the account, on a page that says what they are.
    },
  ],

  endpoints: [...ENDPOINTS],

  widgets: [...WIDGETS],

  dashboards: [
    {
      uid: DASHBOARD_UID,
      public_id: "morelitea.github-overview",
      name: "GitHub overview",
      description: "The repository at a glance: open issues, reviews, throughput.",
      layout: { columns: 12 },
      widgets: [
        {
          id: "open",
          type: "open-issues",
          title: "Open issues",
          grid: { x: 0, y: 0, w: 3, h: 3 },

          binding: { endpoint_id: READ_IDS.findIssues, params: { state: "open", limit: 1 } },
        },
        {
          id: "reviews",
          type: "review-queue",
          title: "Waiting on your review",
          grid: { x: 3, y: 0, w: 6, h: 3 },
          binding: {
            endpoint_id: READ_IDS.findPullRequests,
            params: { review_requested: "@me", state: "open", limit: 10 },
          },
        },
        {
          id: "alerts",
          type: "dependabot-alerts",
          title: "Dependabot alerts",
          grid: { x: 9, y: 0, w: 3, h: 3 },
          binding: { endpoint_id: READ_IDS.listAlerts },
        },
        {
          id: "throughput",
          type: "issue-throughput",
          title: "Opened and closed",
          grid: { x: 0, y: 3, w: 12, h: 4 },
          binding: {
            endpoint_id: READ_IDS.findIssues,
            params: { state: "all", since_days: 14, limit: 100, sort: "updated" },
          },
        },
      ],
    },
  ],
};
