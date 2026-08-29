import type { Caller } from "./index.js";
import type { Read, Write } from "./index.js";
import {
  ASSIGNEES_OUT,
  AUTHOR_OUT,
  CLOSED_OUT,
  COMMENTS_OUT,
  CREATED_OUT,
  DIRECTION_IN,
  ISSUE_IDENTITY,
  LABELS_IN,
  LABELS_OUT,
  LIMIT_IN,
  LINK_OUT,
  MILESTONE_OUT,
  named,
  NUMBER,
  NUMBER_OUT,
  OWNER_OUT,
  param,
  pick,
  READ_IDS,
  REPO,
  REPO_OUT,
  ROWS_OUT,
  several,
  SORT_IN,
  STATE_OUT,
  text,
  TITLE_OUT,
  UNAVAILABLE,
  UPDATED_OUT,
  URL_OUT,
  value,
  WRITE_IDS,
} from "../vocabulary.js";
import type {
  Connection,
  PullNode,
  Row,
} from "../github/api.js";
import {
  LOGIN,
  NOT_FOUND,
  ROW_FIELDS,
  SUBJECT_FIELDS,
  access,
  empty,
  graphql,
  listed,
  orNull,
  ordering,
  readChoice,
  readInt,
  readLimit,
  readNames,
  readText,
  rows,
  states,
  subject,
} from "../github/api.js";
import {
  call,
  fail,
  failed,
  identifiers,
  paramInt,
  paramList,
  where,
} from "../github/api.js";

const PULL_STATES = ["open", "closed", "merged", "all"] as const;

async function reviewRequested(
  token: string,
  owner: string,
  repo: string,
  reviewer: string,
  params: URLSearchParams
): Promise<Record<string, unknown>> {
  if (!LOGIN.test(reviewer)) return { unavailable: "bad-login" };
  if (readNames(params, "labels") || readText(params, "base_ref") || readText(params, "head_ref")) {
    return { unavailable: "unsupported-combination" };
  }

  const state = readChoice(params, "state", PULL_STATES, "open");
  const qualifiers = [`repo:${owner}/${repo}`, "is:pr", `review-requested:${reviewer}`];
  if (state !== "all") qualifiers.push(`is:${state}`);

  const answer = await graphql<{ search: Connection<Row> & { issueCount?: number } }>(
    token,
    `query ReviewRequested($query: String!, $first: Int!) {
       search(query: $query, type: ISSUE, first: $first) {
         issueCount
         nodes { ... on PullRequest { ${ROW_FIELDS} } }
       }
     }`,
    { query: qualifiers.join(" "), first: readLimit(params) }
  );
  if (empty(answer)) return answer;

  return listed(rows(answer.body.search), answer.body.search.issueCount);
}

