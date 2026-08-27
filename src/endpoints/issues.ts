import type { Caller } from "./index.js";
import type { StoredWorkspace } from "../workspace.js";
import type { Read, Write } from "./index.js";
import {
  ASSIGNEES_OUT,
  AUTHOR_OUT,
  CLOSED_OUT,
  COMMENTS_OUT,
  COUNT_OUT,
  CREATED_OUT,
  DIRECTION_IN,
  LABELS_IN,
  LABELS_OUT,
  LIMIT_IN,
  LINK_OUT,
  MILESTONE_OUT,
  NUMBER,
  NUMBER_OUT,
  OWNER_OUT,
  READ_IDS,
  REPO,
  REPO_OUT,
  ROWS_OUT,
  SINCE_DAYS_IN,
  SINCE_IN,
  SORT_IN,
  STATE_OUT,
  TITLE_OUT,
  TOTAL_OUT,
  UNAVAILABLE,
  UPDATED_OUT,
  URL_OUT,
  WRITE_IDS,
  ISSUE_IDENTITY,
  choice,
  declare,
  fed,
  many,
  param,
  pick,
  several,
  text,
  value,
} from "../vocabulary.js";
import type {
  Connection,
  Row,
  SubjectNode,
} from "../github/api.js";
import {
  NOT_FOUND,
  PAGE,
  ROW_FIELDS,
  SUBJECT_FIELDS,
  access,
  connected,
  empty,
  graphql,
  listed,
  ordering,
  plain,
  readChoice,
  readInt,
  readLimit,
  readNames,
  readSince,
  readText,
  rows,
  states,
  subject,
} from "../github/api.js";
import type {
  Actor,
  OperationResult,
} from "../github/api.js";
import {
  call,
  fail,
  failed,
  identifiers,
  paramInt,
  paramList,
  paramText,
  where,
} from "../github/api.js";

const ISSUE_STATES = ["open", "closed", "all"] as const;

export const listLabels: Read = {
  declaration: {
    id: READ_IDS.listLabels,
    direction: "read",
    label: text("Labels", "Labels", "Etiquetas", "Étiquettes"),
    description: text(
      "Every label that exists on the repository.",
      "Alle Labels, die es im Repository gibt.",
      "Todas las etiquetas que existen en el repositorio.",
      "Toutes les étiquettes qui existent dans le dépôt."
    ),
    group: "issues",
    actors: ["member"],
    visibility: "member",
    cache_ttl_seconds: 300,
    params: [REPO],

    returns: [
      many("names", "string", "Labels", "Labels", "Etiquetas", "Étiquettes"),
      COUNT_OUT,
      TOTAL_OUT,
      UNAVAILABLE,
    ],
    requires: { all_of: ["workspace", "account"] },
  },

  async run(caller: Caller, params: URLSearchParams) {
    const where = await access(caller, params);
    if ("unavailable" in where) return where;
    const { token, owner, repo } = where;

    const answer = await graphql<{
      repository: { labels: Connection<{ name?: string }> } | null;
    }>(
      token,
      `query Labels($owner: String!, $repo: String!, $first: Int!) {
         repository(owner: $owner, name: $repo) {
           labels(first: $first) { totalCount nodes { name } }
         }
       }`,
      { owner, repo, first: PAGE }
    );
    if (empty(answer)) return answer;
    if (!answer.body.repository) return NOT_FOUND;

    const found = rows(answer.body.repository.labels)
      .map((label) => label.name)
      .filter((name): name is string => typeof name === "string");
    return {
      names: found,
      count: found.length,
      total: answer.body.repository.labels.totalCount ?? found.length,
    };
  },
};

