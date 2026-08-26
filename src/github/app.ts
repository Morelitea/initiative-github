/**
 * This app's own identity at GitHub, which is what makes it a GitHub App.
 *
 * The app is a party at GitHub in its own right. It holds a private key, it is
 * *installed* onto an organization by someone who owns that organization, and
 * everything it reaches through that installation is what the organization
 * agreed to.
 *
 * Three credentials, and the ladder between them is the point:
 *
 * 1. **The private key**, from the operator's environment. It never leaves this
 *    process and authorizes nothing by itself — an org that has not installed
 *    this app is completely unreachable with it.
 * 2. **A JWT**, signed with that key, good for ten minutes. It says "I am this
 *    app" and can do exactly two things: list installations, and ask for a
 *    token for one.
 * 3. **An installation token**, good for one hour, carrying only the
 *    permissions the org agreed to on only the repositories it chose.
 *
 * The installation is the organization's own grant: visible in its settings,
 * scoped to the repositories it picked, revoked by a button that belongs to it.
 * This app cannot widen it and cannot survive its removal — the next mint
 * simply fails.
 *
 * **What still runs on it, after the read path stopped.** Widgets and writes
 * run on the caller's own credential now, so the ladder above serves two things
 * and no more: the webhook, which arrives per installation, and listing the
 * repositories an organization granted when a guild named none of its own.
 */

import { createSign } from "node:crypto";

import { config } from "../config.js";
import type { StoredWorkspace } from "./workspace.js";

/** How long an app JWT is asked to live. GitHub's ceiling is ten minutes. */
const JWT_LIFETIME_SECONDS = 540;

/**
 * Backdated on purpose. GitHub refuses a JWT issued in its future, and two
 * machines' clocks disagree by more than nothing — this is the drift allowance
 * GitHub's own documentation asks for.
 */
const JWT_BACKDATE_SECONDS = 60;

/** Refreshed this long before it expires, so a call never races the clock. */
const TOKEN_SKEW_SECONDS = 60;

/** How long an installation's repository list is reused. */
const REPOSITORY_CACHE_SECONDS = 300;

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

/**
 * A JWT saying "I am this app", signed with the operator's private key.
 *
 * RS256, because that is the only algorithm GitHub accepts here. `iss` is the
 * client id: GitHub takes either that or the numeric app id and recommends the
 * client id, which is also the value this app already needs for the member
 * flow — so there is no second identifier to configure or to get wrong.
 */
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

/** A call to GitHub made as the app itself. */
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

// --- who this app is, according to GitHub -----------------------------------

export interface AppIdentity {
  /** The url-safe name GitHub gave the registration, e.g. `initiative-github`. */
  slug: string;
  name: string;
}

let identity: AppIdentity | null = null;

/**
 * What GitHub says this registration is called.
 *
 * Asked rather than configured, and this is the one call that proves the whole
 * ladder works: it is signed with the private key and answered only if GitHub
 * recognizes the signature. An operator who pasted the wrong key finds out from
 * this rather than from a member's connection failing later.
 *
 * Cached for the process. A registration's slug changes only if someone renames
 * the app, which is not a thing that happens between two requests.
 */
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

/**
 * Where an org owner goes to install this app.
 *
 * Derived from the slug rather than configured, so it cannot name a different
 * registration from the one the private key belongs to.
 */
export async function installUrl(): Promise<string | null> {
  const app = await appIdentity();
  if (!app) return null;
  return `${config.github.webBase}/apps/${app.slug}/installations/new`;
}

// --- finding the installation -----------------------------------------------

/**
 * Which installation this account granted, if any.
 *
 * This is what replaces an admin pasting a token. The admin types an owner into
 * Initiative's own settings form — the thing they were always going to type —
 * and the app asks GitHub whether it has been installed there. Nobody hands
 * over a credential, and nobody has to go and find an installation id.
 *
 * Asked of the **account** rather than of one repository, because that is what
 * an installation belongs to: one grant covers every repository the account
 * chose, and asking per repository would mean one call per repository to learn
 * the same id. An account is an organization or a person and GitHub answers
 * those on different routes without saying which it is, so this tries the one
 * that is nearly always right and falls back.
 *
 * `null` means there is no grant here — nobody installed the app on that
 * account, or the account does not exist. Both have the same remedy, which is a
 * visit to the install page.
 */
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

