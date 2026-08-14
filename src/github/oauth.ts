/**
 * The member's own GitHub account, connected by the member.
 *
 * The shape worth copying is what this app learns and what it does not. The
 * platform sends a member here with a `connection_ref` — an opaque handle it
 * minted per (install, connection, member). That handle is the *only* name this
 * app ever has for that person: no user id, no email, no display name. The same
 * person looks unrelated across apps, and across guilds within this one.
 *
 * So the table is keyed by the handle. When Initiative later calls a data
 * source or an action on that member's behalf, the context token carries the
 * same handle in `connection_refs`, and this app looks up the credential
 * without ever learning whose it is.
 *
 * Two things are in Postgres rather than in memory, and the second is the one
 * that bites first: the credential, because a restart must not disconnect
 * everybody; and the in-flight OAuth state, because the browser leaves from one
 * replica and comes back to whichever the load balancer picks.
 */

import { randomUUID } from "node:crypto";

import { config } from "../config.js";
import { pool } from "../db.js";
import { open, seal } from "../secrets.js";

export interface StoredAccount {
  accessToken: string;
  /** What the member connected as, for display in their settings. */
  accountLabel: string | null;
}

const STATE_TTL_MINUTES = 10;

/** Where to send the member so GitHub can authorize them. */
export async function beginOAuth(connectionRef: string): Promise<string> {
  const state = randomUUID();
  await pool.query(
    `INSERT INTO oauth_states (state, connection_ref, expires_at)
     VALUES ($1, $2, now() + ($3 || ' minutes')::interval)`,
    [state, connectionRef, String(STATE_TTL_MINUTES)]
  );
  // Swept here rather than by a job: the table is small, and a sweep that runs
  // when somebody connects cannot fall behind in a way that matters.
  await pool.query("DELETE FROM oauth_states WHERE expires_at < now()");

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.github.clientId);
  url.searchParams.set("redirect_uri", `${config.publicUrl}/connect/github/callback`);
  // The same list the manifest's access_hint advertises, so an admin sees at
  // install what will actually be asked for. `repo` is here because the
  // create-issue action writes; an app that only read would ask for less.
  url.searchParams.set("scope", "read:user repo");
  url.searchParams.set("state", state);
  return url.toString();
}

/** Exchange the code, store the credential under its handle, and say so. */
export async function completeOAuth(params: URLSearchParams): Promise<string> {
  const state = params.get("state") ?? "";
  const code = params.get("code") ?? "";

  // Claimed in one statement, so a replayed callback finds nothing rather than
  // racing a second exchange of the same code.
  const claimed = await pool.query<{ connection_ref: string }>(
    `DELETE FROM oauth_states
      WHERE state = $1 AND expires_at > now()
      RETURNING connection_ref`,
    [state]
  );
  const connectionRef = claimed.rows[0]?.connection_ref;

  if (!connectionRef || !code) {
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
    headers: {
      Authorization: `Bearer ${body.access_token}`,
      Accept: "application/vnd.github+json",
    },
  });
  const user = (await who.json()) as { login?: string };

  await pool.query(
    `INSERT INTO connections (connection_ref, access_token, account_label)
     VALUES ($1, $2, $3)
     ON CONFLICT (connection_ref) DO UPDATE
        SET access_token = EXCLUDED.access_token,
            account_label = EXCLUDED.account_label,
            updated_at = now()`,
    [connectionRef, seal(body.access_token), user.login ? `@${user.login}` : null]
  );

  // A real deployment also reports the result back to Initiative on the app
  // channel, so the member's settings page stops saying "waiting to finish".
  // That call is signed with `signedHeaders` from the kit.
  return page("Connected", "You can close this tab and go back to Initiative.");
}

/** The credential behind a handle, or null if that member has not connected. */
export async function credentialFor(
  connectionRef: string | undefined
): Promise<StoredAccount | null> {
  if (!connectionRef) return null;
  const found = await pool.query<{ access_token: string; account_label: string | null }>(
    "SELECT access_token, account_label FROM connections WHERE connection_ref = $1",
    [connectionRef]
  );
  const row = found.rows[0];
  if (!row) return null;

  const accessToken = open(row.access_token);
  // A value that will not open is a credential that is no longer usable —
  // after a key rotation, say — so it reads as "not connected" and the member
  // is asked to connect again rather than the call failing obscurely.
  if (!accessToken) return null;

  return { accessToken, accountLabel: row.account_label };
}

/** Forget a member's credential. For the platform's revocation signal. */
export async function forgetConnection(connectionRef: string): Promise<void> {
  await pool.query("DELETE FROM connections WHERE connection_ref = $1", [connectionRef]);
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:4rem auto;max-width:34rem;padding:0 1rem}</style>
</head><body><h1>${title}</h1><p>${body}</p></body></html>`;
}
