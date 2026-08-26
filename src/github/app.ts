/**
 * This app's own identity at GitHub, which is what makes it a GitHub App.
 *
 * The app is a party at GitHub in its own right. It holds a private key, it is
 * *installed* onto an organization by someone who owns that organization, and
 * everything it reaches through that installation is what the organization
 * agreed to.
 *
 * **The private key answers one question and never acts on the answer.** Signed
 * into a ten-minute JWT, it asks GitHub which account installed this app — and
 * that is the whole of what it does. Every call that reaches a repository runs
 * on the credential of the member who asked for it, so this app never holds a
 * token that acts *as* the installation. Whoever holds the key learns which
 * organizations installed the app; they do not thereby get inside one.
 *
 * The installation is the organization's own grant: visible in its settings,
 * revoked by a button that belongs to it. What this app does with the id is
 * match deliveries to guilds and tell an admin whether the install has landed.
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

// --- which repository a call is about ---------------------------------------

/**
 * Which repository a call is about, from the guild's own list.
 *
 * Lives here rather than beside the reads because both directions need it and
 * the question — "which repository does this call mean?" — is the same either
 * way. It is answered from the setting a guild admin filled in, and from
 * nothing else: no lookup, no credential, no call to GitHub.
 *
 * Narrowest first: what the caller asked for, then the guild's list if it names
 * exactly one. Anything else is ambiguous and says so rather than picking one.
 *
 * This decides *which* repository is asked about and never whether the caller
 * may see it. That is the credential's job, and the credential is the member's
 * own — so a member who cannot reach the repository this picks gets GitHub's
 * own answer about it, which is that there is no such repository.
 */
export type RepositoryChoice =
  | { owner: string; repo: string }
  | { unavailable: string };

export function resolveRepository(
  workspace: StoredWorkspace | null,
  wanted?: string | null
): RepositoryChoice {
  if (!workspace || !workspace.repos.length) {
    return { unavailable: "not-configured" };
  }

  const allowed = workspace.repos;
  const asked = wanted?.trim();

  if (asked) {
    const repo = allowed.find((name) => name.toLowerCase() === asked.toLowerCase());
    // Named by a dashboard but outside what the guild listed. A distinct answer
    // from "not configured", because the remedy is to fix the binding or widen
    // the setting rather than to fill in an empty form.
    if (!repo) return { unavailable: "repository-not-listed" };
    return { owner: workspace.owner, repo };
  }

  if (allowed.length === 1) return { owner: workspace.owner, repo: allowed[0] };

  // Several to choose from and nothing said which. An endpoint cannot be told
  // which initiative is asking — the context token names a guild and an install
  // and nothing finer — so the *dashboard* is what says, through a fixed `repo`
  // on its binding. A dashboard belongs to one initiative, so binding it there
  // is what pins one team to one repository.
  return { unavailable: "repository-required" };
}