export const getIssue: Read = {
  declaration: {
    id: READ_IDS.getIssue,
    direction: "read",
    label: text("Get an issue", "Issue abrufen", "Obtener una incidencia", "Récupérer un ticket"),
    description: text(
      "One issue by number — its state, its labels and who it is assigned to.",
      "Ein Issue nach Nummer — Status, Labels und zuständige Personen.",
      "Una incidencia por número: su estado, sus etiquetas y a quién está asignada.",
      "Un ticket par numéro — son état, ses étiquettes et à qui il est assigné."
    ),
    group: "issues",
    actors: ["member"],
    visibility: "member",

    cache_ttl_seconds: 0,
    params: [REPO, NUMBER],
    returns: [
      REPO_OUT,
      OWNER_OUT,
      NUMBER_OUT,
      TITLE_OUT,
      STATE_OUT,

      value(
        "state_reason",
        "string",
        "Why it closed",
        "Warum geschlossen",
        "Motivo del cierre",
        "Raison de la fermeture"
      ),
      URL_OUT,
      AUTHOR_OUT,
      LABELS_OUT,
      ASSIGNEES_OUT,
      MILESTONE_OUT,
      COMMENTS_OUT,

      value(
        "is_pull_request",
        "bool",
        "Is a pull request",
        "Ist ein Pull Request",
        "Es una pull request",
        "Est une pull request"
      ),
      CREATED_OUT,
      UPDATED_OUT,
      CLOSED_OUT,
      UNAVAILABLE,
    ],
    requires: { all_of: ["workspace", "account"] },
  },

  async run(caller: Caller, params: URLSearchParams) {
    const where = await access(caller, params);
    if ("unavailable" in where) return where;
    const { token, owner, repo } = where;

    const number = readInt(params, "number");
    if (number === undefined) return { unavailable: "number-required" };

    const answer = await graphql<{
      repository: { issueOrPullRequest: SubjectNode | null } | null;
    }>(
      token,
      `query Subject($owner: String!, $repo: String!, $number: Int!) {
         repository(owner: $owner, name: $repo) {
           issueOrPullRequest(number: $number) {
             __typename
             ... on Issue { ${SUBJECT_FIELDS} stateReason }
             ... on PullRequest { ${SUBJECT_FIELDS} }
           }
         }
       }`,
      { owner, repo, number }
    );
    if (empty(answer)) return answer;

    const node = answer.body.repository?.issueOrPullRequest;
    if (!node) return NOT_FOUND;

    return {
      ...subject(node, owner, repo),

      state_reason: plain(node.stateReason),

      is_pull_request: node.__typename === "PullRequest",
    };
  },
};

export const findIssues: Read = {
  declaration: {
    id: READ_IDS.findIssues,
    direction: "read",
    label: text("Find issues", "Issues suchen", "Buscar incidencias", "Rechercher des tickets"),
    description: text(
      "The issues matching a question, as the numbers to act on.",
      "Die Issues, die zu einer Frage passen — als die Nummern, auf die man handelt.",
      "Las incidencias que coinciden con una consulta, como los números sobre los que actuar.",
      "Les tickets correspondant à une question, sous forme des numéros sur lesquels agir."
    ),
    group: "issues",
    actors: ["member"],
    visibility: "member",
    cache_ttl_seconds: 60,
    params: [
      REPO,
      pick(
        "state",
        [
          choice("open", "Open", "Offen", "Abiertas", "Ouverts"),
          choice("closed", "Closed", "Geschlossen", "Cerradas", "Fermés"),
          choice("all", "Any", "Beliebig", "Cualquiera", "Tous"),
        ],
        "State",
        "Status",
        "Estado",
        "État"
      ),
      LABELS_IN,
      param("assignee", "string", "Assignee", "Zuständige Person", "Persona asignada", "Personne assignée"),
      param("milestone", "int", "Milestone number", "Meilenstein-Nummer", "Número de hito", "Numéro de jalon"),
      SINCE_IN,
      SINCE_DAYS_IN,
      SORT_IN,
      DIRECTION_IN,
      LIMIT_IN,
    ],
    returns: ROWS_OUT,
    requires: { all_of: ["workspace", "account"] },
  },

  async run(caller: Caller, params: URLSearchParams) {
    const where = await access(caller, params);
    if ("unavailable" in where) return where;
    const { token, owner, repo } = where;

    const answer = await graphql<{
      repository: { issues: Connection<Row> } | null;
    }>(
      token,
      `query Issues($owner: String!, $repo: String!, $first: Int!, $filter: IssueFilters, $order: IssueOrder!) {
         repository(owner: $owner, name: $repo) {
           issues(first: $first, filterBy: $filter, orderBy: $order) {
             totalCount
             nodes { ${ROW_FIELDS} }
           }
         }
       }`,
      {
        owner,
        repo,
        first: readLimit(params),
        order: ordering(params),
        filter: {
          states: states(readChoice(params, "state", ISSUE_STATES, "open")),
          ...(readNames(params, "labels") ? { labels: readNames(params, "labels") } : {}),
          ...(readText(params, "assignee") ? { assignee: readText(params, "assignee") } : {}),
          ...(readText(params, "milestone") ? { milestoneNumber: readText(params, "milestone") } : {}),
          ...(readSince(params) ? { since: readSince(params) } : {}),
        },
      }
    );
    if (empty(answer)) return answer;
    if (!answer.body.repository) return NOT_FOUND;

    const found = rows(answer.body.repository.issues);
    return listed(found, answer.body.repository.issues.totalCount);
  },
};

