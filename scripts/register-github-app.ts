/**
 * Register this app at GitHub without filling in a form.
 *
 * The registration has always been generated — `githubAppManifest` builds the
 * exact document GitHub asks for, from the same constants the code runs on —
 * and then the operator was told to retype it into a web form and copy four
 * secrets back out. Every value on that form is one that can silently stop
 * matching the code, which is what `test/github-app.test.ts` exists to catch,
 * and a callback URL typed one character wrong is a redirect mismatch nobody
 * sees until somebody tries to connect.
 *
 * GitHub takes the document directly. You POST it, somebody clicks *Create*,
 * and the temporary code that comes back converts into the app's id, its
 * client id and secret, its webhook secret and its private key — all four
 * things this app needs, none of them typed.
 *
 * So this serves one page, waits for one redirect, and prints the block that
 * goes in `.env`. It listens on localhost because that is where the code comes
 * back, and it stops as soon as it has one.
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

import { githubAppManifest } from "../src/github/app.js";

const publicUrl = process.env.APP_PUBLIC_URL;
if (!publicUrl) {
  process.stderr.write(
    "APP_PUBLIC_URL is required — every URL on the registration is built from it.\n" +
      "It is the address GitHub reaches this app at, over HTTPS.\n"
  );
  process.exit(1);
}

/** Where GitHub is asked to send the code back. Localhost, for one minute's work. */
const PORT = Number(process.env.REGISTER_PORT ?? 8721);
const REDIRECT = `http://localhost:${PORT}/registered`;

/** An organization's form, or your own account's. */
const org = process.env.GITHUB_APP_ORG;
const formUrl = org
  ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`
  : "https://github.com/settings/apps/new";

const manifest = githubAppManifest(publicUrl, {
  name: process.env.GITHUB_APP_NAME,
  homepage: process.env.GITHUB_APP_HOMEPAGE,
  redirectUrl: REDIRECT,
});

// Ours, and checked when the code comes back: this listener is on localhost and
// anything on this machine could hit it.
const state = randomUUID();

function escape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

/**
 * A form that posts itself.
 *
 * The manifest travels as a form field rather than a query parameter because
 * it is a JSON document, and GitHub reads it from the body.
 */
const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Registering at GitHub</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:4rem auto;max-width:40rem;padding:0 1rem}</style>
</head><body>
<h1>Registering at GitHub</h1>
<p>Sending this app's registration to GitHub. Review it there and press
<b>Create GitHub App</b> — every field is filled in already.</p>
<form id="go" method="post" action="${escape(formUrl)}?state=${escape(state)}">
  <input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}">
  <noscript><button type="submit">Continue to GitHub</button></noscript>
</form>
<script>document.getElementById("go").submit();</script>
</body></html>`;

function say(lines: string[]): void {
  process.stdout.write(`${lines.join("\n")}\n`);
}

interface Registered {
  id?: number;
  slug?: string;
  html_url?: string;
  client_id?: string;
  client_secret?: string;
  webhook_secret?: string;
  pem?: string;
}

async function convert(code: string): Promise<Registered | null> {
  const answer = await fetch(
    `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    }
  );

  if (!answer.ok) {
    process.stderr.write(
      `GitHub would not convert the registration: ${answer.status} ${await answer.text()}\n`
    );
    return null;
  }
  return (await answer.json()) as Registered;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(page);
  }

  if (url.pathname !== "/registered") {
    res.writeHead(404).end();
    return;
  }

  const code = url.searchParams.get("code");
  if (url.searchParams.get("state") !== state || !code) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("That did not come from the registration this command started.\n");
    return;
  }

  const app = await convert(code);
  if (!app?.pem || !app.client_id || !app.client_secret || !app.webhook_secret) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("GitHub did not return the credentials. Nothing was written.\n");
    server.close();
    process.exitCode = 1;
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>Registered</title>` +
      `<body style="font:16px/1.5 system-ui,sans-serif;margin:4rem auto;max-width:40rem;padding:0 1rem">` +
      `<h1>Registered</h1><p><b>${escape(app.slug ?? "")}</b> exists at GitHub. The ` +
      `credentials are in the terminal you ran this from — put them in <code>.env</code>. ` +
      `You can close this tab.</p>`
  );

  say([
    "",
    `Registered: ${app.html_url ?? app.slug ?? "(unnamed)"}`,
    "",
    "Put these in the .env beside your docker-compose.yml. They are secrets, and",
    "GitHub will not show them again:",
    "",
    `GITHUB_CLIENT_ID=${app.client_id}`,
    `GITHUB_CLIENT_SECRET=${app.client_secret}`,
    `GITHUB_WEBHOOK_SECRET=${app.webhook_secret}`,
    // A PEM has newlines and an environment variable is one line, which is why
    // this app reads the key as base64 of the whole file.
    `GITHUB_APP_PRIVATE_KEY=${Buffer.from(app.pem, "utf-8").toString("base64")}`,
    "",
    "Nothing else on the registration needs touching: the callbacks, the setup",
    "URL, the webhook, the permissions and the events were all sent from the",
    "same constants this app runs on.",
    "",
    "Next: start the app, install it in a guild from Initiative, and press",
    "Connect on the GitHub organization.",
    "",
  ]);

  server.close();
});

server.listen(PORT, () => {
  say([
    "",
    `Registering "${manifest.name}" for ${org ? `the ${org} organization` : "your own account"}.`,
    "",
    `  Open:  http://localhost:${PORT}/`,
    "",
    "GitHub will show you the registration with every field already filled in.",
    "Press Create GitHub App, and the credentials appear here.",
    "",
    org ? "" : "  (For an organization, set GITHUB_APP_ORG and run this again.)",
  ].filter((line) => line !== ""));
});
