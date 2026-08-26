import type { ActorKind, Endpoint } from "initiative-app-kit";
import { isDigits } from "initiative-app-kit";

import { config } from "../config.js";
import type { Caller } from "../endpoints/index.js";
import { resolveRepository, workspaceFor, type StoredWorkspace } from "../workspace.js";
import { credentialFor } from "./oauth.js";

const NOT_CONNECTED = { unavailable: "not-connected" } as const;

const NOT_CONFIGURED = { unavailable: "not-configured" } as const;

export const VENDOR_ERROR = { unavailable: "vendor-error" } as const;

export const NOT_FOUND = { unavailable: "not-found" } as const;

export type Unavailable = { unavailable: string };

type Answer<T> = { body: T } | Unavailable;

export function empty<T>(answer: Answer<T>): answer is Unavailable {
  return "unavailable" in answer;
}

export interface Access {
  token: string;
  owner: string;
  repo: string;
}

export interface Connected {
  token: string;
  workspace: StoredWorkspace;
}

export async function connected(caller: Caller): Promise<Connected | Unavailable> {
  const account = await credentialFor(caller.connectionRef ?? undefined);
  if (!account) return NOT_CONNECTED;

  const workspace = await workspaceFor(caller.appInstallId);

  if (!workspace || !workspace.repos.length) return NOT_CONFIGURED;

  return { token: account.accessToken, workspace };
}

export async function access(
  caller: Caller,
  params?: URLSearchParams
): Promise<Access | Unavailable> {
  const where = await connected(caller);
  if ("unavailable" in where) return where;

  const choice = resolveRepository(where.workspace, params?.get("repo"));
  if ("unavailable" in choice) return choice;

  return { token: where.token, owner: choice.owner, repo: choice.repo };
}

