import type {
  EndpointIdentity,
  EndpointParam,
  EndpointReturn,
  LocalizedText,
} from "initiative-app-kit";

export const CONNECT_PATH = "/connect/github";

export const CALLBACK_PATH = "/connect/github/callback";

export const SETUP_PATH = "/setup/github";

/**
 * Where an installer proves the installation they just claimed is theirs.
 *
 * A second registered callback rather than the one a member signs in at.
 * GitHub returns an installation to the setup URL with an `installation_id`
 * anybody can type, so that trip ends by asking the person to authorize — and
 * *that* answer comes back here, where the claim is checked against what
 * GitHub says they actually hold. Two callbacks, one for each question, so
 * neither route has to work out which of the two it is looking at.
 */
export const VERIFY_PATH = "/install/github/verify";

export const INSTALL_PATH = "/install/github";

/**
 * Where an operator registers this app at GitHub, and where GitHub answers.
 *
 * Reachable only while `INITIATIVE_APP_SETUP_TOKEN` is set, which is the only
 * thing that makes an unregistered app willing to do anything at all.
 */
export const REGISTER_PATH = "/setup/register";

export const REGISTER_DONE_PATH = "/setup/register/done";

export const WEBHOOK_PATH = "/webhooks/github";

export { ENDPOINTS_PATH, SUBSCRIPTIONS_PATH } from "initiative-app-kit";

// Apart from the manifest because the endpoints, widgets and emissions all name
// these, and any of them importing the manifest that declares it is a cycle a
// bundler resolves by handing somebody `undefined`.
export const PUBLIC_ID = "morelitea.github";

export function declare(name: string): string {
  return `app.${PUBLIC_ID}.${name}`;
}

export const READ_IDS = {
  listRepositories: declare("list-repositories"),
  listLabels: declare("list-labels"),
  listProjectFields: declare("list-project-fields"),
  getIssue: declare("get-issue"),
  findIssues: declare("find-issues"),
  getPullRequest: declare("get-pull-request"),
  findPullRequests: declare("find-pull-requests"),
  listAlerts: declare("list-alerts"),
  listProjects: declare("list-projects"),
  listProjectOptions: declare("list-project-options"),
  findProjectItem: declare("find-project-item"),
} as const;

export const WRITE_IDS = {
  openIssue: declare("open-issue"),
  comment: declare("comment"),
  closeIssue: declare("close-issue"),
  reopenIssue: declare("reopen-issue"),
  label: declare("label"),
  requestReview: declare("request-review"),
  moveProjectItem: declare("move-project-item"),
} as const;

export function text(en: string, de: string, es: string, fr: string): LocalizedText {
  return { en, de, es, fr };
}

