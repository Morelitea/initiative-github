import type { ActorKind, Endpoint } from "initiative-app-kit";

import { EMIT_ENDPOINTS } from "./emissions.js";
import type { Actor, Connected, OperationResult, Unavailable } from "../github/api.js";
import type { StoredWorkspace } from "../workspace.js";
import {
  closeIssue,
  comment,
  findIssues,
  getIssue,
  label,
  listLabels,
  listMilestones,
  openIssue,
  reopenIssue,
} from "./issues.js";
import {
  findProjectItem,
  listProjectFields,
  listProjectOptions,
  listProjects,
  moveProjectItem,
} from "./projects.js";
import { findPullRequests, getPullRequest, requestReview } from "./pull-requests.js";
import { listAssignees, listRepositories } from "./repositories.js";
import { WRITE_IDS } from "../vocabulary.js";
import { listAlerts } from "./security.js";

export interface Caller {
  guildId: number;
  appInstallId: number;
    connectionRef: string | null;
  /**
   * Which credentials this call may run on, best first, as the endpoint
   * declared them — narrowed for this particular call where the parameters
   * make it personal.
   *
   * Absent means `["member"]`, which is what a caller constructed by hand in a
   * test gets, and the safe direction: it never quietly acts as the app.
   */
  actors?: readonly ActorKind[];
  /**
   * The credential that answered, resolved once at the top of the call.
   *
   * Every read reaches `connected` and would otherwise resolve again per
   * helper; caching it here also lets the invoker report which of the two
   * actually ran rather than assuming.
   */
  resolved?: Connected | Unavailable;
}

export interface Read {
  declaration: Endpoint;
  run(caller: Caller, params: URLSearchParams): Promise<Record<string, unknown>>;
}

export interface Write {
  declaration: Endpoint;
  run(
    actor: Actor,
    workspace: StoredWorkspace | null,
    params: Record<string, unknown>
  ): Promise<OperationResult>;
}

export const READS: readonly Read[] = [
  listRepositories,
  listLabels,
  listAssignees,
  listMilestones,
  getIssue,
  findIssues,
  getPullRequest,
  findPullRequests,
  listAlerts,
  listProjects,
  listProjectFields,
  listProjectOptions,
  findProjectItem,
];

export const WRITES: readonly Write[] = [
  openIssue,
  comment,
  closeIssue,
  reopenIssue,
  label,
  requestReview,
  moveProjectItem,
];

/**
 * The GitHub permissions each write needs write access on, any one of which is
 * enough.
 *
 * Several are a pair rather than one because GitHub's issues API is also its
 * pull request API: a comment, a close, a reopen and a label all go to
 * `/issues/{number}`, and whether that number is an issue or a pull request
 * decides which permission GitHub checks. This app does not know which without
 * asking, and asking would spend a request to find out something GitHub is
 * about to check anyway — so the pair is the honest requirement, and the one
 * case that is unambiguous in each direction says so. `open-issue` can only
 * ever make an issue, and `request-review` only ever touches `/pulls`.
 */
export const WRITE_NEEDS: Readonly<Record<string, readonly string[]>> = {
  [WRITE_IDS.openIssue]: ["issues"],
  [WRITE_IDS.comment]: ["issues", "pull_requests"],
  [WRITE_IDS.closeIssue]: ["issues", "pull_requests"],
  [WRITE_IDS.reopenIssue]: ["issues", "pull_requests"],
  [WRITE_IDS.label]: ["issues", "pull_requests"],
  [WRITE_IDS.requestReview]: ["pull_requests"],
  // A board is the account's rather than a repository's, and an installation
  // reaches one through either permission depending on where it lives.
  [WRITE_IDS.moveProjectItem]: ["organization_projects", "repository_projects"],
};

export const READ_HANDLERS: Record<string, Read["run"]> = Object.fromEntries(
  READS.map((read) => [read.declaration.id, read.run.bind(read)])
);

// The manifest reads its declarations off this list and the dispatcher reads its
// handlers off the same one, so the two cannot disagree.
export const ENDPOINTS: readonly Endpoint[] = [
  ...READS.map((read) => read.declaration),
  ...WRITES.map((write) => write.declaration),
  ...EMIT_ENDPOINTS,
];

export const WRITE_HANDLERS: Record<string, Write["run"]> = Object.fromEntries(
  WRITES.map((write) => [write.declaration.id, write.run.bind(write)])
);
