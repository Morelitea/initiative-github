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
