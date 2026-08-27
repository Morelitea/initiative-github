import type { Caller } from "./index.js";
import type { Read } from "./index.js";
import {
  COUNT_OUT,
  many,
  named,
  OWNER_OUT,
  READ_IDS,
  text,
  UNAVAILABLE,
} from "../vocabulary.js";
import {
  PAGE,
  access,
  connected,
  empty,
  graphql,
} from "../github/api.js";
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
    actors: ["member"],
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