export async function graphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>
): Promise<Answer<T>> {
  let response: Response;
  try {
    response = await fetch(`${config.github.apiBase}/graphql`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch {
    return VENDOR_ERROR;
  }
  if (!response.ok) return VENDOR_ERROR;

  let parsed: { data?: T | null };
  try {
    parsed = (await response.json()) as { data?: T | null };
  } catch {
    return VENDOR_ERROR;
  }
  // Errors beside data are not failure: a field the caller cannot see comes back
  // null, often with an error next to it, and the null is the answer.
  if (!parsed.data) return VENDOR_ERROR;
  return { body: parsed.data };
}

export function readText(params: URLSearchParams, key: string): string | undefined {
  const value = params.get(key)?.trim();
  return value ? value : undefined;
}

export function readInt(params: URLSearchParams, key: string): number | undefined {
  const value = readText(params, key);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

export function readChoice<T extends string>(
  params: URLSearchParams,
  key: string,
  allowed: readonly T[],
  fallback: T
): T {
  const value = readText(params, key)?.toLowerCase();
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function readNames(params: URLSearchParams, key: string): string[] | null {
  const value = readText(params, key);
  if (!value) return null;
  const list = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  return list.length ? list : null;
}

export function readSince(params: URLSearchParams): string | undefined {
  const absolute = readText(params, "since");
  if (absolute) return absolute;
  const days = readInt(params, "since_days");
  if (days === undefined || days <= 0) return undefined;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

export const PAGE = 100;
export const DEFAULT_LIMIT = 30;

export function readLimit(params: URLSearchParams): number {
  const wanted = readInt(params, "limit");
  if (wanted === undefined) return DEFAULT_LIMIT;
  return Math.min(Math.max(wanted, 1), PAGE);
}

export interface Connection<T> {
  totalCount?: number;
  nodes?: Array<T | null>;
}

export interface Row {
  number?: number;
  title?: string;
  url?: string;
  state?: string;
  createdAt?: string;
  updatedAt?: string;
  closedAt?: string | null;
}

export interface SubjectNode extends Row {
  __typename?: string;
  stateReason?: string | null;
  author?: { login?: string } | null;
  milestone?: { title?: string } | null;
  comments?: { totalCount?: number };
  labels?: Connection<{ name?: string }>;
  assignees?: Connection<{ login?: string }>;
}

export interface PullNode extends SubjectNode {
  isDraft?: boolean;
  merged?: boolean;
  mergedAt?: string | null;
  headRefName?: string;
  baseRefName?: string;
  changedFiles?: number;
  commits?: { totalCount?: number };
}

export function rows<T>(connection: Connection<T> | undefined | null): T[] {
  return (connection?.nodes ?? []).filter((node): node is T => node !== null);
}

export function orNull(value: string | null | undefined): string | null {
  return typeof value === "string" ? value : null;
}

export function plain(value: string | null | undefined): string | null {
  return typeof value === "string" ? value.toLowerCase() : null;
}

export const ROW_FIELDS = `number title url state createdAt updatedAt closedAt`;

export const SUBJECT_FIELDS = `
  ${ROW_FIELDS}
  author { login }
  milestone { title }
  comments { totalCount }
  labels(first: 50) { nodes { name } }
  assignees(first: 20) { nodes { login } }
`;

export function subject(node: SubjectNode, owner: string, repo: string): Record<string, unknown> {
  return {
    repository: repo,
    owner,
    number: node.number ?? 0,
    title: orNull(node.title),
    state: plain(node.state),
    url: orNull(node.url),
    created_at: orNull(node.createdAt),
    updated_at: orNull(node.updatedAt),
    closed_at: orNull(node.closedAt),
    author: orNull(node.author?.login),
    labels: rows(node.labels)
      .map((label) => label.name)
      .filter((name): name is string => typeof name === "string"),
    assignees: rows(node.assignees)
      .map((person) => person.login)
      .filter((login): login is string => typeof login === "string"),
    milestone: orNull(node.milestone?.title),
    comments: node.comments?.totalCount ?? 0,
  };
}

export function listed(found: Row[], total: number | undefined): Record<string, unknown> {
  return {
    numbers: found.map((row) => row.number ?? 0),
    titles: found.map((row) => row.title ?? ""),
    urls: found.map((row) => row.url ?? ""),
    states: found.map((row) => plain(row.state) ?? ""),
    created_at: found.map((row) => row.createdAt ?? ""),
    updated_at: found.map((row) => row.updatedAt ?? ""),
    closed_at: found.map((row) => row.closedAt ?? ""),
    count: found.length,

    total: total ?? found.length,
  };
}

// The only caller-supplied value in this file that reaches a query as words
// rather than as a typed variable. Checked rather than escaped, so a value that
// could close the qualifier and open a second `repo:` is refused outright.
export const LOGIN = /^(?:@me|[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38})$/;

export const SORTS = ["created", "updated", "comments"] as const;
export const DIRECTIONS = ["desc", "asc"] as const;

const ORDER_FIELDS: Record<(typeof SORTS)[number], string> = {
  created: "CREATED_AT",
  updated: "UPDATED_AT",
  comments: "COMMENTS",
};

export function ordering(params: URLSearchParams): { field: string; direction: string } {
  return {
    field: ORDER_FIELDS[readChoice(params, "sort", SORTS, "created")],
    direction: readChoice(params, "direction", DIRECTIONS, "desc").toUpperCase(),
  };
}

export function states(value: string): string[] | null {
  return value === "all" ? null : [value.toUpperCase()];
}

export interface OperationFailure {
    readonly failure: true;
  status: number;
  error: string;
}

export interface OperationSuccess {
  actor: ActorKind;
  result: Record<string, unknown>;
}

export type OperationResult = OperationSuccess | OperationFailure;

export function fail(status: number, error: string): OperationFailure {
  return { failure: true, status, error };
}

export function failed<T extends object>(
  result: T | OperationFailure
): result is OperationFailure {
  return (result as OperationFailure).failure === true;
}

export interface Actor {
  kind: ActorKind;
  token: string;
}

export async function chooseActor(
  endpoint: Endpoint,
  available: Partial<Record<ActorKind, () => Promise<string | null>>>
): Promise<Actor | OperationFailure> {
  for (const kind of endpoint.actors ?? []) {
    const token = await available[kind]?.();
    if (token) return { kind, token };
  }

  return fail(
    409,
    "this endpoint runs as the member, and no connected GitHub account could " +
      "be resolved for them"
  );
}

export function paramText(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

export function paramInt(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && isDigits(value)) return Number(value);
  return undefined;
}

export function paramList(params: Record<string, unknown>, key: string): string[] {
  const value = params[key];
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export async function call(
  actor: Actor,
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<Record<string, unknown> | OperationFailure> {
  let response: Response;
  try {
    response = await fetch(`${config.github.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${actor.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    return fail(502, `could not reach GitHub: ${(error as Error).message}`);
  }

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const parsed = (await response.json()) as { message?: unknown };
      if (typeof parsed.message === "string") detail = parsed.message;
    } catch {
    }

    return fail(response.status === 404 ? 404 : 502, detail);
  }

  if (response.status === 204) return {};
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function mutate(
  actor: Actor,
  query: string,
  variables: Record<string, unknown>
): Promise<Record<string, unknown> | OperationFailure> {
  const answer = await call(actor, "POST", "/graphql", { query, variables });
  if (failed(answer)) return answer;

  const errors = answer.errors;
  if (Array.isArray(errors) && errors.length) {
    const first = errors[0] as { message?: unknown };
    return fail(
      502,
      typeof first.message === "string" ? first.message : "GraphQL refused the call"
    );
  }
  return (answer.data as Record<string, unknown>) ?? {};
}

export function identifiers(
  body: Record<string, unknown>,
  keys: string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
}

export async function where(
  workspace: StoredWorkspace | null,
  params: Record<string, unknown>
): Promise<{ owner: string; repo: string } | OperationFailure> {
  const choice = await resolveRepository(workspace, paramText(params, "repo") ?? null);
  if ("unavailable" in choice) {
    return fail(409, choice.unavailable);
  }
  return choice;
}
