import type { EndpointParam, EndpointReturn, LocalizedText } from "initiative-app-kit";

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

export const REPO = param("repo", "string", "Repository", "Repository", "Repositorio", "Dépôt");

export const NUMBER = param("number", "int", "Number", "Nummer", "Número", "Numéro");

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

export const LABELS_IN = param("labels", "string", "Labels", "Labels", "Etiquetas", "Étiquettes");
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
  "Newest first",
  "Neueste zuerst",
  "Más recientes primero",
  "Plus récents d'abord"
);
export const LIMIT_IN = param("limit", "int", "How many", "Wie viele", "Cuántos", "Combien");

export const SINCE_IN = param("since", "string", "Since", "Seit", "Desde", "Depuis");
export const SINCE_DAYS_IN = param(
  "since_days",
  "int",
  "Days back",
  "Tage zurück",
  "Días atrás",
  "Jours en arrière"
);

export const NUMBER_OUT = value("number", "int", "Number", "Nummer", "Número", "Numéro");

export const LINK_OUT = value("html_url", "url", "Link", "Link", "Enlace", "Lien");
