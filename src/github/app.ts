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