export function param(
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
 * One value an endpoint hands back.
 *
 * Key and type, and nothing else by default. A return's key IS the word a
 * caller reads it by — `title`, `author`, `closed_at` — so a label repeating it
 * translated four ways is four strings that say what `key` already said, and a
 * fifth language nobody wrote makes the set incomplete rather than the value
 * unreadable.
 *
 * Where the key genuinely does not say it, {@link named} does. Those are the
 * ones worth translating, and the reason the two are separate helpers is so
 * that adding a label is a decision rather than the shape of the call.
 */
export function value(key: string, type: EndpointReturn["type"]): EndpointReturn {
  return { key, type };
}

/**
 * A return whose key does not say what it is.
 *
 * `head_ref` is a branch but not which end; `created_at` on an issue is when it
 * was *opened*; `count` beside `total` is which of the two. Each of those is a
 * fact about the API that a caller cannot get from the key, which is what earns
 * the four translations.
 */
export function named(
  key: string,
  type: EndpointReturn["type"],
  en: string,
  de: string,
  es: string,
  fr: string
): EndpointReturn {
  return { key, type, label: text(en, de, es, fr) };
}

/**
 * The same parameter, holding several values.
 *
 * Six of them across this manifest were comma-separated strings by convention
 * until a parameter could say `list`, and a convention is not something a
 * caller can build a request from. The value on the wire is unchanged for this
 * app: `paramList` already accepted an array or a string.
 */
export function several(base: EndpointParam): EndpointParam {
  return { ...base, list: true };
}

/**
 * What a write touched, or what an emission is about.
 *
 * One helper because the two have to AGREE: an automation service keeps a
 * change this app made from firing that same automation again, and it can only
 * do that if `open-issue` and `issue-opened` describe an issue the same way.
 * Written once here rather than twice at the two ends.
 *
 * A repository name plus a number, because that is what identifies an issue on
 * GitHub — the numeric `id` would be shorter and is not on the webhook payload
 * this app translates, so the two ends could not have met on it.
 */
export const ISSUE_IDENTITY: EndpointIdentity = {
  kind: "issue",
  key: ["repository", "number"],
};

/**
 * Which repository, on thirteen of this app's endpoints.
 *
 * A plain `string`, and this manifest says nothing about how a caller should
 * ask for one — because it is not this app's place to. A consumer that wants a
 * repository picker calls `list-repositories`, which exists for exactly that
 * and answers the guild's list narrowed to what the caller can see.
 *
 * `resolveRepository` accepts a bare name and falls back to the workspace's
 * single repository when the parameter is absent, so a one-repository install
 * can leave it blank.
 */
export const REPO = param("repo", "string", "Repository", "Repository", "Repositorio", "Dépôt");

export const NUMBER = param("number", "int", "Number", "Nummer", "Número", "Numéro");

/**
 * Which Projects v2 board, as an opaque GraphQL node id.
 *
 * `list-projects` answers the ids beside their titles, which is what anybody
 * offering a menu of these needs — a column of base64 names nothing.
 */
export const PROJECT_ID = param("project_id", "string", "Project", "Projekt", "Proyecto", "Projet");

export function pick(
  key: string,
  options: string[],
  en: string,
  de: string,
  es: string,
  fr: string
): EndpointParam {
  return { key, type: "select", options, label: text(en, de, es, fr) };
}

/** The same return, holding several values. Mirrors {@link several}. */
export function many(base: EndpointReturn): EndpointReturn {
  return { ...base, list: true };
}

export const REPO_OUT = value("repository", "string");

export const OWNER_OUT = value("owner", "string");

export const URL_OUT = value("url", "url");

/**
 * How many came back, and how many there are.
 *
 * The one pair here whose keys cannot be told apart on sight: side by side in a
 * returns list, `count` and `total` are two integers and nothing says which is
 * the page and which is the whole. So both are named, and the pair is why.
 */
export const COUNT_OUT = named("count", "int", "How many", "Wie viele", "Cuántos", "Combien");

export const TOTAL_OUT = named(
  "total",
  "int",
  "How many in all",
  "Wie viele insgesamt",
  "Cuántos en total",
  "Combien en tout"
);

export const AUTHOR_OUT = value("author", "string");

export const LABELS_OUT = many(value("labels", "string"));

export const TITLE_OUT = value("title", "string");

export const STATE_OUT = value("state", "string");

export const ASSIGNEES_OUT = many(value("assignees", "string"));

export const MILESTONE_OUT = value("milestone", "string");

export const COMMENTS_OUT = value("comments", "int");

/** GitHub's `created_at`; on an issue the moment it was **opened**, which is
 *  the word everything else about an issue uses. */
export const CREATED_OUT = named(
  "created_at",
  "string",
  "Opened",
  "Geöffnet",
  "Abierta",
  "Ouvert"
);

/** Not "when it was updated" but the **last** time — the key reads as either. */
export const UPDATED_OUT = named(
  "updated_at",
  "string",
  "Last updated",
  "Zuletzt aktualisiert",
  "Última actualización",
  "Dernière mise à jour"
);

export const CLOSED_OUT = value("closed_at", "string");

/** The one return that is not data. Named because `unavailable` says a thing is
 *  missing and not that this carries the reason. */
export const UNAVAILABLE = named(
  "unavailable",
  "string",
  "Why there is no answer",
  "Warum es keine Antwort gibt",
  "Por qué no hay respuesta",
  "Pourquoi il n'y a pas de réponse"
);

export const ROWS_OUT: EndpointReturn[] = [
  many(value("numbers", "int")),
  many(value("titles", "string")),
  many(value("urls", "url")),
  many(value("states", "string")),
  many(CREATED_OUT),
  many(UPDATED_OUT),
  many(value("closed_at", "string")),
  COUNT_OUT,
  TOTAL_OUT,
  UNAVAILABLE,
];

/** Several labels. `list-labels` answers a repository's, for anyone offering
 *  a menu of them. */
export const LABELS_IN = several(
  param("labels", "string", "Labels", "Labels", "Etiquetas", "Étiquettes")
);

export const SORT_IN = pick(
  "sort",
  ["created", "updated", "comments"],
  "Order by",
  "Sortieren nach",
  "Ordenar por",
  "Trier par"
);
export const DIRECTION_IN = pick(
  "direction",
  ["desc", "asc"],
  "Order",
  "Reihenfolge",
  "Orden",
  "Ordre"
);

/** How many rows to bring back. `readLimit` clamps into 1..100 and defaults
 *  to 30 when it is absent — behaviour, which this app owns, rather than a
 *  bound on a control, which it does not. */
export const LIMIT_IN = param("limit", "int", "How many", "Wie viele", "Cuántos", "Combien");

/** Only what changed since an instant, as RFC 3339. A `datetime` because that
 *  is what the endpoint ACCEPTS, not because of what anyone draws for it. */
export const SINCE_IN = param("since", "datetime", "Since", "Seit", "Desde", "Depuis");
export const SINCE_DAYS_IN = param(
  "since_days",
  "int",
  "Days back",
  "Tage zurück",
  "Días atrás",
  "Jours en arrière"
);

export const NUMBER_OUT = value("number", "int");

/** GitHub answers both an API `url` and an `html_url`; this is the one a person
 *  can open, which is the whole of what the key does not say. */
export const LINK_OUT = named("html_url", "url", "Link", "Link", "Enlace", "Lien");
