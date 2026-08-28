import { createSign } from "node:crypto";

import { fetchJson } from "initiative-app-kit";

import { config } from "../config.js";
import { SUBSCRIBED_EVENTS } from "../endpoints/emissions.js";
import {
  CALLBACK_PATH,
  SETUP_PATH,
  WEBHOOK_PATH,
} from "../vocabulary.js";

const JWT_LIFETIME_SECONDS = 540;

const JWT_BACKDATE_SECONDS = 60;

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

export function appJwt(now: number = Date.now()): string {
  const issuedAt = Math.floor(now / 1000) - JWT_BACKDATE_SECONDS;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iat: issuedAt,
      exp: issuedAt + JWT_BACKDATE_SECONDS + JWT_LIFETIME_SECONDS,
      iss: config.github.clientId,
    })
  );
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(config.github.privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

function appHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${appJwt()}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export interface AppIdentity {
    slug: string;
  name: string;
}

let identity: AppIdentity | null = null;

/**
 * The registration this private key belongs to, or `null` if GitHub would not
 * say right now.
 *
 * Answered rather than thrown, because both callers are on a member's redirect:
 * `/install/github` and the install half of the connect flow. A fault here has
 * a sensible ending — the ordinary authorize URL, or a page saying this app is
 * not registered — and an exception thrown out of this reaches neither.
 */
export async function appIdentity(): Promise<AppIdentity | null> {
  if (identity) return identity;
  const answer = await fetchJson<{ slug?: string; name?: string }>(
    `${config.github.apiBase}/app`,
    { headers: appHeaders() }
  );
  if (!answer.ok) {
    console.error(`GitHub would not identify this app: ${answer.detail}`);
    return null;
  }
  const body = answer.body;
  if (!body.slug) return null;
  identity = { slug: body.slug, name: body.name ?? body.slug };
  return identity;
}

export async function installUrl(): Promise<string | null> {
  const app = await appIdentity();
  if (!app) return null;
  return `${config.github.webBase}/apps/${app.slug}/installations/new`;
}

/**
 * What GitHub said about who has this app installed, or that it did not say.
 *
 * The two are not degrees of the same thing, and the whole reason this is a
 * union is that the caller writes the answer down. `installationId: null` is
 * GitHub answering that there is no installation — removed, or never added —
 * and that is a fact worth recording, because an install that has gone has to
 * stop routing deliveries. `known: false` is GitHub not answering, which is not
 * a fact about anything: stored as "none", a bad minute at GitHub turns every
 * guild-scoped widget off until some later sync happens to succeed.
 */
export type InstallationLookup =
  | { known: true; installationId: number | null }
  | { known: false; detail: string };

export async function installationForOwner(owner: string): Promise<InstallationLookup> {
  const name = encodeURIComponent(owner);
  for (const path of [`/orgs/${name}/installation`, `/users/${name}/installation`]) {
    const answer = await fetchJson<{ id?: unknown }>(
      `${config.github.apiBase}${path}`,
      { headers: appHeaders() }
    );

    // Not that kind of account. An answer, and not the one being asked for —
    // so ask about the other kind before concluding anything.
    if (!answer.ok && answer.reason === "http" && answer.status === 404) continue;

    if (!answer.ok) {
      console.error(`could not look up the installation for ${owner}: ${answer.detail}`);
      return { known: false, detail: answer.detail };
    }

    if (typeof answer.body.id === "number") {
      return { known: true, installationId: answer.body.id };
    }
  }

  // Both routes answered, and neither named an installation.
  return { known: true, installationId: null };
}

/**
 * Whether the installation a guild is bound to is still there.
 *
 * The same union as {@link installationForOwner}, and for the same reason: the
 * caller writes the answer down, and "GitHub says this installation is gone"
 * has to be told apart from "GitHub did not answer". The first stops
 * deliveries; the second must change nothing.
 *
 * Asked by id rather than by owner wherever there is an id, because an id is
 * the installation and a login is a name pointing at one. An organization that
 * renames itself keeps its installation and loses its name — by name that
 * reads as an uninstall, and worse, a name freed up and taken by somebody else
 * reads as this guild's install now living somewhere it never agreed to.
 */
export async function installationById(
  installationId: number
): Promise<InstallationLookup> {
  const answer = await fetchJson<{ id?: unknown }>(
    `${config.github.apiBase}/app/installations/${installationId}`,
    { headers: appHeaders() }
  );

  // Removed at GitHub, or never ours. Either way there is no installation
  // behind this id, which is a fact worth recording.
  if (!answer.ok && answer.reason === "http" && answer.status === 404) {
    return { known: true, installationId: null };
  }

  if (!answer.ok) {
    console.error(`could not look up installation ${installationId}: ${answer.detail}`);
    return { known: false, detail: answer.detail };
  }

  return {
    known: true,
    installationId: typeof answer.body.id === "number" ? answer.body.id : null,
  };
}

/** What GitHub says an installation is: whose it is, and how wide. */
export interface InstallationAccount {
  installationId: number;
  owner: string;
  /** `all` or `selected` — which of the account's repositories were granted. */
  selection: string | null;
}

/**
 * Who an installation belongs to, asked of the app's own key.
 *
 * A read and nothing more, which is the only thing the private key is for
 * here: it names the account and never mints a credential inside it. The
 * repositories are a separate question, and deliberately not this one — they
 * are asked of the member's own token, so what gets written down is what a
 * person could see rather than everything the installation could reach.
 *
 * `null` covers both "GitHub would not say" and "there is no such
 * installation", because the caller does the same thing either way: a member
 * is on a redirect, and the ending is a page rather than a decision about what
 * to store.
 */
export async function installationAccount(
  installationId: number
): Promise<InstallationAccount | null> {
  const answer = await fetchJson<{
    account?: { login?: unknown };
    repository_selection?: unknown;
  }>(`${config.github.apiBase}/app/installations/${installationId}`, {
    headers: appHeaders(),
  });

  if (!answer.ok) {
    console.error(`GitHub would not describe installation ${installationId}: ${answer.detail}`);
    return null;
  }

  const login = answer.body.account?.login;
  if (typeof login !== "string" || !login) return null;

  return {
    installationId,
    owner: login,
    selection:
      typeof answer.body.repository_selection === "string"
        ? answer.body.repository_selection
        : null,
  };
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

export const PERMISSIONS: Readonly<Record<string, string>> = {
  issues: "write",
  pull_requests: "write",
  vulnerability_alerts: "read",
  organization_projects: "write",
  metadata: "read",
};

export const WEBHOOK_EVENTS: readonly string[] = SUBSCRIBED_EVENTS;

export const HOMEPAGE = "https://github.com/Morelitea/initiative-github";

export interface GithubAppManifest {
  name: string;
  url: string;
  hook_attributes: { url: string; active: boolean };
  callback_urls: string[];
  setup_url: string;
  description: string;
  public: boolean;
  default_events: string[];
  default_permissions: Record<string, string>;
  request_oauth_on_install: boolean;
  setup_on_update: boolean;
}

export function githubAppManifest(
  publicUrl: string,
  options: {
    name?: string;
    description?: string;
    homepage?: string;
    public?: boolean;
  } = {}
): GithubAppManifest {
  const base = stripTrailingSlashes(publicUrl);
  return {
    name: options.name ?? "Initiative for GitHub",

    url: options.homepage ?? HOMEPAGE,
    hook_attributes: { url: `${base}${WEBHOOK_PATH}`, active: true },

    callback_urls: [`${base}${CALLBACK_PATH}`],
    setup_url: `${base}${SETUP_PATH}`,
    description:
      options.description ??
      "Brings a repository's issues, reviews and dependency alerts into " +
        "Initiative as dashboard widgets.",

    public: options.public ?? true,
    default_events: [...WEBHOOK_EVENTS],
    default_permissions: { ...PERMISSIONS },
    request_oauth_on_install: true,
    setup_on_update: false,
  };
}
