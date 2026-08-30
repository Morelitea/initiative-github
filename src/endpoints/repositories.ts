import type { Caller } from "./index.js";
import type { Read } from "./index.js";
import {
  COUNT_OUT,
  many,
  named,
  OWNER_OUT,
  READ_IDS,
  REPO,
  text,
  TOTAL_OUT,
  UNAVAILABLE,
} from "../vocabulary.js";
import {
  NOT_FOUND,
  PAGE,
  access,
  connected,
  empty,
  graphql,
  rows,
} from "../github/api.js";
import type { Connection } from "../github/api.js";
import {
  call,
  where,
} from "../github/api.js";

export const listRepositories: Read = {
  declaration: {
    id: READ_IDS.listRepositories,
    direction: "read",
    label: text("Repositories", "Repositories", "Repositorios", "Dépôts"),
    description: text(
      "The repositories this install covers that you can see.",
      "Die Repositories dieser Installation, die du sehen kannst.",
      "Los repositorios que cubre esta instalación y que puedes ver.",
      "Les dépôts couverts par cette installation que vous pouvez voir."
    ),
    group: "repositories",
    actors: ["member", "installation"],
    visibility: "member",

    cache_ttl_seconds: 300,

    returns: [
      many(named("names", "string", "Repositories", "Repositories", "Repositorios", "Dépôts")),
      OWNER_OUT,
      COUNT_OUT,
      UNAVAILABLE,
    ],
    requires: { all_of: ["workspace", "account"] },
  },

  async run(caller: Caller, params: URLSearchParams) {
    const where = await connected(caller);
    if ("unavailable" in where) return where;
    const { token, workspace } = where;

    const wanted = workspace.repos.slice(0, PAGE);

    const declared = wanted.map((_, index) => `$n${index}: String!`).join(", ");
    const asked = wanted
      .map((_, index) => `r${index}: repository(owner: $owner, name: $n${index}) { name }`)
      .join("\n         ");

    const answer = await graphql<Record<string, { name?: string } | null>>(
      token,
      `query Repositories($owner: String!, ${declared}) {
           ${asked}
         }`,
      {
        owner: workspace.owner,
        ...Object.fromEntries(wanted.map((name, index) => [`n${index}`, name])),
      }
    );
    if (empty(answer)) return answer;

    const found = wanted
      .map((repo, index) => answer.body[`r${index}`]?.name ?? null)
      .filter((name): name is string => name !== null);

    return { names: found, owner: workspace.owner, count: found.length };
  },
};


export const listAssignees: Read = {
  declaration: {
    id: READ_IDS.listAssignees,
    direction: "read",
    label: text(
      "Who can be assigned",
      "Wer zuständig sein kann",
      "Quién puede ser asignado",
      "Qui peut être assigné"
    ),
    description: text(
      "The people a repository's issues and pull requests can be given to.",
      "Die Personen, denen Issues und Pull Requests eines Repositories zugewiesen werden können.",
      "Las personas a las que se pueden asignar las incidencias y pull requests de un repositorio.",
      "Les personnes à qui les tickets et pull requests d'un dépôt peuvent être confiés."
    ),
    group: "repositories",
    actors: ["member", "installation"],
    visibility: "member",
    cache_ttl_seconds: 300,

    params: [REPO],
    returns: [
      many(named("logins", "string", "People", "Personen", "Personas", "Personnes")),
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

    // GitHub answers assignability and review-eligibility with the same set,
    // so this one read fills `assignees`, `assignee`, `reviewers` and
    // `review_requested` rather than four that would drift apart.
    const answer = await graphql<{
      repository: { assignableUsers: Connection<{ login?: string }> } | null;
    }>(
      token,
      `query Assignees($owner: String!, $repo: String!, $first: Int!) {
         repository(owner: $owner, name: $repo) {
           assignableUsers(first: $first) { totalCount nodes { login } }
         }
       }`,
      { owner, repo, first: PAGE }
    );
    if (empty(answer)) return answer;
    if (!answer.body.repository) return NOT_FOUND;

    const found = rows(answer.body.repository.assignableUsers)
      .map((user) => user.login)
      .filter((login): login is string => typeof login === "string");
    return {
      logins: found,
      count: found.length,
      total: answer.body.repository.assignableUsers.totalCount ?? found.length,
    };
  },
};
