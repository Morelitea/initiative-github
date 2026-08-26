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
 * ## What an endpoint says about itself
 *
 * Every endpoint here carries a `label`, a `description`, a `group` and its
 * `returns`, because an endpoint is also a step on somebody's automation canvas
 * and those four are what a canvas has to draw one with. Without them the best
 * a consumer can do is scrape a title off the id, offer nothing to the step
 * below, and put all fourteen in one flat list.
 *
 * Two fields of that vocabulary are deliberately absent everywhere:
 *
 *   * **`needs_subject`**, which says what a run must already be *about* for an
 *     endpoint to mean anything. Nothing here needs one: every endpoint names
 *     what it acts on — a repository, an issue number, a board — which is
 *     exactly what makes them the reusable ones, usable from a nightly schedule
 *     that is about nothing at all. Saying nothing is read as needing nothing,
 *     and claiming a need this app does not have would warn somebody off an
 *     arrangement that would have worked.
 *   * **`picker`**, for the reason given on {@link param}.
 *
 * **No embedded page.** This app deliberately mounts no surface of its own:
 * everything it offers lands inside Initiative's own — dashboard widgets, and
 * the companion dashboard that arranges them — rather than in an iframe holding
 * a second UI. An embed is for an app whose product *is* a page; an integration
 * is better as parts.
 */

import type {
  Endpoint,
  EndpointParam,
  EndpointReturn,
  LocalizedText,
  Manifest,
} from "initiative-app-kit";

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

/** One label, in the four languages this app's settings are written in. */
function text(en: string, de: string, es: string, fr: string): LocalizedText {
  return { en, de, es, fr };
}

/**
 * One parameter, in the four languages this app's settings are written in.
 *
 * Typed and labelled rather than named, because these are what a person filling
 * in an automation step is shown. A bare list of keys is enough for a machine
 * and leaves whoever is wiring it up guessing at `option_id`.
 *
 * **No `picker` on any of them**, which is a decision rather than an omission.
 * A picker names one of the *consumer's* richer controls — the vocabulary is
 * open and belongs to whoever draws it — and it is a hint rather than a
 * promise: the value on the wire is the same either way, so a name the consumer
 * does not know falls back to the plain field rather than losing the param.
 *
 * There is nothing here to ask for. It is not that a picker must name something
 * inside Initiative; it is that a consumer can only offer a control it can
 * populate, and the automation editor populates its six — a project, a task, a
 * document, a calendar, a queue, an initiative — from data it already holds. It
 * holds no GitHub credential, so it can list none of what this app asks for.
 *
 * `project_id` is the trap worth naming. It is a *Projects v2 board*, not an
 * Initiative project, so `picker: "project"` would draw a control that stores an
 * Initiative id in a field this app hands to GitHub as a node id — right-looking
 * and wrong.
 *
 * What would change this is not a name but a source for the options: a consumer
 * could offer a repository picker if this app declared a read that lists them.
 * That is a bigger decision than a hint on a param, and it is not this change.
 */
function param(
  key: string,
  type: EndpointParam["type"],
  en: string,
  de: string,
  es: string,
  fr: string
): EndpointParam {
  return { key, type, label: text(en, de, es, fr) };
}

/**
 * One value an endpoint hands back, by name, type and the words a consumer
 * picks it out by.
 *
 * Declared rather than discovered, because a consumer arranges these before the
 * endpoint has ever run: an automation offers them as values a later step may
 * read, and a step wired to something this app does not return has to be
 * refusable when somebody wires it rather than the first time it fires.
 *
 * The vocabulary is four scalar types and a list flag, which is the whole of
 * it — there is no way to describe an object, so a read answering with a list
 * of rows declares the scalars beside it and says so in a comment rather than
 * lying about the shape.
 */
function value(
  key: string,
  type: EndpointReturn["type"],
  en: string,
  de: string,
  es: string,
  fr: string
): EndpointReturn {
  return { key, type, label: text(en, de, es, fr) };
}

/** Which repository, on every write that acts inside one. */
const REPO = param("repo", "string", "Repository", "Repository", "Repositorio", "Dépôt");

