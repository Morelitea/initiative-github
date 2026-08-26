/**
 * Registering this deployment's own GitHub App, in one click instead of a form.
 *
 * Every deployment needs its own registration — minting an installation token
 * needs the private key, so there is no flow that lets one app be shared
 * between operators who do not trust each other. That constraint is not
 * negotiable. The 22-step form in front of it is.
 *
 * GitHub's **app manifest flow** is the way through: this app posts a filled-in
 * manifest to GitHub, the operator clicks one button, and GitHub hands back an
 * app that already has the right permissions, the right events and the right
 * URLs — because all three came from
 * [`registration.ts`](./registration.ts) rather than from somebody reading a
 * table and typing. It is the same shape Atlantis and Sourcegraph settled on,
 * and for the same reason: the form is where a self-hosted integration loses
 * people, and every field on it is one the code already knows.
 *
 * **Nothing is persisted.** The conversion hands back four secrets and this
 * shows them once, for the operator to put wherever they keep secrets. Writing
 * them to the database instead would be more convenient and would cost the two
 * things `config.ts` promises: that credentials are read once at boot, and that
 * a running deployment's identity cannot be changed by reaching a URL.
 *
 * **Off unless switched on.** `INITIATIVE_APP_SETUP_TOKEN` gates both routes,
 * and without it they do not exist — 404, not 403, because a route that answers
 * differently when a feature is configured tells an unauthenticated caller
 * which deployments are worth returning to. An operator sets it for the length
 * of the setup and removes it, which is the whole life of this file.
 *
 * The gate itself is the kit's ({@link SetupGate}) rather than this app's,
 * because nothing about it is GitHub-shaped: an app with a per-deployment
 * vendor registration needs the same switch and the same signed return leg
 * whether the vendor is GitHub, Shopify or Stripe. What stays here is the part
 * that is GitHub's — the manifest posted, the code exchanged, the credentials
 * shown.
 */

import { SetupGate } from "initiative-app-kit";

import { config } from "../config.js";
import { escapeHtml, pageHtml } from "../page.js";
import { REGISTERED_PATH } from "../routes.js";
import { githubAppManifest } from "./registration.js";

/**
 * The switch, built once from configuration.
 *
 * Holds whatever tokens the operator set — more than one is allowed, so a
 * second operator can be let in or a token replaced without ending a flow
 * already in progress.
 */
const gate = new SetupGate({ tokens: config.setupTokens });

/** Whether the operator has switched this on at all. */
export function setupEnabled(): boolean {
  return gate.enabled;
}

/**
 * Which held token a caller presented, or null.
 *
 * The token comes back rather than a boolean because the state minted for the
 * trip is signed with it: that is what makes removing one token end exactly the
 * flows it opened and no others.
 */
export function authorized(offered: string | null): string | null {
  return gate.authorize(offered);
}

/** Whether this deployment minted that state, under a token it still holds. */
export function verifyState(state: string | null, now: number = Date.now()): boolean {
  return gate.verifyState(state, now);
}

/** Where GitHub takes a manifest, for a personal account or an organization. */
function creationUrl(org: string | null): string {
  if (!org) return `${config.github.webBase}/settings/apps/new`;
  return `${config.github.webBase}/organizations/${encodeURIComponent(org)}/settings/apps/new`;
}

/**
 * The page that posts the manifest to GitHub.
 *
 * A form rather than a redirect, because the manifest travels as a POST body —
 * it is far too big for a query string, and GitHub takes it no other way. It is
 * submitted by a button rather than automatically: the next screen creates a
 * GitHub App under whoever is signed in, and that is not something to do to
 * somebody who followed a link.
 */
export function registerPage(
  org: string | null,
  token: string,
  now: number = Date.now()
): string {
  const manifest = githubAppManifest(config.publicUrl);
  const where = org ? `the ${escapeHtml(org)} organization` : "your personal account";
  return pageHtml(
    "Create this deployment's GitHub App",
    `<p>This creates a GitHub App under <strong>${where}</strong>, already
      carrying the permissions, the webhook events and the URLs this deployment
      needs. You will be brought back here with its credentials.</p>
     <p>Registering under an organization rather than a person is usually right:
      an app owned by a personal account leaves the organization unable to manage
      it. Add <code>?org=YOUR-ORG</code> to this URL to change where it goes.</p>
     <form method="post" action="${escapeHtml(creationUrl(org))}">
       <input type="hidden" name="manifest"
              value="${escapeHtml(JSON.stringify(manifest))}">
       <input type="hidden" name="state" value="${escapeHtml(gate.mintState(token, now))}">
       <button type="submit">Create it on GitHub</button>
     </form>
     <p>It will ask you to confirm the name and the permissions first.</p>`
  );
}

/** What the conversion hands back. */
export interface Credentials {
  clientId: string;
  clientSecret: string;
  /** The PEM, as GitHub returns it. */
  pem: string;
  webhookSecret: string;
  slug: string;
}

/**
 * Exchange the code for the app's credentials.
 *
 * Unauthenticated at GitHub — the code is the authority, it is good for an hour
 * and it is worth every secret this app has. That is why the route that reaches
 * this checks the state first.
 */
export async function convert(code: string): Promise<Credentials | null> {
  const response = await fetch(
    `${config.github.apiBase}/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );
  if (!response.ok) {
    console.error(`could not convert the manifest code: ${response.status}`);
    return null;
  }
  const body = (await response.json()) as {
    client_id?: string;
    client_secret?: string;
    pem?: string;
    webhook_secret?: string;
    slug?: string;
  };
  if (!body.client_id || !body.client_secret || !body.pem) return null;
  return {
    clientId: body.client_id,
    clientSecret: body.client_secret,
    pem: body.pem,
    // A webhook secret is optional on a registration; the manifest this app
    // posts asks GitHub to generate one, so its absence is worth saying rather
    // than papering over with a blank line an operator would paste.
    webhookSecret: body.webhook_secret ?? "",
    slug: body.slug ?? "",
  };
}

/**
 * The credentials, once.
 *
 * Base64 for the key, because that is the shape that survives an environment
 * variable — a PEM's newlines do not — and because the alternative is an
 * operator hand-joining sixty lines and finding out at boot.
 */
export function credentialsPage(credentials: Credentials): string {
  const env = [
    `GITHUB_CLIENT_ID=${credentials.clientId}`,
    `GITHUB_CLIENT_SECRET=${credentials.clientSecret}`,
    `GITHUB_WEBHOOK_SECRET=${credentials.webhookSecret}`,
    `GITHUB_APP_PRIVATE_KEY=${Buffer.from(credentials.pem).toString("base64")}`,
  ].join("\n");

  const installUrl = credentials.slug
    ? `${config.github.webBase}/apps/${credentials.slug}/installations/new`
    : null;

  return pageHtml(
    "Your GitHub App is registered",
    `<p class="warn"><strong>These are shown once and stored nowhere.</strong>
      This deployment did not write them down — copy them now, and GitHub will
      not show the private key again either.</p>
     <pre>${escapeHtml(env)}</pre>
     <p>Put those wherever this deployment reads its environment, restart it,
      and remove <code>INITIATIVE_APP_SETUP_TOKEN</code> — it is needed once and it
      is the only thing guarding this page.</p>
     ${
       installUrl
         ? `<p>Then install the app on the organization whose repositories you
             want to watch: <a href="${escapeHtml(installUrl)}">${escapeHtml(
               installUrl
             )}</a></p>`
         : ""
     }
     <p>Finally, set the repository in this app's settings in Initiative. Either
      order works.</p>`
  );
}
