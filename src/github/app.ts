/**
 * This app's own identity at GitHub, which is what makes it a GitHub App.
 *
 * An OAuth app is a client that borrows people. A GitHub App is a party in its
 * own right: it holds a private key, it is *installed* onto an organization by
 * someone who owns that organization, and everything it reaches it reaches
 * through that installation. That difference is the whole file.
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
 * What that buys over the admin-pasted token this replaced is custody. A
 * personal access token is a *person's* credential wearing the guild's name: it
 * carries everything that person can reach, it outlives their interest in the
 * guild, and revoking it means finding the person who minted it. An
 * installation is the organization's own grant, visible in its settings,
 * scoped to the repositories it picked, and revoked by a button that belongs to
 * the org rather than to anybody's account. The app cannot widen it and cannot
 * survive its removal — the next mint simply fails.
 *
 * So this app now holds one credential of its own, and that is the correct
 * shape rather than a compromise: the thing it identifies is the app, not a
 * person, and it is useless anywhere nobody has invited it.
 */

import { createSign } from "node:crypto";

import { config } from "../config.js";

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
 * Which installation covers this repository, if any.
 *
 * This is what replaces an admin pasting a token. The admin types a repository
 * into Initiative's own settings form — the thing they were always going to
 * type — and the app asks GitHub whether it has been installed there. Nobody
 * hands over a credential, and nobody has to find an installation id.
 *
 * `null` covers three cases the caller treats identically and a person does
 * not: nobody has installed the app on that org, they installed it but did not
 * select this repository, or the repository does not exist. All three mean the
 * same thing here — there is no grant to read this repository with — and the
 * remedy for all three is the same visit to the install page.
 */
export async function installationForRepo(
  owner: string,
  repo: string
): Promise<number | null> {
  const response = await asApp(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    console.error(
      `could not look up the installation for ${owner}/${repo}: ${response.status}`
    );
    return null;
  }
  const body = (await response.json()) as { id?: number };
  return typeof body.id === "number" ? body.id : null;
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

/** Drop one installation's token. For the uninstall delivery. */
export function forgetInstallation(installationId: number): void {
  tokens.delete(installationId);
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
}
