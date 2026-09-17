/**
 * Registering this app at GitHub, from the app itself.
 *
 * The first step of any integration is a form at the vendor with a dozen
 * fields that have to match the code exactly, and four secrets copied back by
 * hand. Every one of those fields is one that can silently stop matching —
 * a callback URL typed wrong is a redirect mismatch nobody sees until somebody
 * tries to connect, and a box left ticked sends an install down the sign-in
 * route.
 *
 * GitHub takes the registration as a document instead. This app already builds
 * that document, out of the same constants it runs on, so the only thing left
 * to establish is whether whoever is asking may create one — which is the setup
 * token, and the kit's to define so an operator learns one name however many
 * integrations they run.
 *
 * The window this opens is real and worth being plain about: for as long as the
 * token is set, somebody holding it can make a GitHub App in the account they
 * are signed into. Set it to register, then take it away.
 */

import { randomUUID } from "node:crypto";

import { fetchJson, permitsSetup, signSetupState, verifySetupState } from "initiative-app-kit";

import { config } from "../config.js";
import { REGISTER_DONE_PATH, REGISTER_PATH } from "../vocabulary.js";
import { githubAppManifest } from "./app.js";

/** What GitHub hands back once somebody presses Create. */
export interface Registered {
  slug: string;
  htmlUrl: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  /** Base64 of the PEM, which is the shape the setting takes. */
  privateKey: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The form GitHub reads the registration out of.
 *
 * A POST, because the manifest is a JSON document and GitHub takes it from the
 * body. It submits itself, so this is one page and one button — the button
 * being GitHub's own *Create GitHub App*, which is the only place anybody
 * should be agreeing to make one.
 */
export function registrationForm(owner: string | null): string | null {
  const state = randomUUID();
  const signature = signSetupState(state);
  if (!signature) return null;

  const manifest = githubAppManifest(config.publicUrl, {
    redirectUrl: `${config.publicUrl}${REGISTER_DONE_PATH}`,
  });

  const action = owner
    ? `${config.github.webBase}/organizations/${encodeURIComponent(owner)}/settings/apps/new`
    : `${config.github.webBase}/settings/apps/new`;

  // The state travels with its signature: this app stores nothing for the
  // round trip, so a restart mid-registration costs nothing, and a state
  // nobody signed cannot be presented at the other end.
  const query = new URLSearchParams({ state: `${state}.${signature}` });

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Register at GitHub</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:4rem auto;max-width:40rem;padding:0 1rem}</style>
</head><body>
<h1>Registering at GitHub</h1>
<p>Sending this app's registration to GitHub. Every field is filled in already —
review it there and press <b>Create GitHub App</b>.</p>
<form id="go" method="post" action="${escapeHtml(action)}?${escapeHtml(query.toString())}">
  <input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
  <noscript><button type="submit">Continue to GitHub</button></noscript>
</form>
<script>document.getElementById("go").submit();</script>
</body></html>`;
}

/** Whether the state GitHub returned is one this app sent. */
export function returnedFromUs(state: string | null): boolean {
  if (!state) return false;
  const cut = state.lastIndexOf(".");
  if (cut <= 0) return false;
  return verifySetupState(state.slice(0, cut), state.slice(cut + 1));
}

/**
 * Turn the one-use code into the four things this app needs.
 *
 * The only call in this file, and it is unauthenticated by design: the code is
 * the authority, it is good for an hour, and it is good exactly once.
 */
export async function convert(code: string): Promise<Registered | null> {
  const answer = await fetchJson<{
    slug?: unknown;
    html_url?: unknown;
    client_id?: unknown;
    client_secret?: unknown;
    webhook_secret?: unknown;
    pem?: unknown;
  }>(`${config.github.apiBase}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!answer.ok) {
    console.error(`GitHub would not convert the registration: ${answer.detail}`);
    return null;
  }

  const { slug, html_url, client_id, client_secret, webhook_secret, pem } = answer.body;
  if (
    typeof client_id !== "string" ||
    typeof client_secret !== "string" ||
    typeof webhook_secret !== "string" ||
    typeof pem !== "string"
  ) {
    console.error("GitHub converted the registration without returning its credentials");
    return null;
  }

  return {
    slug: typeof slug === "string" ? slug : "",
    htmlUrl: typeof html_url === "string" ? html_url : "",
    clientId: client_id,
    clientSecret: client_secret,
    webhookSecret: webhook_secret,
    // A PEM has newlines and a setting is one line.
    privateKey: Buffer.from(pem, "utf-8").toString("base64"),
  };
}

/**
 * Whether this deployment still needs registration and has a setup token.
 *
 * Named rather than inferred from `registrationForm` returning null: that
 * function mints and signs a fresh state, which is a side effect nobody wants
 * from a question about configuration.
 */
export function setupIsOpen(): boolean {
  return !config.github.registered && signSetupState("probe") !== null;
}

/**
 * Asks for the setup token instead of reading it out of the URL.
 *
 * A query string is not a private channel. It is written to the access log of
 * every hop that handles the request, kept in browser history, and offered to
 * the next site in a `Referer` header unless something stops it -- and none of
 * those copies are removed when the token is. A form field travels in the
 * request body, which none of them record.
 *
 * Rendering this page does reveal that setup is pending, where the old route
 * answered 404 to anyone without the token. That is the trade: a fact that is
 * true for the few minutes between deploying and registering, against a secret
 * that is durable and written down in several places. The route answers 404
 * once registration is complete or when no setup token is configured, so a
 * registered app gives nothing away even before the operator removes the
 * token.
 *
 * See T98.
 */
export function setupTokenPrompt(owner: string | null): string {
  const carried = owner
    ? `<input type="hidden" name="org" value="${escapeHtml(owner)}">`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Setup</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:4rem auto;max-width:40rem;padding:0 1rem}
input[type=password]{font:inherit;padding:.5rem;width:100%;box-sizing:border-box}
button{font:inherit;margin-top:1rem;padding:.5rem 1rem}</style>
</head><body>
<h1>Register this app at GitHub</h1>
<p>Paste the setup token this deployment was started with.</p>
<form method="post" action="${REGISTER_PATH}" autocomplete="off">
${carried}<label>Setup token<br><input type="password" name="token" required autofocus></label>
<button type="submit">Continue</button>
</form>
</body></html>`;
}

/** Whether this request may reach any of it. */
export function permitted(offered: unknown): boolean {
  return permitsSetup(offered);
}
