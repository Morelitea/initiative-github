import type {
  EndpointIdentity,
  EndpointParam,
  EndpointReturn,
  LocalizedText,
  ValueSource,
} from "initiative-app-kit";

export const CONNECT_PATH = "/connect/github";

export const CALLBACK_PATH = "/connect/github/callback";

export const SETUP_PATH = "/setup/github";

export const INSTALL_PATH = "/install/github";

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
 * The same parameter, holding several values.
 *
 * These were comma-separated strings by convention until a parameter could say
 * `list` — six of them across this manifest — which meant an automation editor
 * could not validate one, could not complete one, and could not draw one as
 * anything but a text box with a hint about commas. The value on the wire is
 * unchanged for this app: `paramList` already accepted an array or a string.
 */
export function several(base: EndpointParam): EndpointParam {
  return { ...base, list: true };
}

/**
 * A parameter whose choices this app answers itself.
 *
 * The half of the vocabulary worth reading this file for. Every one of the
 * twenty-seven parameters here wants a list GitHub can already give —
 * repositories, labels, boards, board fields, the values of one of those
 * fields — and until a parameter could name a read of ours, none of them could
 * say so. There is nothing an automation editor could have done about that on
 * its own: it holds no GitHub credential, so it can fill only pickers over
 * Initiative's own data, which is why `resource` appears nowhere in this file.
 *
 * `feeds` is what makes the dependent ones work, and it is the majority case:
 * labels are ONE repository's labels, a board field's options are ONE board's.
 * A source that could not pass a sibling's value would have served the few
 * parameters that stand alone.
 */