/**
 * Which repositories this installation actually covers.
 *
 * The ceiling on everything a guild can point at, and it is GitHub's answer
 * rather than this app's: an organization that installed the app on two of its
 * forty repositories granted two, and no configuration on the Initiative side
 * can widen that. So this is what a repository named in a dashboard is checked
 * against — not to keep one team out of another's repository, which this app
 * cannot see well enough to judge, but to keep every team inside what the
 * organization agreed to.
 *
 * Read as the installation, not as the app: the app has no view of what it was
 * granted until it holds a token for the grant.
 */
interface CachedRepositories {
  names: string[];
  goodUntil: number;
}

/**
 * What each installation covers, briefly.
 *
 * Re-read every few minutes rather than per request: it is checked on every
 * source call that names a repository, and an organization adding one to the
 * installation is not a thing that needs to be visible within the second. The
 * `installation_repositories` delivery clears it when it does happen.
 */
const repositories = new Map<number, CachedRepositories>();

/** Drop a cached repository list. For the delivery that says it changed. */
export function forgetRepositories(installationId: number): void {
  repositories.delete(installationId);
}

export async function installationRepositories(
  installationId: number,
  now: number = Date.now()
): Promise<string[] | null> {
  const held = repositories.get(installationId);
  if (held && held.goodUntil > now) return held.names;

  const token = await installationToken(installationId);
  if (!token) return null;

  const names: string[] = [];
  // A hundred at a time. An organization with more than a few hundred
  // repositories in one installation is unusual and the page walk is bounded
  // rather than unlimited, so a pathological account cannot hold a request open.
  for (let page = 1; page <= 10; page += 1) {
    const response = await fetch(
      `${config.github.apiBase}/installation/repositories?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );
    if (!response.ok) {
      console.error(
        `could not list installation ${installationId}'s repositories: ${response.status}`
      );
      return null;
    }
    const body = (await response.json()) as {
      repositories?: Array<{ name?: unknown }>;
    };
    const batch = body.repositories ?? [];
    for (const entry of batch) {
      if (typeof entry.name === "string") names.push(entry.name);
    }
    if (batch.length < 100) break;
  }
  repositories.set(installationId, {
    names,
    goodUntil: now + REPOSITORY_CACHE_SECONDS * 1000,
  });
  return names;
}

// --- the guild's access, minted rather than held ----------------------------

interface CachedToken {
  token: string;
  /** Milliseconds since the epoch, already reduced by the skew. */
  goodUntil: number;
}

/**
 * Installation tokens, kept only while they are valid.
 *
 * In memory and nowhere else, deliberately. A token here lives an hour at most
 * and can always be minted again from the private key, so writing one down
 * would add a durable copy of a credential to a database in exchange for
 * nothing. The same reasoning the pasted token was held under, arriving at the
 * same place from the other direction: what makes revocation real is that there
 * is no second copy to keep working.
 */
const tokens = new Map<number, CachedToken>();

/**
 * A token for one installation, minted if the held one is spent.
 *
 * Keyed by GitHub's installation id rather than by Initiative's install id,
 * because that is what the token actually belongs to: two guilds watching two
 * repositories in the same organization share one installation and should share
 * one token rather than mint two identical ones.
 */
