import { createSign } from "node:crypto";

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

async function asApp(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${config.github.apiBase}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${appJwt()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
}

export interface AppIdentity {
    slug: string;
  name: string;
}

let identity: AppIdentity | null = null;

export async function appIdentity(): Promise<AppIdentity | null> {
  if (identity) return identity;
  const response = await asApp("/app");
  if (!response.ok) {
    console.error(`GitHub would not identify this app: ${response.status}`);
    return null;
  }
  const body = (await response.json()) as { slug?: string; name?: string };
  if (!body.slug) return null;
  identity = { slug: body.slug, name: body.name ?? body.slug };
  return identity;
}

export async function installUrl(): Promise<string | null> {
  const app = await appIdentity();
  if (!app) return null;
  return `${config.github.webBase}/apps/${app.slug}/installations/new`;
}

export async function installationForOwner(owner: string): Promise<number | null> {
  const name = encodeURIComponent(owner);
  for (const path of [`/orgs/${name}/installation`, `/users/${name}/installation`]) {
    const response = await asApp(path);
    if (response.status === 404) continue;
    if (!response.ok) {
      console.error(`could not look up the installation for ${owner}: ${response.status}`);
      return null;
    }
    const body = (await response.json()) as { id?: number };
    if (typeof body.id === "number") return body.id;
  }
  return null;
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