/** Which issue or pull request. They share a number space at GitHub. */
const NUMBER = param("number", "int", "Number", "Nummer", "Número", "Numéro");

/** Which issue or pull request the call ended up acting on. */
const NUMBER_OUT = value("number", "int", "Number", "Nummer", "Número", "Numéro");

/** Where a person goes to look at what just happened. */
const LINK_OUT = value("html_url", "url", "Link", "Link", "Enlace", "Lien");

/**
 * Why a read has no answer — the one value every read may hand back instead of
 * the rest of them.
 *
 * Unavailability travels in the body rather than as a status, because a widget
 * draws "connect your account" and draws nothing at all from a 4xx. That makes
 * it part of every read's shape rather than an error path, so it belongs in
 * every read's declaration: an automation that branches on it is asking the
 * right question, and one that binds `total` and quietly gets nothing is not.
 */
const UNAVAILABLE = value(
  "unavailable",
  "string",
  "Why there is no answer",
  "Warum es keine Antwort gibt",
  "Por qué no hay respuesta",
  "Pourquoi il n'y a pas de réponse"
);

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
    label: text("Open an issue", "Issue öffnen", "Abrir una incidencia", "Ouvrir un ticket"),
    description: text(
      "Opens one in the connected repository.",
      "Öffnet eines im verbundenen Repository.",
      "Abre una en el repositorio conectado.",
      "En ouvre un dans le dépôt connecté."
    ),
    group: "issues",
    actors: ["member"],
    requires: { all_of: ["workspace", "account"] },
    params: [
      REPO,
      param("title", "string", "Title", "Titel", "Título", "Titre"),
      param("body", "string", "Body", "Text", "Cuerpo", "Corps"),
      param("labels", "string", "Labels", "Labels", "Etiquetas", "Étiquettes"),
      param("assignees", "string", "Assignees", "Zuständige", "Asignados", "Assignés"),
    ],
    // GitHub's own numeric id as well as the two anybody reads. It costs
    // nothing to declare what the handler already sends, and it is the only
    // identifier that survives a repository being renamed.
    returns: [
      NUMBER_OUT,
      LINK_OUT,
      value("id", "int", "GitHub id", "GitHub-ID", "ID de GitHub", "Identifiant GitHub"),
    ],
  },
  {
    id: WRITE_IDS.comment,
    direction: "write",
    label: text("Comment", "Kommentieren", "Comentar", "Commenter"),
    description: text(
      "Adds a comment to an issue or a pull request.",
      "Fügt einem Issue oder Pull Request einen Kommentar hinzu.",
      "Añade un comentario a una incidencia o pull request.",
      "Ajoute un commentaire à un ticket ou une pull request."
    ),
    group: "issues",
    actors: ["member"],
    requires: { all_of: ["workspace", "account"] },
    // Issues and pull requests share a number space and a comments endpoint, so
    // this is one write rather than two that differ by a URL segment.
    params: [REPO, NUMBER, param("body", "string", "Body", "Text", "Cuerpo", "Corps")],
    // The comment's id, not the issue's — this is the one write whose subject
    // and whose result are different things.
    returns: [
      value(
        "id",
        "int",
        "Comment id",
        "Kommentar-ID",
        "ID del comentario",
        "Identifiant du commentaire"
      ),
      LINK_OUT,
    ],
  },
  {
    id: WRITE_IDS.closeIssue,
    direction: "write",
    label: text("Close an issue", "Issue schließen", "Cerrar una incidencia", "Fermer un ticket"),
    description: text(
      "Closes it as completed or as not planned.",
      "Schließt es als erledigt oder als nicht geplant.",
      "La cierra como completada o como no planificada.",
      "Le ferme comme terminé ou comme non planifié."
    ),
    group: "issues",
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
    // `state` because one endpoint answers for both directions and a step
    // after this one may want to check rather than assume.
    returns: [NUMBER_OUT, value("state", "string", "State", "Status", "Estado", "État"), LINK_OUT],
  },
  {
    id: WRITE_IDS.reopenIssue,
    direction: "write",
    label: text(
      "Reopen an issue",
      "Issue wieder öffnen",
      "Reabrir una incidencia",
      "Rouvrir un ticket"
    ),
    description: text(
      "Puts a closed issue back into the open state.",
      "Versetzt ein geschlossenes Issue zurück in den offenen Zustand.",
      "Devuelve una incidencia cerrada al estado abierto.",
      "Remet un ticket fermé à l'état ouvert."
    ),
    group: "issues",
    actors: ["member"],
    requires: { all_of: ["workspace", "account"] },
    params: [REPO, NUMBER],
    // `state` because one endpoint answers for both directions and a step
    // after this one may want to check rather than assume.
    returns: [NUMBER_OUT, value("state", "string", "State", "Status", "Estado", "État"), LINK_OUT],
  },
  {
    id: WRITE_IDS.label,
    direction: "write",
    label: text("Change labels", "Labels ändern", "Cambiar etiquetas", "Modifier les étiquettes"),
    description: text(
      "Adds or removes labels on an issue or a pull request.",
      "Fügt an einem Issue oder Pull Request Labels hinzu oder entfernt sie.",
      "Añade o quita etiquetas en una incidencia o pull request.",
      "Ajoute ou retire des étiquettes sur un ticket ou une pull request."
    ),
    group: "issues",
    actors: ["member"],
    requires: { all_of: ["workspace", "account"] },
    params: [
      REPO,
      NUMBER,
      param("add", "string", "Labels to add", "Hinzuzufügende Labels", "Etiquetas a añadir", "Étiquettes à ajouter"),
      param("remove", "string", "Labels to remove", "Zu entfernende Labels", "Etiquetas a quitar", "Étiquettes à retirer"),
    ],
    // The number and nothing else. This one is several calls to GitHub rather
    // than one — removals, then additions — so there is no single response to
    // carry a link out of, and inventing one would be describing a field the
    // handler does not send.
    returns: [NUMBER_OUT],
  },
  {
    id: WRITE_IDS.requestReview,
    direction: "write",
    label: text(
      "Request a review",
      "Review anfragen",
      "Solicitar una revisión",
      "Demander une revue"
    ),
    description: text(
      "Asks people or teams to review a pull request.",
      "Bittet Personen oder Teams, einen Pull Request zu prüfen.",
      "Pide a personas o equipos que revisen una pull request.",
      "Demande à des personnes ou des équipes de relire une pull request."
    ),
    group: "reviews",
    actors: ["member"],
    requires: { all_of: ["workspace", "account"] },
    params: [
      REPO,
      NUMBER,
      param("reviewers", "string", "Reviewers", "Reviewer", "Revisores", "Relecteurs"),
      param("team_reviewers", "string", "Team reviewers", "Team-Reviewer", "Equipos revisores", "Équipes relectrices"),
    ],
    returns: [NUMBER_OUT, LINK_OUT],
  },
  {
    // Projects v2 is organization-scoped, which is the argument for running
    // this one as the member rather than as the app: a board a member cannot
    // see is one they should not be moving cards on, and their own token is
    // what says which boards those are.
    id: WRITE_IDS.moveProjectItem,
    direction: "write",
    label: text(
      "Move a project card",
      "Projektkarte verschieben",
      "Mover una tarjeta de proyecto",
      "Déplacer une carte de projet"
    ),
    description: text(
      "Sets one single-select field on a Projects v2 card.",
      "Setzt ein Einfachauswahl-Feld auf einer Projects-v2-Karte.",
      "Establece un campo de selección única en una tarjeta de Projects v2.",
      "Définit un champ à choix unique sur une carte Projects v2."
    ),
    group: "projects",
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
    // The card that moved, so a step after this one can act on the same card
    // without having been told the id twice.
    returns: [value("item_id", "string", "Card", "Karte", "Tarjeta", "Carte")],
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
      // The only thing an admin types: which repositories this guild cares
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
          // Required, and it is the whole of the boundary: this app resolves
          // every call against this list and matches every delivery against it,
          // so a repository absent from here is one this install has nothing to
          // say about. Written down where an admin can read it back, rather
          // than inherited from a grant they would have to go to GitHub to see.
          //
          // Comma-separated because a connection's fields draw from one closed
          // set of types and there is no array in it — deliberately, since that
          // is what lets one renderer draw every app's settings page.
          key: "repos",
          type: "string",
          required: true,
          label: {
            en: "Repositories (comma-separated)",
            de: "Repositories (kommagetrennt)",
            es: "Repositorios (separados por comas)",
            fr: "Dépôts (séparés par des virgules)",
          },
        },
      ],
    },
  ],

  endpoints: [
    {
      id: READ_IDS.openIssues,
      direction: "read",
      label: text("Open issues", "Offene Issues", "Incidencias abiertas", "Tickets ouverts"),
      description: text(
        "How many issues are open, and how that is trending.",
        "Wie viele Issues offen sind und wie sich das entwickelt.",
        "Cuántas incidencias están abiertas y su tendencia.",
        "Combien de tickets sont ouverts, et la tendance."
      ),
      group: "issues",
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
          // Optional: an install naming one repository needs nobody to say so.
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
      returns: [
        value("total", "int", "Total", "Gesamt", "Total", "Total"),
        value("delta", "int", "Change", "Veränderung", "Variación", "Variation"),
        UNAVAILABLE,
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
      label: text("Waiting on you", "Wartet auf dich", "Esperando por ti", "En attente de vous"),
      description: text(
        "Pull requests that asked for your review.",
        "Pull Requests, die deine Review angefragt haben.",
        "Pull requests que pidieron tu revisión.",
        "Pull requests qui ont demandé votre revue."
      ),
      group: "reviews",
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
          // Optional: an install naming one repository needs nobody to say so.
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
      // The count, and not the ten rows beside it. A return is a named scalar
      // or a list of them, so a list of `{number, title, url}` objects has no
      // expression here — and describing it as three separate lists would be a
      // shape this app does not send. The widget draws the rows; a step in an
      // automation gets the number it can actually branch on.
      returns: [value("total", "int", "Total", "Gesamt", "Total", "Total"), UNAVAILABLE],
      // Per member, and it could not be anything else: "waiting on me" has no
      // meaning without a me.
      requires: { all_of: ["workspace", "account"] },
    },
    {
      id: READ_IDS.dependabotAlerts,
      direction: "read",
      label: text(
        "Dependabot alerts",
        "Dependabot-Warnungen",
        "Alertas de Dependabot",
        "Alertes Dependabot"
      ),
      description: text(
        "Open dependency alerts, worst first.",
        "Offene Abhängigkeitswarnungen, die schlimmsten zuerst.",
        "Alertas de dependencias abiertas, las peores primero.",
        "Alertes de dépendances ouvertes, les pires d'abord."
      ),
      group: "security",
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
          // Optional: an install naming one repository needs nobody to say so.
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
      // The total and the link. The per-severity breakdown is a list of
      // objects, which this vocabulary cannot describe — see the review queue
      // above for why it is left undeclared rather than approximated.
      returns: [
        value("total", "int", "Total", "Gesamt", "Total", "Total"),
        value("url", "url", "Link", "Link", "Enlace", "Lien"),
        UNAVAILABLE,
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
      label: text(
        "Issues opened and closed",
        "Geöffnete und geschlossene Issues",
        "Incidencias abiertas y cerradas",
        "Tickets ouverts et fermés"
      ),
      description: text(
        "A fortnight of opens against closes.",
        "Zwei Wochen Öffnungen gegen Schließungen.",
        "Dos semanas de aperturas frente a cierres.",
        "Deux semaines d'ouvertures contre fermetures."
      ),
      group: "issues",
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
          // Optional: an install naming one repository needs nobody to say so.
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
      // Only the one field, and it is worth being plain about why: this read
      // answers with a fortnight of `{day, opened, closed}` rows, and a series
      // is the shape a scalar vocabulary cannot describe at all. So the
      // declaration says what it honestly can. This is a tile that a widget
      // draws rather than a question an automation asks, and a consumer sees
      // that from the declaration instead of finding it out by wiring one up.
      returns: [UNAVAILABLE],
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