export async function installationToken(
  installationId: number,
  now: number = Date.now()
): Promise<string | null> {
  const held = tokens.get(installationId);
  if (held && held.goodUntil > now) return held.token;

  const response = await asApp(`/app/installations/${installationId}/access_tokens`, {
    method: "POST",
  });
  if (!response.ok) {
    // A 404 here is an installation that has gone away since it was recorded —
    // the org uninstalled the app. Dropped rather than retried: the next sync
    // is what notices and reports it, and this call has nothing to offer.
    tokens.delete(installationId);
    console.error(
      `could not mint a token for installation ${installationId}: ${response.status}`
    );
    return null;
  }

  const body = (await response.json()) as { token?: string; expires_at?: string };
  if (!body.token) return null;

  const expiresAt = body.expires_at ? Date.parse(body.expires_at) : NaN;
  tokens.set(installationId, {
    token: body.token,
    goodUntil: Number.isNaN(expiresAt)
      ? now + 30 * 60 * 1000
      : expiresAt - TOKEN_SKEW_SECONDS * 1000,
  });
  return body.token;
}

/**
 * Which repository a call is about, checked against what was actually granted.
 *
 * Lives here rather than beside the sources because both a read and a write
 * need it and they hold different credentials: a source reads with the
 * installation's token, the `create-issue` action writes with a member's. The
 * question "may this install touch that repository?" is the same either way,
 * and it is answered from the organization's grant rather than from anything a
 * caller asserted.
 *
 * Narrowest first: what the caller asked for, then the guild's own list if it
 * names exactly one, then the installation's if *it* covers exactly one.
 * Anything else is ambiguous and says so rather than picking one.
 *
 * This decides *which* repository is asked about and never whether the caller
 * may see it. That is the credential's job, and on the read path the credential
 * is the member's own — so a member who cannot reach the repository this picks
 * gets GitHub's own answer about it, which is that there is no such repository.
 */
export type RepositoryChoice =
  | { owner: string; repo: string }
  | { unavailable: string };

export async function resolveRepository(
  workspace: StoredWorkspace | null,
  wanted?: string | null
): Promise<RepositoryChoice> {
  if (!workspace) return { unavailable: "not-configured" };

  // Which repositories are in play is the guild's own answer where it gave one,
  // and only then the organization's.
  //
  // That order matters more than it looks. Reads run on the caller's own GitHub
  // credential, so asking the installation "what may this app see" answers a
  // question nobody asked on this path — and it costs a token mint and a page
  // walk to do it. A guild that named its repositories needs neither, and gets
  // its dashboard whether or not an organization owner has installed the app
  // yet. Blank still means "everything the organization granted", which is a
  // list only the installation can enumerate.
  let allowed = workspace.repos;
  if (!allowed.length) {
    if (workspace.installationId === null) return { unavailable: "not-installed" };
    const granted = await installationRepositories(workspace.installationId);
    if (!granted) return { unavailable: "not-installed" };
    allowed = granted;
  }
  const asked = wanted?.trim();

  if (asked) {
    const repo = allowed.find((name) => name.toLowerCase() === asked.toLowerCase());
    // Outside the guild's list, or outside what the organization granted. A
    // distinct answer from "not configured", because the remedy is to fix the
    // dashboard or widen the installation rather than to fill in a form.
    if (!repo) return { unavailable: "repository-not-granted" };
    return { owner: workspace.owner, repo };
  }

  if (allowed.length === 1) return { owner: workspace.owner, repo: allowed[0] };

  // Several to choose from and nothing said which. A source cannot be told
  // which initiative is asking — the context token names a guild and an install
  // and nothing finer — so the *dashboard* is what says, through a fixed `repo`
  // on its binding. A dashboard belongs to one initiative, so binding it there
  // is what pins one team to one repository.
  return { unavailable: "repository-required" };
}

/** Drop one installation's token. For the uninstall delivery. */
export function forgetInstallation(installationId: number): void {
  tokens.delete(installationId);
  repositories.delete(installationId);
}

/**
 * Drop every installation not in this list.
 *
 * The reconcile's own sweep, and the reason it is not left to expiry: a guild
 * that uninstalled while this app was down sends no signal, and an hour is a
 * long time to keep answering for one.
 */
export function forgetInstallationsExcept(installationIds: number[]): void {
  const keep = new Set(installationIds);
  for (const id of tokens.keys()) {
    if (!keep.has(id)) tokens.delete(id);
  }
  for (const id of repositories.keys()) {
    if (!keep.has(id)) repositories.delete(id);
  }
}
