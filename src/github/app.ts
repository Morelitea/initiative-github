import { createSign } from "node:crypto";

import { fetchJson } from "initiative-app-kit";

import { config } from "../config.js";
import { SUBSCRIBED_EVENTS } from "../endpoints/emissions.js";
import {
  CALLBACK_PATH,
  SETUP_PATH,
  VERIFY_PATH,
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

/**
 * Whether the installation a guild is bound to is still there.
 *
 * A union rather than a boolean because the caller writes the answer down, and
 * "GitHub says this installation is gone" has to be told apart from "GitHub did
 * not answer". The first stops deliveries; the second must change nothing.
 *
 * By id, and only by id. A login is a name pointing at an installation today:
 * an organization that renames itself keeps its installation and loses its
 * name, and a name freed up and taken by somebody else would read as this
 * guild's install having moved to an account it never agreed to.
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

/**
 * A credential that acts as this app inside one installation.
 *
 * Minted from the private key and nothing else — a JWT this app signs as
 * itself, spent for a token the organization's own grant bounds. There is no
 * authorization step, no code, no redirect and no secret shared with anybody:
 * an owner granted this at GitHub, and that grant is the whole of the
 * authority. It is the one credential in this app that Initiative neither
 * holds, mediates, nor could revoke.
 *
 * What it may reach is what the organization ticked and no more, and it lapses
 * in an hour. Kept in memory until just before it does, because minting one per
 * call would spend a request on every tile.
 */
interface Minted {
  token: string;
  lapsesAt: number;
}

const minted = new Map<number, Minted>();

/** Renew this far ahead of expiry, so a token never lapses mid-call. */
const TOKEN_SKEW_MS = 60_000;

export async function installationToken(installationId: number): Promise<string | null> {
  const held = minted.get(installationId);
  if (held && held.lapsesAt > Date.now() + TOKEN_SKEW_MS) return held.token;

  const answer = await fetchJson<{ token?: unknown; expires_at?: unknown }>(
    `${config.github.apiBase}/app/installations/${installationId}/access_tokens`,
    { method: "POST", headers: appHeaders() }
  );

  if (!answer.ok) {
    console.error(
      `could not mint a token for installation ${installationId}: ${answer.detail}`
    );
    minted.delete(installationId);
    return null;
  }

  const token = answer.body.token;
  if (typeof token !== "string" || !token) return null;

  const lapsesAt =
    typeof answer.body.expires_at === "string"
      ? Date.parse(answer.body.expires_at)
      : Number.NaN;

  minted.set(installationId, {
    token,
    // An hour is what GitHub gives; an unparseable expiry is treated as the
    // shortest thing it could have been rather than as forever.
    lapsesAt: Number.isFinite(lapsesAt) ? lapsesAt : Date.now() + TOKEN_SKEW_MS,
  });
  return token;
}

/** Stop holding a token for an installation that is gone. */
export function forgetInstallationToken(installationId: number): void {
  minted.delete(installationId);
}

/**
 * Every repository one installation covers, as GitHub has it now.
 *
 * The boundary, asked of the party that set it. An organization granting all
 * of its repositories and one ticking four are the same question here — the
 * route answers both, which is why nothing in this app has to guess at what
 * `repository_selection: "all"` covers or wait for a webhook to be told.
 *
 * `null` is "GitHub would not say", which is never written down as an empty
 * boundary: a bad minute at GitHub would otherwise narrow a guild to nothing.
 */
export async function installationRepositories(
  installationId: number
): Promise<string[] | null> {
  const token = await installationToken(installationId);
  if (!token) return null;

  const names: string[] = [];
  for (let page = 1; page <= REPOSITORY_PAGES; page += 1) {
    const answer = await fetchJson<{ repositories?: unknown }>(
      `${config.github.apiBase}/installation/repositories?per_page=${PER_PAGE}&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );

    if (!answer.ok) {
      console.error(
        `could not read what installation ${installationId} covers: ${answer.detail}`
      );
      return null;
    }

    const listed = answer.body.repositories;
    if (!Array.isArray(listed)) return null;

    for (const entry of listed) {
      const name = (entry as { name?: unknown } | null)?.name;
      if (typeof name === "string" && name) names.push(name);
    }

    if (listed.length < PER_PAGE) break;
  }

  return names;
}

const PER_PAGE = 100;

/**
 * How far this will page.
 *
 * An install covering more than this many repositories is one whose boundary
 * is better described as "the account", and walking it on every sync would
 * spend more requests than the answer is worth.
 */
const REPOSITORY_PAGES = 5;

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
  /**
   * Where GitHub sends the temporary code after somebody creates the app.
   *
   * Only for the manifest flow, and absent otherwise: it is not an address
   * this app serves in production. The registration script runs a listener on
   * localhost for the length of one registration and names it here.
   */
  redirect_url?: string;
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
    redirectUrl?: string;
  } = {}
): GithubAppManifest {
  const base = stripTrailingSlashes(publicUrl);
  return {
    name: options.name ?? "Initiative for GitHub",

    ...(options.redirectUrl ? { redirect_url: options.redirectUrl } : {}),

    url: options.homepage ?? HOMEPAGE,
    hook_attributes: { url: `${base}${WEBHOOK_PATH}`, active: true },

    // Two, one per question. A member signing in comes back to the first; an
    // installer proving the installation they claimed is theirs comes back to
    // the second. GitHub matches whichever `redirect_uri` the request names
    // against this list, so neither route ever sees the other's traffic.
    callback_urls: [`${base}${CALLBACK_PATH}`, `${base}${VERIFY_PATH}`],
    setup_url: `${base}${SETUP_PATH}`,
    description:
      options.description ??
      "Brings a repository's issues, reviews and dependency alerts into " +
        "Initiative as dashboard widgets.",

    public: options.public ?? true,
    default_events: [...WEBHOOK_EVENTS],
    default_permissions: { ...PERMISSIONS },
    // Off, so GitHub keeps the two returns apart on its own. An installation
    // comes back to the setup URL and a person authorizing comes back to the
    // callback, which is what each is for — with this on, an install arrives
    // at the callback carrying a code, and the app is left re-deriving from a
    // parameter which of the two it started.
    request_oauth_on_install: false,
    // A repository added or removed at GitHub arrives as an
    // `installation_repositories` delivery, which every app receives whether
    // or not it subscribes. Sending the person here as well would be a second
    // telling of the same thing, on a trip that carries no state to bind.
    setup_on_update: false,
  };
}
