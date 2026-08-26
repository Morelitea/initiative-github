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
 * Fill the form from the summary this prints, following
 * https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app
 */

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

const permissions = Object.entries(manifest.default_permissions)
  .map(([name, level]) => `${name}: ${level}`)
  .join(", ");

process.stdout.write(
  [
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
