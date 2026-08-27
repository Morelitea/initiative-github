import type { Endpoint } from "initiative-app-kit";

import { EMIT_ENDPOINTS } from "./emissions.js";
import type { Actor, OperationResult } from "../github/api.js";
import type { StoredWorkspace } from "../workspace.js";
import {
  closeIssue,
  comment,
  findIssues,
  getIssue,
  label,
  listLabels,
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
import { listRepositories } from "./repositories.js";
import { listAlerts } from "./security.js";

export interface Caller {
  guildId: number;
  appInstallId: number;
    connectionRef: string | null;
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
