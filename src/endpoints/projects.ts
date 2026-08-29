import type { Caller } from "./index.js";
import type { Read, Write } from "./index.js";
import {
  COUNT_OUT,
  many,
  named,
  NUMBER,
  NUMBER_OUT,
  OWNER_OUT,
  param,
  PROJECT_ID,
  READ_IDS,
  REPO,
  REPO_OUT,
  text,
  TOTAL_OUT,
  UNAVAILABLE,
  value,
  WRITE_IDS,
} from "../vocabulary.js";
import type {
  Connection,
} from "../github/api.js";
import {
  NOT_FOUND,
  PAGE,
  access,
  connected,
  empty,
  graphql,
  listed,
  readInt,
  readText,
  rows,
} from "../github/api.js";
import {
  fail,
  failed,
  paramText,
  where,
  mutate,
} from "../github/api.js";

export const listProjects: Read = {
  declaration: {
    id: READ_IDS.listProjects,
    direction: "read",
    label: text(
      "Project boards",
      "Projektboards",
      "Tableros de proyecto",
      "Tableaux de projet"
    ),
    description: text(
      "The Projects v2 boards on this install's account.",
      "Die Projects-v2-Boards des Kontos dieser Installation.",
      "Los tableros de Projects v2 de la cuenta de esta instalación.",
      "Les tableaux Projects v2 du compte de cette installation."
    ),
    group: "projects",
    actors: ["member", "installation"],
    visibility: "member",
    cache_ttl_seconds: 300,

    returns: [
      many(named("ids", "string", "Boards", "Boards", "Tableros", "Tableaux")),
      many(value("titles", "string")),
      many(value("numbers", "int")),
      many(value("urls", "url")),
      COUNT_OUT,
      TOTAL_OUT,
      UNAVAILABLE,
    ],
    requires: { all_of: ["workspace", "account"] },
  },

  async run(caller: Caller, params: URLSearchParams) {
    const where = await connected(caller);
    if ("unavailable" in where) return where;
    const { token, workspace } = where;

    const answer = await graphql<{
      repositoryOwner: {
        projectsV2: Connection<{ id?: string; title?: string; number?: number; url?: string }>;
      } | null;
    }>(
      token,
      `query Boards($login: String!, $first: Int!) {
         repositoryOwner(login: $login) {
           ... on Organization { projectsV2(first: $first) { totalCount nodes { id title number url } } }
           ... on User { projectsV2(first: $first) { totalCount nodes { id title number url } } }
         }
       }`,
      { login: workspace.owner, first: PAGE }
    );
    if (empty(answer)) return answer;
    if (!answer.body.repositoryOwner) return NOT_FOUND;

    const boards = rows(answer.body.repositoryOwner.projectsV2).filter(
      (board): board is { id: string; title?: string; number?: number; url?: string } =>
        typeof board.id === "string"
    );

    return {
      ids: boards.map((board) => board.id),
      titles: boards.map((board) => board.title ?? ""),
      numbers: boards.map((board) => board.number ?? 0),
      urls: boards.map((board) => board.url ?? ""),
      count: boards.length,
      total: answer.body.repositoryOwner.projectsV2.totalCount ?? boards.length,
    };
  },
};

/**
 * Which single-select fields a board has.
 *
 * Added for the value sources, and it earns its place: "Move a project card"
 * asks for a field id and then for one of that field's values, and neither had
 * anywhere to come from — `list-project-options` already answered the VALUES,
 * but only once you knew which field, which meant typing a field name from
 * memory to find out what the fields were called.
 *
 * Two parallel lists, ids beside names, because a Projects v2 field id is an
 * opaque node id and a menu of those is unreadable.
 */
export const listProjectFields: Read = {
  declaration: {
    id: READ_IDS.listProjectFields,
    direction: "read",
    label: text("Project fields", "Projektfelder", "Campos de proyecto", "Champs de projet"),
    description: text(
      "The single-select fields one board has — its columns, and anything else set that way.",
      "Die Einfachauswahl-Felder eines Boards — seine Spalten und alles andere dieser Art.",
      "Los campos de selección única de un tablero: sus columnas y cualquier otro similar.",
      "Les champs à choix unique d'un tableau — ses colonnes, et tout autre du même type."
    ),
    group: "projects",
    actors: ["member", "installation"],
    visibility: "member",
    cache_ttl_seconds: 300,

    params: [PROJECT_ID],
    returns: [
      many(named("ids", "string", "Fields", "Felder", "Campos", "Champs")),
      many(named("names", "string", "Field names", "Feldnamen", "Nombres de campos", "Noms des champs")),
      COUNT_OUT,
      UNAVAILABLE,
    ],
    requires: { all_of: ["workspace", "account"] },
  },

  async run(caller: Caller, params: URLSearchParams) {
    const found = await singleSelectFields(caller, params);
    if ("unavailable" in found) return found;
    return {
      ids: found.fields.map((field) => field.id),
      names: found.fields.map((field) => field.name ?? ""),
      count: found.fields.length,
    };
  },
};