export const findPullRequests: Read = {
  declaration: {
    id: READ_IDS.findPullRequests,
    direction: "read",
    label: text(
      "Find pull requests",
      "Pull Requests suchen",
      "Buscar pull requests",
      "Rechercher des pull requests"
    ),
    description: text(
      "The pull requests matching a question, including the ones waiting on a review.",
      "Die Pull Requests, die zu einer Frage passen — auch die, die auf eine Review warten.",
      "Las pull requests que coinciden con una consulta, incluidas las que esperan revisión.",
      "Les pull requests correspondant à une question, y compris celles en attente de revue."
    ),
    group: "reviews",
    actors: ["member", "installation"],
    visibility: "member",
    cache_ttl_seconds: 60,

    params: [
      REPO,
      pick(
        "state",
        ["open", "closed", "merged", "all"],
        "State",
        "Status",
        "Estado",
        "État"
      ),
      LABELS_IN,
      param("base_ref", "string", "Into branch", "Nach Branch", "Hacia la rama", "Vers la branche"),
      param("head_ref", "string", "From branch", "Von Branch", "Desde la rama", "Depuis la branche"),

      param(
        "review_requested",
        "string",
        "Waiting on",
        "Wartet auf",
        "Esperando a",
        "En attente de"
      ),
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

    const reviewer = readText(params, "review_requested");
    if (reviewer !== undefined) {
      return reviewRequested(token, owner, repo, reviewer, params);
    }

    const answer = await graphql<{
      repository: { pullRequests: Connection<Row> } | null;
    }>(
      token,
      `query Pulls($owner: String!, $repo: String!, $first: Int!, $states: [PullRequestState!],
                   $labels: [String!], $base: String, $head: String, $order: IssueOrder!) {
         repository(owner: $owner, name: $repo) {
           pullRequests(first: $first, states: $states, labels: $labels,
                        baseRefName: $base, headRefName: $head, orderBy: $order) {
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
        states: states(readChoice(params, "state", PULL_STATES, "open")),
        labels: readNames(params, "labels"),
        base: readText(params, "base_ref") ?? null,
        head: readText(params, "head_ref") ?? null,
      }
    );
    if (empty(answer)) return answer;
    if (!answer.body.repository) return NOT_FOUND;

    const found = rows(answer.body.repository.pullRequests);
    return listed(found, answer.body.repository.pullRequests.totalCount);
  },
};

export const getPullRequest: Read = {
  declaration: {
    id: READ_IDS.getPullRequest,
    direction: "read",
    label: text(
      "Get a pull request",
      "Pull Request abrufen",
      "Obtener una pull request",
      "Récupérer une pull request"
    ),
    description: text(
      "One pull request by number — whether it is a draft, and whether it merged.",
      "Ein Pull Request nach Nummer — ob er ein Entwurf ist und ob er gemergt wurde.",
      "Una pull request por número: si es un borrador y si se fusionó.",
      "Une pull request par numéro — si c'est un brouillon, et si elle a été fusionnée."
    ),
    group: "reviews",
    actors: ["member", "installation"],
    visibility: "member",
    cache_ttl_seconds: 0,
    params: [REPO, NUMBER],

    returns: [
      REPO_OUT,
      OWNER_OUT,
      NUMBER_OUT,
      TITLE_OUT,

      STATE_OUT,
      value("merged", "bool"),
      value("draft", "bool"),
      URL_OUT,
      AUTHOR_OUT,
      LABELS_OUT,
      ASSIGNEES_OUT,
      MILESTONE_OUT,
      COMMENTS_OUT,
      named("head_ref", "string", "From branch", "Von Branch", "Desde la rama", "Depuis la branche"),
      named("base_ref", "string", "Into branch", "Nach Branch", "Hacia la rama", "Vers la branche"),
      value("commits", "int"),
      value("changed_files", "int"),
      CREATED_OUT,
      UPDATED_OUT,
      CLOSED_OUT,
      value("merged_at", "string"),
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
      repository: { pullRequest: PullNode | null } | null;
    }>(
      token,
      `query Pull($owner: String!, $repo: String!, $number: Int!) {
         repository(owner: $owner, name: $repo) {
           pullRequest(number: $number) {
             ${SUBJECT_FIELDS}
             isDraft
             merged
             mergedAt
             headRefName
             baseRefName
             changedFiles
             commits { totalCount }
           }
         }
       }`,
      { owner, repo, number }
    );
    if (empty(answer)) return answer;

    const node = answer.body.repository?.pullRequest;
    if (!node) return NOT_FOUND;

    return {
      ...subject(node, owner, repo),

      merged: Boolean(node.merged),
      draft: Boolean(node.isDraft),
      head_ref: orNull(node.headRefName),
      base_ref: orNull(node.baseRefName),
      commits: node.commits?.totalCount ?? 0,
      changed_files: node.changedFiles ?? 0,
      merged_at: orNull(node.mergedAt),
    };
  },
};

export const requestReview: Write = {
  declaration: {
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
      several(param("reviewers", "string", "Reviewers", "Reviewer", "Revisores", "Relecteurs")),
      several(
        param("team_reviewers", "string", "Team reviewers", "Team-Reviewer", "Equipos revisores", "Équipes relectrices")
      ),
    ],
    // A pull request is an issue to GitHub's own API, and to this identity for
    // the same reason: a flow watching "a review was requested" is watching the
    // same numbered thing the write touched.
    returns: [REPO_OUT, NUMBER_OUT, LINK_OUT],
    identity: ISSUE_IDENTITY,
  },

  async run(actor, workspace, params) {
    const place = await where(workspace, params);
    if (failed(place)) return place;

    const number = paramInt(params, "number");
    if (number === undefined) return fail(400, "number is required");
    const reviewers = paramList(params, "reviewers");
    const teams = paramList(params, "team_reviewers");
    if (!reviewers.length && !teams.length) {
      return fail(400, "name a reviewer or a team");
    }

    const answer = await call(
      actor,
      "POST",
      `/repos/${place.owner}/${place.repo}/pulls/${number}/requested_reviewers`,
      {
        ...(reviewers.length ? { reviewers } : {}),
        ...(teams.length ? { team_reviewers: teams } : {}),
      }
    );
    if (failed(answer)) return answer;
    return {
      actor: actor.kind,
      result: {
        repository: place.repo,
        number,
        ...identifiers(answer, ["html_url"]),
      },
    };
  },
};
