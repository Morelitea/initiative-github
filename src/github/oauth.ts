/**
 * The member's own GitHub account, connected by the member.
 *
 * The shape worth copying is what this app learns and what it does not. The
 * platform sends a member here with a `connection_ref` — an opaque handle it
 * minted per (install, connection, member). That handle is the *only* name this
 * app ever has for that person: no user id, no email, no display name. The same
 * person looks unrelated across apps, and across guilds within this one.
 *
 * So the store below is keyed by the handle. When Initiative later calls a data
 * source on that member's behalf, the context token carries the same handle in
 * `connection_refs`, and this app looks up the credential without ever learning
 * whose it is.
 *
 * The store is in-memory here because this is a reference app and a real one
 * has its own database. What a real one must keep is the shape: keyed by
 * handle, holding the vendor's token and nothing about the person.
 */

import { config } from "../config.js";

interface StoredAccount {
  accessToken: string;
  /** What the member connected as, for display in their settings. */
  accountLabel: string;
}

/** connection_ref → the credential it stands for. Never keyed by a person. */
const accounts = new Map<string, StoredAccount>();

/** Pending OAuth states → the handle they belong to. */
const pending = new Map<string, { connectionRef: string; expiresAt: number }>();

const STATE_TTL_MS = 10 * 60 * 1000;

/** Where to send the member so GitHub can authorize them. */
export function beginOAuth(connectionRef: string): string {
  const state = crypto.randomUUID();
  pending.set(state, { connectionRef, expiresAt: Date.now() + STATE_TTL_MS });

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.github.clientId);
  url.searchParams.set("redirect_uri", `${config.publicUrl}/connect/github/callback`);
  // Read-only, and the same list the manifest's access_hint advertises so an
  // admin sees before anyone authorizes what will actually be asked for.
  url.searchParams.set("scope", "read:user repo:status public_repo");
  url.searchParams.set("state", state);
  return url.toString();
}

/** Exchange the code, store the credential under its handle, and say so. */
export async function completeOAuth(params: URLSearchParams): Promise<string> {
  const state = params.get("state") ?? "";
  const code = params.get("code") ?? "";
  const entry = pending.get(state);
  pending.delete(state);

  if (!entry || entry.expiresAt < Date.now() || !code) {
    return page("Could not connect", "That link has expired. Start again from the app's settings.");
  }

  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: config.github.clientId,
      client_secret: config.github.clientSecret,
      code,
      redirect_uri: `${config.publicUrl}/connect/github/callback`,
    }),
  });
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) {
    return page("Could not connect", "GitHub did not return a token. Start again from the app's settings.");
  }

  const who = await fetch(`${config.github.apiBase}/user`, {
    headers: { Authorization: `Bearer ${body.access_token}`, Accept: "application/vnd.github+json" },
  });
  const user = (await who.json()) as { login?: string };

  accounts.set(entry.connectionRef, {
    accessToken: body.access_token,
    accountLabel: user.login ? `@${user.login}` : "connected",
  });

  // A real app also reports the result back to Initiative on the app channel,
  // so the member's settings page stops saying "waiting to finish". That call
  // is signed with `signedHeaders` from the kit.
  return page("Connected", "You can close this tab and go back to Initiative.");
}

/** The credential behind a handle, or null if that member has not connected. */
export function credentialFor(connectionRef: string | undefined): StoredAccount | null {
  if (!connectionRef) return null;
  return accounts.get(connectionRef) ?? null;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:4rem auto;max-width:34rem;padding:0 1rem}</style>
</head><body><h1>${title}</h1><p>${body}</p></body></html>`;
}
