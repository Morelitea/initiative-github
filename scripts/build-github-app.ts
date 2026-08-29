import { githubAppManifest } from "../src/github/app.js";

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
    "`npm run register` does all of this for you — it sends this document to",
    "GitHub, and the credentials come back without anybody typing them. What",
    "follows is the same registration as a form to fill in by hand.",
    "",
    "Register it at:  https://github.com/settings/apps/new",
    "",
    `  GitHub App name       ${manifest.name}`,
    `  Homepage URL          ${manifest.url}`,
    "                        (a link for a reader — not an address this app serves)",
    `  Callback URL          ${manifest.callback_urls[0]}`,
    `  Callback URL (2nd)    ${manifest.callback_urls[1]}`,
    "                        (where an installer proves the installation is theirs)",
    "  Expire user tokens    yes",
    `  Request user auth     ${manifest.request_oauth_on_install ? "yes" : "no  (an install is not a sign-in)"}`,
    `  Setup URL             ${manifest.setup_url}`,
    `  Redirect on update    ${manifest.setup_on_update ? "yes" : "no  (GitHub reports that by webhook)"}`,
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