/**
 * One board's single-select fields, or why there are none to give.
 *
 * Shared by the two reads above and below rather than duplicated, because they
 * ask the same question of GitHub and apply the same containment: a node id
 * names a board outright, so without the owner check either read would reach
 * any board the member is on, which is not the same set as what this install
 * is about.
 */
async function singleSelectFields(
  caller: Caller,
  params: URLSearchParams
): Promise<
  | { fields: Array<{ id: string; name?: string; options?: Array<{ id?: string; name?: string }> }> }
  | { unavailable: string }
> {
  const where = await connected(caller);
  if ("unavailable" in where) return where;
  const { token, workspace } = where;

  const projectId = readText(params, "project_id");
  if (!projectId) return { unavailable: "project-required" };

  const answer = await graphql<{
    node: {
      owner?: { login?: string } | null;
      fields: Connection<{
        id?: string;
        name?: string;
        options?: Array<{ id?: string; name?: string }>;
      }>;
    } | null;
  }>(
    token,
    `query Fields($project: ID!, $first: Int!) {
       node(id: $project) {
         ... on ProjectV2 {
           owner {
             ... on Organization { login }
             ... on User { login }
           }
           fields(first: $first) {
             nodes { ... on ProjectV2SingleSelectField { id name options { id name } } }
           }
         }
       }
     }`,
    { project: projectId, first: PAGE }
  );
  if (empty(answer)) return answer;

  const board = answer.body.node;
  if (!board) return { unavailable: "no-such-project" };

  const owner = board.owner?.login;
  if (typeof owner !== "string" || owner.toLowerCase() !== workspace.owner.toLowerCase()) {
    return { unavailable: "project-not-listed" };
  }

  return {
    fields: rows(board.fields).filter(
      (candidate): candidate is { id: string; name?: string; options?: Array<{ id?: string; name?: string }> } =>
        typeof candidate.id === "string"
    ),
  };
}

export const listProjectOptions: Read = {
  declaration: {
    id: READ_IDS.listProjectOptions,
    direction: "read",
    label: text(
      "Project field values",
      "Werte eines Projektfelds",
      "Valores de un campo de proyecto",
      "Valeurs d'un champ de projet"
    ),
    description: text(
      "What one single-select field on a board can be set to.",
      "Worauf ein Einfachauswahl-Feld eines Boards gesetzt werden kann.",
      "A qué se puede establecer un campo de selección única de un tablero.",
      "Ce à quoi un champ à choix unique d'un tableau peut être défini."
    ),
    group: "projects",
    actors: ["member", "installation"],
    visibility: "member",
    cache_ttl_seconds: 300,

    params: [PROJECT_ID, param("field", "string", "Field", "Feld", "Campo", "Champ")],
    returns: [
      value("field_id", "string"),
      value("field_name", "string"),
      many(named("option_ids", "string", "Values", "Werte", "Valores", "Valeurs")),
      many(named("option_names", "string", "Value names", "Wertnamen", "Nombres de valores", "Noms des valeurs")),
      UNAVAILABLE,
    ],
    requires: { all_of: ["workspace", "account"] },
  },

  async run(caller: Caller, params: URLSearchParams) {
    const wanted = readText(params, "field");
    if (!wanted) return { unavailable: "field-required" };

    const found = await singleSelectFields(caller, params);
    if ("unavailable" in found) return found;

    // By id or by name: the picker sends an id, and a stored automation
    // written before there was a picker sends the name somebody typed.
    const field = found.fields.find(
      (candidate) =>
        candidate.id === wanted || (candidate.name ?? "").toLowerCase() === wanted.toLowerCase()
    );
    if (!field) return { unavailable: "no-such-field" };

    const options = (field.options ?? []).filter(
      (option): option is { id: string; name?: string } => typeof option.id === "string"
    );

    return {
      field_id: field.id!,
      field_name: field.name ?? "",
      option_ids: options.map((option) => option.id),
      option_names: options.map((option) => option.name ?? ""),
    };
  },
};