async function setState(
  actor: Actor,
  workspace: StoredWorkspace | null,
  params: Record<string, unknown>,
  closing: boolean
): Promise<OperationResult> {
  const place = await where(workspace, params);
  if (failed(place)) return place;

  const number = paramInt(params, "number");
  if (number === undefined) return fail(400, "number is required");
  const reason = paramText(params, "reason");

  const answer = await call(
    actor,
    "PATCH",
    `/repos/${place.owner}/${place.repo}/issues/${number}`,
    {
      state: closing ? "closed" : "open",
      ...(closing && (reason === "completed" || reason === "not_planned")
        ? { state_reason: reason }
        : {}),
    }
  );
  if (failed(answer)) return answer;
  return {
    actor: actor.kind,
    result: {
      repository: place.repo,
      ...identifiers(answer, ["number", "state", "html_url"]),
    },
  };
}

export const openIssue: Write = {
  declaration: {
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
      { ...param("title", "string", "Title", "Titel", "Título", "Titre"), required: true },
      param("body", "string", "Body", "Text", "Cuerpo", "Corps"),
      LABELS_IN,
      several(param("assignees", "string", "Assignees", "Zuständige", "Asignados", "Assignés")),
    ],

    // `repository` rides along so the identity below can be built. It costs a
    // string on a payload that already carries three and it is the difference
    // between an automation service being able to tell this write apart from
    // another repository's and not.
    returns: [
      REPO_OUT,
      NUMBER_OUT,
      LINK_OUT,
      value("id", "int", "GitHub id", "GitHub-ID", "ID de GitHub", "Identifiant GitHub"),
    ],
    identity: ISSUE_IDENTITY,
  },

  async run(actor, workspace, params) {
    const place = await where(workspace, params);
    if (failed(place)) return place;

    const title = paramText(params, "title");
    if (!title) return fail(400, "title is required");

    const answer = await call(actor, "POST", `/repos/${place.owner}/${place.repo}/issues`, {
      title,
      ...(paramText(params, "body") ? { body: paramText(params, "body") } : {}),
      ...(paramList(params, "labels").length ? { labels: paramList(params, "labels") } : {}),
      ...(paramList(params, "assignees").length
        ? { assignees: paramList(params, "assignees") }
        : {}),
    });
    if (failed(answer)) return answer;
    return {
      actor: actor.kind,
      result: { repository: place.repo, ...identifiers(answer, ["number", "html_url", "id"]) },
    };
  },
};

