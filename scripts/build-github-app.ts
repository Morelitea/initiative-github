/**
 * Build the GitHub App registration this deployment needs.
 *
 * Registering at GitHub is a form, and a form is a copy of the app's
 * requirements that nothing checks. Fill it in by hand and the drift is silent
 * in both directions: a webhook the code handles but nobody subscribed to
 * simply never arrives, and a permission the code stopped using is granted by
 * every organization forever, because narrowing one is not a thing an app can
 * do to an installation that already exists.
 *
 * So the registration is generated from the same constants the code uses, and
 * `test/github-app.test.ts` checks them against what the code actually does.
 *
 * Two ways to use what this writes:
 *
 *   * **The manifest flow.** Post `github-app.json` to
 *     `https://github.com/settings/apps/new` (or the organization's equivalent)
 *     as a `manifest` form field, and GitHub creates the registration with
 *     everything already filled in, then hands back the id, the private key and
 *     the webhook secret.
 *   * **By hand**, from the summary printed below, following
 *     https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app
 *
 * The file is not committed: every value in it is derived from one deployment's
 * public address, so a file on `main` would describe somebody else's.
 */

import { writeFileSync } from "node:fs";

import { githubAppManifest } from "../src/github/registration.js";

const publicUrl = process.env.APP_PUBLIC_URL;
if (!publicUrl) {
  process.stderr.write(
    "APP_PUBLIC_URL is required — every URL on the registration is built from it\n"
  );
  process.exit(1);
}

const manifest = githubAppManifest(publicUrl, {
  name: process.env.GITHUB_APP_NAME,
  homepage: process.env.GITHUB_APP_HOMEPAGE,
});

writeFileSync("github-app.json", `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");

const permissions = Object.entries(manifest.default_permissions)
  .map(([name, level]) => `${name}: ${level}`)
  .join(", ");

process.stdout.write(
  [
    "wrote github-app.json",
    "",
    "One click instead of this form: set GITHUB_APP_SETUP_TOKEN, start the app,",
    "and open  <APP_PUBLIC_URL>/setup/github/register?token=...  — it posts this",
    "manifest to GitHub and shows you the credentials. Otherwise, by hand:",
    "",
    "Register it at:  https://github.com/settings/apps/new",
    "",
    `  GitHub App name       ${manifest.name}`,
    `  Homepage URL          ${manifest.url}`,
    "                        (a link for a reader — not an address this app serves)",
    `  Callback URL          ${manifest.callback_urls[0]}`,
    "  Expire user tokens    yes",
    "  Request user auth     yes  (installing and connecting become one trip)",
    `  Setup URL             ${manifest.setup_url}`,
    `  Webhook URL           ${manifest.hook_attributes.url}`,
    "  Webhook secret        openssl rand -hex 32  → GITHUB_WEBHOOK_SECRET",
    `  Permissions           ${permissions}`,
    `  Subscribe to events   ${manifest.default_events.join(", ")}`,
    `  Where installable     ${manifest.public ? "any account" : "this account only"}`,
    "",
    "Then generate a private key and copy the client id and a client secret into",
    "GITHUB_APP_PRIVATE_KEY, GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.",
    "",
  ].join("\n")
);