export function fed(
  base: EndpointParam,
  endpoint: string,
  values: string,
  options: { labels?: string; feeds?: Record<string, string> } = {}
): EndpointParam {
  const source: ValueSource = {
    endpoint,
    values,
    ...(options.labels ? { labels: options.labels } : {}),
    ...(options.feeds
      ? {
          params: Object.fromEntries(
            Object.entries(options.feeds).map(([key, from]) => [key, { from }])
          ),
        }
      : {}),
  };
  return { ...base, source };
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

/** A choice with words on it, for a value somebody READS rather than types. */
export function choice(
  value: string,
  en: string,
  de: string,
  es: string,
  fr: string
): { value: string; label: LocalizedText } {
  return { value, label: text(en, de, es, fr) };
}

export function value(
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
 * Which repository, on thirteen of this app's twenty endpoints.
 *
 * The parameter that made the case for value sources. "A repository" is not
 * something an automation editor has a control for and never sensibly will, so
 * before this it was a text box you had to know the right name for — on more
 * than half the endpoints here.
 *
 * It stays a plain `string` on the wire, and the reason matters: `resolveRepository`
 * still accepts a bare name and still falls back to the workspace's single
 * repository when the parameter is absent, so a stored automation that typed
 * one keeps working and a one-repository install can leave it blank.
 */
export const REPO = fed(
  param("repo", "string", "Repository", "Repository", "Repositorio", "Dépôt"),
  READ_IDS.listRepositories,
  "names"
);

export const NUMBER = param("number", "int", "Number", "Nummer", "Número", "Numéro");

/**
 * Which Projects v2 board.
 *
 * Deliberately NOT `resource: "projects"`, and this is the trap the resource
 * vocabulary invites: this names a GitHub board, not an Initiative project, so
 * the picker that looks right is the wrong one and would fill the field with
 * an id this app cannot resolve. What it wants is the board list, which this
 * app can answer and nobody else can.
 *
 * The values are opaque GraphQL node ids, so the titles carry the labels —
 * otherwise the menu would be a column of base64.
 */
export const PROJECT_ID = fed(
  param("project_id", "string", "Project", "Projekt", "Proyecto", "Projet"),
  READ_IDS.listProjects,
  "ids",
  { labels: "titles" }
);

export function pick(
  key: string,
  options: Array<string | { value: string; label: LocalizedText }>,
  en: string,
  de: string,
  es: string,
  fr: string
): EndpointParam {
  return { key, type: "select", options, label: text(en, de, es, fr) };
}

export function many(
  key: string,
  type: EndpointReturn["type"],
  en: string,
  de: string,
  es: string,
  fr: string
): EndpointReturn {
  return { ...value(key, type, en, de, es, fr), list: true };
}

export const REPO_OUT = value("repository", "string", "Repository", "Repository", "Repositorio", "Dépôt");

export const OWNER_OUT = value("owner", "string", "Owner", "Inhaber", "Propietario", "Propriétaire");

export const URL_OUT = value("url", "url", "Link", "Link", "Enlace", "Lien");

export const COUNT_OUT = value("count", "int", "How many", "Wie viele", "Cuántos", "Combien");

export const TOTAL_OUT = value("total", "int", "How many in all", "Wie viele insgesamt", "Cuántos en total", "Combien en tout");

export const AUTHOR_OUT = value("author", "string", "Author", "Autor", "Autor", "Auteur");

export const LABELS_OUT = many("labels", "string", "Labels", "Labels", "Etiquetas", "Étiquettes");

export const TITLE_OUT = value("title", "string", "Title", "Titel", "Título", "Titre");

export const STATE_OUT = value("state", "string", "State", "Status", "Estado", "État");

export const ASSIGNEES_OUT = many("assignees", "string", "Assignees", "Zuständige", "Asignados", "Assignés");

export const MILESTONE_OUT = value("milestone", "string", "Milestone", "Meilenstein", "Hito", "Jalon");

export const COMMENTS_OUT = value("comments", "int", "Comments", "Kommentare", "Comentarios", "Commentaires");

export const CREATED_OUT = value(
  "created_at",
  "string",
  "Opened",
  "Geöffnet",
  "Abierta",
  "Ouvert"
);
export const UPDATED_OUT = value(
  "updated_at",
  "string",
  "Last updated",
  "Zuletzt aktualisiert",
  "Última actualización",
  "Dernière mise à jour"
);
export const CLOSED_OUT = value("closed_at", "string", "Closed", "Geschlossen", "Cerrada", "Fermé");

export const UNAVAILABLE = value(
  "unavailable",
  "string",
  "Why there is no answer",
  "Warum es keine Antwort gibt",
  "Por qué no hay respuesta",
  "Pourquoi il n'y a pas de réponse"
);

export const ROWS_OUT: EndpointReturn[] = [
  many("numbers", "int", "Numbers", "Nummern", "Números", "Numéros"),
  many("titles", "string", "Titles", "Titel", "Títulos", "Titres"),
  many("urls", "url", "Links", "Links", "Enlaces", "Liens"),
  many("states", "string", "States", "Status", "Estados", "États"),
  many("created_at", "string", "Opened", "Geöffnet", "Abiertas", "Ouverts"),
  many("updated_at", "string", "Last updated", "Zuletzt aktualisiert", "Última actualización", "Dernière mise à jour"),
  many("closed_at", "string", "Closed", "Geschlossen", "Cerradas", "Fermés"),
  COUNT_OUT,
  TOTAL_OUT,
  UNAVAILABLE,
];

/**
 * Labels, fed from the repository picked beside them.
 *
 * The dependent case, and the one that decides whether a source declaration is
 * worth having: a repository's labels are that repository's. Eight of this
 * app's parameters are in this shape.
 */
export const LABELS_IN = fed(
  several(param("labels", "string", "Labels", "Labels", "Etiquetas", "Étiquettes")),
  READ_IDS.listLabels,
  "names",
  { feeds: { repo: "repo" } }
);

export const SORT_IN = pick(
  "sort",
  [
    choice("created", "When it was opened", "Öffnungszeit", "Cuándo se abrió", "Date d'ouverture"),
    choice(
      "updated",
      "When it last changed",
      "Letzte Änderung",
      "Última modificación",
      "Dernière modification"
    ),
    choice("comments", "How many comments", "Anzahl Kommentare", "Número de comentarios", "Nombre de commentaires"),
  ],
  "Order by",
  "Sortieren nach",
  "Ordenar por",
  "Trier par"
);
export const DIRECTION_IN = pick(
  "direction",
  [
    choice("desc", "Newest first", "Neueste zuerst", "Más recientes primero", "Plus récents d'abord"),
    choice("asc", "Oldest first", "Älteste zuerst", "Más antiguos primero", "Plus anciens d'abord"),
  ],
  "Order",
  "Reihenfolge",
  "Orden",
  "Ordre"
);

/**
 * How many rows to bring back.
 *
 * The bounds are `readLimit`'s own, written here so the control carries them
 * rather than silently clamping a number somebody typed — and the default is
 * what the endpoint uses when the parameter is absent, so the form opens
 * showing what it will actually do.
 */
export const LIMIT_IN: EndpointParam = {
  ...param("limit", "int", "How many", "Wie viele", "Cuántos", "Combien"),
  default: 30,
  constraints: { min: 1, max: 100 },
};

/**
 * Only what changed since an instant.
 *
 * A `string` until a parameter could be a `datetime`, which meant a text box
 * somebody typed ISO-8601 into by hand. The value on the wire is the same
 * string; what changed is that an editor now knows to draw a date and a time.
 */
export const SINCE_IN = param("since", "datetime", "Since", "Seit", "Desde", "Depuis");
export const SINCE_DAYS_IN: EndpointParam = {
  ...param("since_days", "int", "Days back", "Tage zurück", "Días atrás", "Jours en arrière"),
  constraints: { min: 1 },
};

export const NUMBER_OUT = value("number", "int", "Number", "Nummer", "Número", "Numéro");

export const LINK_OUT = value("html_url", "url", "Link", "Link", "Enlace", "Lien");