export const comment: Write = {
  declaration: {
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

    params: [
      REPO,
      NUMBER,
      { ...param("body", "string", "Body", "Text", "Cuerpo", "Corps"), required: true },
    ],

    returns: [
      REPO_OUT,
      NUMBER_OUT,
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
    // A comment is a change to the ISSUE, which is what a flow watching issues
    // would otherwise re-fire on. Naming the issue rather than minting a
    // "comment" kind is what makes that suppression work at all.
    identity: ISSUE_IDENTITY,
  },

  async run(actor, workspace, params) {
    const place = await where(workspace, params);
    if (failed(place)) return place;

    const number = paramInt(params, "number");
    const body = paramText(params, "body");
    if (number === undefined) return fail(400, "number is required");
    if (!body) return fail(400, "body is required");

    const answer = await call(
      actor,
      "POST",
      `/repos/${place.owner}/${place.repo}/issues/${number}/comments`,
      { body }
    );
    if (failed(answer)) return answer;
    return {
      actor: actor.kind,
      result: {
        repository: place.repo,
        number,
        ...identifiers(answer, ["id", "html_url"]),
      },
    };
  },
};

export const closeIssue: Write = {
  declaration: {
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
      pick(
        "reason",
        [
          choice("completed", "Completed", "Erledigt", "Completada", "Terminé"),
          choice("not_planned", "Not planned", "Nicht geplant", "No planificada", "Non planifié"),
        ],
        "Reason",
        "Grund",
        "Motivo",
        "Raison"
      ),
    ],

    returns: [
      REPO_OUT,
      NUMBER_OUT,
      value("state", "string", "State", "Status", "Estado", "État"),
      LINK_OUT,
    ],
    identity: ISSUE_IDENTITY,
  },

  async run(actor, workspace, params) {
    return setState(actor, workspace, params, true);
  },
};

export const reopenIssue: Write = {
  declaration: {
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

    returns: [
      REPO_OUT,
      NUMBER_OUT,
      value("state", "string", "State", "Status", "Estado", "État"),
      LINK_OUT,
    ],
    identity: ISSUE_IDENTITY,
  },

  async run(actor, workspace, params) {
    return setState(actor, workspace, params, false);
  },
};

export const label: Write = {
  declaration: {
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
    // Both fed from the repository above, which is the shape a source
    // declaration exists for: a repository's labels are that repository's, and
    // an editor asking for them without saying which would get nothing.
    params: [
      REPO,
      NUMBER,
      fed(
        several(
          param("add", "string", "Labels to add", "Hinzuzufügende Labels", "Etiquetas a añadir", "Étiquettes à ajouter")
        ),
        READ_IDS.listLabels,
        "names",
        { feeds: { repo: "repo" } }
      ),
      fed(
        several(
          param("remove", "string", "Labels to remove", "Zu entfernende Labels", "Etiquetas a quitar", "Étiquettes à retirer")
        ),
        READ_IDS.listLabels,
        "names",
        { feeds: { repo: "repo" } }
      ),
    ],

    returns: [REPO_OUT, NUMBER_OUT],
    identity: ISSUE_IDENTITY,
  },

  async run(actor, workspace, params) {
    const place = await where(workspace, params);
    if (failed(place)) return place;
    const base = `/repos/${place.owner}/${place.repo}/issues`;

    const number = paramInt(params, "number");
    if (number === undefined) return fail(400, "number is required");
    const add = paramList(params, "add");
    const remove = paramList(params, "remove");
    if (!add.length && !remove.length) {
      return fail(400, "name a label to add or to remove");
    }

    // Removals first, so a call that both removes and adds the same name ends
    // with it present. A label that was not there is the state being asked for.
    for (const name of remove) {
      const answer = await call(
        actor,
        "DELETE",
        `${base}/${number}/labels/${encodeURIComponent(name)}`
      );

      if (failed(answer) && answer.status !== 404) return answer;
    }
    if (!add.length) {
      return { actor: actor.kind, result: { repository: place.repo, number } };
    }

    const answer = await call(actor, "POST", `${base}/${number}/labels`, { labels: add });
    if (failed(answer)) return answer;
    return { actor: actor.kind, result: { repository: place.repo, number } };
  },
};
