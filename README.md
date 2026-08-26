# initiative-github

Brings a repository's issues, reviews and dependency alerts into
[Initiative](https://github.com/Morelitea/initiative) as dashboard widgets, and
lets an automation act on that repository as the person whose automation it is.

Everything it shows and everything it does runs on **your own GitHub
credential**, so you see exactly what you can see at GitHub and nothing else.

```
ghcr.io/morelitea/initiative-github:latest
```

## What a guild gets

| | |
|---|---|
| **Four widgets** | Open issues · pull requests waiting on your review · Dependabot alerts by severity · a fortnight of opens against closes. |
| **A ready-made dashboard** | A second listing, *GitHub overview*, arranging all four so there is something to look at without assembling it. |
| **Seven writes** | Open an issue, comment, close, reopen, label, request a review, move a Projects v2 card — each performed as the member whose automation asked for it. |
| **Three announcements** | An issue opened, an issue closed, a review requested. |

All fourteen are **endpoints**: one list this app declares, one address they are
called at, and the id says which one you want. A widget filling a tile and an
automation asking the app to act reach the same surface, and what separates them
is who they prove themselves as.

The widgets need nothing but this app. The writes and the announcements exist
for an automation service to use, and a guild without one gets the same
dashboard.

## It is installed twice

By two different people, in two different places, and neither half knows about
the other. Both have to happen; either order works.

| | In Initiative | At GitHub |
|---|---|---|
| **Who** | a guild admin, from the marketplace | somebody who owns the account or organization |
| **Says** | which repositories this guild cares about | which repositories this app may see, and what it may do in them |
| **Undone by** | uninstalling in Initiative | uninstalling at GitHub |

Steps 6 and 7 below are those two halves.

---

# Setting it up

For somebody running Initiative from its own `docker-compose.yml`: two more
containers beside the two already there.

## Before you start

**A hostname for this app, over HTTPS.** Two parties follow it and both have to
arrive: a member's **browser**, which GitHub redirects after they authorize, and
**GitHub's own servers**, which post the webhook.

Initiative's installation checklist already has you put it behind Caddy, Traefik
or nginx. Give this app one more hostname on the same proxy, pointed at port
8080:

```
https://github-app.example.com  →  http://127.0.0.1:8080
```

The examples below use that hostname; substitute yours. It has to match what you
type on the GitHub App form character for character.

## Step 1 — Register the GitHub App

A GitHub App is a party at GitHub in its own right: an identity it signs with,
permissions an organization approves when it installs, and one webhook covering
every organization that ever does. You register one per deployment, because
GitHub matches every URL on it against a live host.

Open **<https://github.com/settings/apps/new>**. For an organization use
`https://github.com/organizations/YOUR-ORG/settings/apps/new` instead.

| Field | Value |
| --- | --- |
| GitHub App name | anything unique — GitHub App names are global |
| Homepage URL | `https://github.com/Morelitea/initiative-github` |
| Callback URL | `https://github-app.example.com/connect/github/callback` |
| Expire user authorization tokens | **checked** |
| Request user authorization (OAuth) during installation | **checked** |
| Setup URL | `https://github-app.example.com/setup/github` |
| Webhook → Active | **checked** |
| Webhook URL | `https://github-app.example.com/webhooks/github` |
| Webhook secret | `openssl rand -hex 32` — keep it |
| Where can this be installed | Any account |

**Repository permissions**: Issues → *Read and write*, Pull requests → *Read and
write*, Dependabot alerts → *Read-only*. **Organization permissions**: Projects →
*Read and write*.

> Two of those have a near neighbour on the same form. Dependabot alerts is
> spelled `vulnerability_alerts` in the API and *Dependabot alerts* on the page.
> And Projects appears twice: take the **organization** one, which covers
> Projects v2 boards — the repository one covers classic project boards.

Under **Subscribe to events**, tick **Issues** and **Pull request**.

Create it, then collect four things from the page that follows:

1. **Client ID** — shown at the top.
2. **Client secret** — *Generate a new client secret*, copy it now.
3. **Private key** — *Generate a private key*. A `.pem` downloads.
4. **Webhook secret** — the value you generated above.

## Step 2 — Generate the shared secrets

```bash
openssl rand -hex 32                          # → GITHUB_APP_SECRET
openssl rand -base64 32                       # → GITHUB_ENCRYPTION_KEY
openssl rand -hex 16                          # → GITHUB_DB_PASSWORD
openssl genrsa 2048 > platform-signing.pem    # Initiative's app-platform key
base64 -w0 your-app.private-key.pem           # → GITHUB_APP_PRIVATE_KEY
```

That last one matters: a PEM has newlines and an environment variable is one
line, so this app reads the key as base64 of the whole file. (A real PEM, or one
with `\n` typed literally, also work.)

Put them in the `.env` beside your `docker-compose.yml`:

```bash
GITHUB_APP_SECRET=REPLACE-with-the-first-openssl-output
GITHUB_ENCRYPTION_KEY=REPLACE-with-the-second-openssl-output
GITHUB_DB_PASSWORD=REPLACE-with-the-third-openssl-output
GITHUB_CLIENT_ID=REPLACE-with-the-client-id-github-showed-you
GITHUB_CLIENT_SECRET=REPLACE-with-the-client-secret-you-generated
GITHUB_APP_PRIVATE_KEY=REPLACE-with-the-base64-of-your-pem
GITHUB_WEBHOOK_SECRET=REPLACE-with-the-webhook-secret-you-generated
GITHUB_APP_PUBLIC_URL=https://github-app.example.com
```

Every `REPLACE-…` is a value only you have. Nothing in this repository ships a
working secret.

## Step 3 — Tell Initiative the app exists

Two files beside your compose. First `app-services.json`:

```json
[
  {
    "public_id": "morelitea.github",
    "base_url": "http://initiative-github:8080",
    "allowed_origins": ["https://github-app.example.com"],
    "secret_env": "GITHUB_APP_SECRET",
    "grants": [],
    "mandatory": false
  }
]
```

`base_url` is how **Initiative's container** reaches the app — a service name on
the compose network. `allowed_origins` is the browser-facing address, and is
worth setting: left empty it defaults to `base_url`, publishing an address no
browser can resolve.

Then the catalog entries, without which the app registers and **no guild can
install it**:

```bash
mkdir -p catalog
curl -L -o catalog/morelitea.github.json \
  https://github.com/Morelitea/initiative-github/releases/latest/download/morelitea.github.json
curl -L -o catalog/morelitea.github-overview.json \
  https://github.com/Morelitea/initiative-github/releases/latest/download/morelitea.github-overview.json
```

Now add to the **`initiative`** service in your compose:

```yaml
    volumes:
      - ./uploads:/app/uploads
      - ./app-services.json:/app/app-services.json:ro
      - ./catalog:/app/catalog:ro
    environment:
      # …everything already there, plus:
      APP_SERVICES_CONFIG: /app/app-services.json
      MARKETPLACE_EXTRA_CATALOG_DIR: /app/catalog
      GITHUB_APP_SECRET: ${GITHUB_APP_SECRET:?set it in .env}
      # Signs the tokens Initiative presents to apps. Without it registrations
      # reconcile and then fail verification, permanently.
      APP_PLATFORM_SIGNING_PRIVATE_KEY_PEM: |
        -----BEGIN PRIVATE KEY-----
        ...paste platform-signing.pem here, indented like this...
        -----END PRIVATE KEY-----
      # Hourly by default, which is a long time to watch a pending row while
      # setting up. Put it back afterwards.
      APP_SERVICE_VERIFY_INTERVAL_SECONDS: 60
```

## Step 4 — Add the app and its database

```yaml
  initiative-github-db:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_USER: initiative_github
      POSTGRES_PASSWORD: ${GITHUB_DB_PASSWORD:?set it in .env}
      POSTGRES_DB: initiative_github
    volumes:
      - github_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U initiative_github"]
      interval: 5s
      timeout: 5s
      retries: 5

  initiative-github:
    image: ghcr.io/morelitea/initiative-github:latest
    restart: unless-stopped
    environment:
      DATABASE_URL: postgres://initiative_github:${GITHUB_DB_PASSWORD}@initiative-github-db:5432/initiative_github
      # Server-to-server: how THIS container reaches Initiative.
      INITIATIVE_BASE_URL: http://initiative:8173
      # Browser-facing: where GitHub sends a member back.
      APP_PUBLIC_URL: ${GITHUB_APP_PUBLIC_URL:?set it in .env}
      INITIATIVE_APP_SECRET: ${GITHUB_APP_SECRET:?set it in .env}
      APP_ENCRYPTION_KEY: ${GITHUB_ENCRYPTION_KEY:?set it in .env}
      GITHUB_CLIENT_ID: ${GITHUB_CLIENT_ID:?}
      GITHUB_CLIENT_SECRET: ${GITHUB_CLIENT_SECRET:?}
      GITHUB_APP_PRIVATE_KEY: ${GITHUB_APP_PRIVATE_KEY:?}
      GITHUB_WEBHOOK_SECRET: ${GITHUB_WEBHOOK_SECRET:?}
    depends_on:
      initiative-github-db:
        condition: service_healthy
    ports:
      - "8080:8080"
```

and beside the existing `postgres_data:` volume, add `github_data:`.

`INITIATIVE_APP_SECRET` here and `GITHUB_APP_SECRET` on Initiative are **the same
value under two names**. Both sides prove they hold it; neither sends it.

## Step 5 — Start it, and check

```bash
docker compose up -d

# From the machine itself, straight at the container:
curl http://127.0.0.1:8080/readyz                       # {"ok":true}

# And through the proxy, which is what GitHub and a browser will use:
curl https://github-app.example.com/.well-known/initiative-app.json | head -c 80

docker compose logs initiative | grep "app services"    # 1 created
```

Both curls matter. The first says the container is up; the second says the
hostname on the GitHub App form actually reaches it, which is the half that fails
silently until somebody tries to connect.

Within a minute the registration verifies. `1 created` and nothing after it means
Initiative wrote the row and could not reach the app — check `base_url` matches
the service name.

## Step 6 — Install it in your guild

In Initiative: **guild settings → Apps**. *GitHub* is there; install it, then open
its settings:

- **Owner or organization** — your GitHub username, or the org's name. Just the
  account: `octocat`, not `octocat/hello-world`.
- **Repositories** — comma-separated, or blank for every repository the
  installation covers.

Install **GitHub overview** the same way for the ready-made dashboard.

## Step 7 — Install the GitHub App at GitHub

The half GitHub owns. Visit `https://github-app.example.com/install/github`; it
redirects to your app's install page, where you choose the account and which
repositories it may see.

Installing and authorizing are one trip, so you will likely come back already
connected.

## Step 8 — Connect your account

If step 7 did not do it: in the app's settings, **Your GitHub account →
Connect**. You are sent to GitHub, you authorize, you come back.

Every widget runs on your credential, so a member who has not connected is asked
to rather than shown somebody else's numbers.

---

# Reference

## Settings

Required — the container refuses to start without any of them:

| | |
|---|---|
| `DATABASE_URL` | Postgres. Members' credentials, in-flight handshakes, per-install configuration, subscriptions. |
| `APP_ENCRYPTION_KEY` | 32 bytes base64. Seals members' tokens at rest, so a database backup is not a pile of GitHub tokens. |
| `INITIATIVE_BASE_URL` | Server-to-server: where this container reaches Initiative. |
| `APP_PUBLIC_URL` | Browser-facing, and where GitHub posts. Every URL on the GitHub App registration is built from it. |
| `INITIATIVE_APP_SECRET` | The secret this app's registration was wired with. |
| `GITHUB_CLIENT_ID` | From the GitHub App. Doubles as the issuer of the app's own JWT. |
| `GITHUB_CLIENT_SECRET` | From the GitHub App. Completes a member's authorization. |
| `GITHUB_APP_PRIVATE_KEY` | From the GitHub App, as PEM or base64 of it. What the app signs as itself with. |
| `GITHUB_WEBHOOK_SECRET` | From the GitHub App. The only reason to believe a delivery came from GitHub. |

Optional:

| | |
|---|---|
| `PORT` | Default 8080. |
| `SYNC_INTERVAL_SECONDS` | Default 300. How often to re-read which guilds have this app. |
| `GITHUB_API_BASE` · `GITHUB_WEB_BASE` | For GitHub Enterprise, where the API and the pages people visit are different hosts. Set both together. |

`env-contract.json` is the same list as data, and a test keeps it current.

## When something is wrong

| What you see | What it means |
| --- | --- |
| Container exits immediately | A required setting is missing; the log names it. |
| `GITHUB_APP_PRIVATE_KEY is not a PEM private key` | The base64 lost a character, or you pasted the `.pem` path rather than its contents. |
| `this database was built by a different version of src/db.ts` | There is no migration path here. Drop the app's database and let it be recreated. |
| Registration stuck `pending` | Initiative cannot reach `base_url`, or the two secrets differ. |
| Every tile says *connect your account* | You have not connected, or the write-back failed — see the next row. |
| *Nearly there* after authorizing | GitHub authorized you and Initiative did not record it. Try again; nothing was lost. |
| Tile says *not installed* | Step 7 is not done for the account named in step 6, or **Repositories** is blank and the app is not installed anywhere. |
| Tile says *repository-required* | The install covers several repositories and the tile does not say which. Name one in the app's settings, or set `repo` on the dashboard tile. |
| Redirect mismatch at GitHub | `APP_PUBLIC_URL` and the Callback URL disagree. They must match exactly, scheme and port included. |
| GitHub's *Recent Deliveries* shows red | `401` is the webhook secret differing between the form and the container. A timeout is the proxy: the Webhook URL does not reach port 8080. |

## Working on this repository

```bash
npm install
npm test                  # needs DATABASE_URL — any empty Postgres
npm run typecheck
npm run dev
```

`npm run manifest`, `npm run catalog` and `npm run github-app` write the manifest,
the two catalog listings and the GitHub App registration; each validates before
it writes. Releases are cut by pushing a `vX.Y.Z` tag — the tag is the version,
and the workflow publishes the image and attaches the catalog files.

## License

MIT