export const findProjectItem: Read = {
  declaration: {
    id: READ_IDS.findProjectItem,
    direction: "read",
    label: text(
      "Find a project card",
      "Projektkarte finden",
      "Encontrar una tarjeta de proyecto",
      "Trouver une carte de projet"
    ),
    description: text(
      "The card an issue or pull request has on a board.",
      "Die Karte, die ein Issue oder Pull Request auf einem Board hat.",
      "La tarjeta que una incidencia o pull request tiene en un tablero.",
      "La carte qu'un ticket ou une pull request a sur un tableau."
    ),
    group: "projects",
    actors: ["member", "installation"],
    visibility: "member",
    cache_ttl_seconds: 0,
    params: [PROJECT_ID, REPO, NUMBER],

    returns: [
      named("item_id", "string", "Card", "Karte", "Tarjeta", "Carte"),
      REPO_OUT,
      OWNER_OUT,
      NUMBER_OUT,
      UNAVAILABLE,
    ],
    requires: { all_of: ["workspace", "account"] },
  },

  async run(caller: Caller, params: URLSearchParams) {
    const where = await access(caller, params);
    if ("unavailable" in where) return where;
    const { token, owner, repo } = where;

    const projectId = readText(params, "project_id");
    if (!projectId) return { unavailable: "project-required" };
    const number = readInt(params, "number");
    if (number === undefined) return { unavailable: "number-required" };

    const cards = `projectItems(first: $first) { nodes { id project { id } } }`;
    const answer = await graphql<{
      repository: {
        issueOrPullRequest: {
          projectItems: Connection<{ id?: string; project?: { id?: string } }>;
        } | null;
      } | null;
    }>(
      token,
      `query Card($owner: String!, $repo: String!, $number: Int!, $first: Int!) {
         repository(owner: $owner, name: $repo) {
           issueOrPullRequest(number: $number) {
             ... on Issue { ${cards} }
             ... on PullRequest { ${cards} }
           }
         }
       }`,
      { owner, repo, number, first: PAGE }
    );
    if (empty(answer)) return answer;

    const subjectNode = answer.body.repository?.issueOrPullRequest;
    if (!subjectNode) return NOT_FOUND;

    const card = rows(subjectNode.projectItems).find(
      (item) => typeof item.id === "string" && item.project?.id === projectId
    );
    if (!card) return { unavailable: "not-on-that-board" };

    return { item_id: card.id!, repository: repo, owner, number };
  },
};

export const moveProjectItem: Write = {
  declaration: {
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

    requires: { all_of: ["account"] },
    // Four node ids, and `list-projects`, `list-project-fields` and
    // `list-project-options` are what a caller resolves each of them from —
    // in that order, each read taking the one above it. This app's job is to
    // answer those; arranging them into a form is the caller's.
    params: [
      PROJECT_ID,
      param("item_id", "string", "Card", "Karte", "Tarjeta", "Carte"),
      param("field_id", "string", "Field", "Feld", "Campo", "Champ"),
      param("option_id", "string", "Value", "Wert", "Valor", "Valeur"),
    ],

    returns: [named("item_id", "string", "Card", "Karte", "Tarjeta", "Carte")],
    // A card is identified by its own node id and nothing else — no repository,
    // no number. Declared even though no emission here is about a card yet:
    // what it costs is one line, and what it buys is that an automation
    // service can name what this write touched at all.
    identity: { kind: "project_card", key: ["item_id"] },
  },

  async run(actor, workspace, params) {
    const projectId = paramText(params, "project_id");
    const itemId = paramText(params, "item_id");
    const fieldId = paramText(params, "field_id");
    const optionId = paramText(params, "option_id");
    if (!projectId || !itemId || !fieldId || !optionId) {
      return fail(400, "project_id, item_id, field_id and option_id are all required");
    }

    const answer = await mutate(
      actor,
      `mutation Move($project: ID!, $item: ID!, $field: ID!, $option: String!) {
         updateProjectV2ItemFieldValue(input: {
           projectId: $project, itemId: $item, fieldId: $field,
           value: { singleSelectOptionId: $option }
         }) { projectV2Item { id } }
       }`,
      { project: projectId, item: itemId, field: fieldId, option: optionId }
    );
    if (failed(answer)) return answer;

    const moved = (answer.updateProjectV2ItemFieldValue as { projectV2Item?: { id?: unknown } })
      ?.projectV2Item;
    return { actor: actor.kind, result: { item_id: moved?.id ?? itemId } };
  },
};
