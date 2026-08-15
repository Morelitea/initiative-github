# initiative-github

The reference app for [Initiative](https://github.com/Morelitea/initiative) —
GitHub issues and reviews, as dashboard widgets and automation nodes.

It is a real app, and it is the one to clone when starting your own. There is
deliberately no template repo: a template is a copy nobody runs, and the copy
nobody runs is the one that quietly stops matching the protocol. This has to
keep working, so it cannot drift.

**To start an app: clone this, replace the vendor half, keep the boundary.**

## What it demonstrates

It exercises the widest slice of the protocol on purpose:

| | |
|---|---|
| **Per-member connections** | GitHub authorizes a *person*, so each member connects their own account and the app holds one credential per person. Installing never waits for anyone to do it. |
| **Guild-scoped connections** | Which repository the guild cares about, and the read access the whole guild shares — both filled in once by an admin. |
| **Marketplace listings** | Two: the app itself, and a companion dashboard shipping a ready-made arrangement of its widgets. Built from the manifest, so neither can describe an app that no longer exists. |
| **Two tiers of scope** | Every source is answered at the narrowest level that answers it: the repository's numbers from the guild's own access, one person's review queue from their own account. |
| **Data sources** | Answered per caller, from that member's own credential, returning only what the widget draws. |
| **Widgets** | A sandboxed browser module handed its sources' data, returning a scene. |
| **Events** | Namespaced under this app's own service id. |
| **Automation nodes** | Two triggers and an action, contributed to the canvas as descriptors — no code ships to it. See [AUTOMATION.md](AUTOMATION.md). |
| **No app-wide credential** | This app does write at GitHub, and still holds nothing of its own: every call runs as the member who authorized it, and stops when they disconnect. |

## The shape worth copying

**No embedded page, on purpose.** Everything this app offers lands inside
Initiative's own surfaces — dashboard widgets and automation nodes — rather than
in an iframe holding a second UI. An embed is for an app whose product *is* a
page; an integration is better delivered as parts.

**Serving a manifest is not being installable.** They are separate files with
separate audiences: the document at `/.well-known/initiative-app.json` is what a
*registrar* fetches to verify a container an operator already decided to run, and
a **listing** is what a guild admin browses and installs. Nothing derives one
from the other. This app shipped a release with no listing — registered, live,
healthy, and impossible for anyone to add.

```
src/listing.config.ts   →  catalog/morelitea.github.json            (the app)
                        →  catalog/morelitea.github-overview.json   (a dashboard)
```

**A companion listing ships a dashboard with the app.** The second file is a
`kind: "dashboard"` entry in the same marketplace: a ready-made arrangement of
this app's own three widgets, so a guild that installs both has something to look
at without assembling it. It carries no code — a layout naming widget types the
app's pinned definition already declares — and the only thing tying the two
together is the catalog uid.

**Scope each source to the narrowest thing that answers it.** How many issues
are open is one answer for the whole guild, so it runs on the guild's shared
read access and nobody hands over a personal GitHub account to see a number.
Which pull requests are waiting on *your* review is one answer per person, so it
runs on that member's own credential. The manifest says which, per source:

```ts
// open-issues, issue-throughput — one answer for everyone
requires: { all_of: ["workspace", "shared_account"] }

// review-queue — "waiting on me" has no meaning without a me
requires: { all_of: ["workspace", "account"] }
```

Getting this backwards is the easy mistake and it hides well: answering a shared
question from the caller's own token returns the right number, while quietly
requiring every member to connect. It also costs real work — a source that names
no per-member connection is cached **once per guild**, so twenty people opening a
dashboard is one upstream call rather than twenty.

**Your app learns a handle, not a person.** When Initiative calls a data source
on a member's behalf, the context token carries `connection_refs` — opaque
handles this app minted nothing of. Credentials are stored keyed by that handle
([`src/github/oauth.ts`](src/github/oauth.ts)). There is no user id, no email,
no name anywhere in this app, and the same person is uncorrelated across apps.

**Paths, never addresses.** The manifest names routes; the operator's
registration says where this app lives. There is nowhere in a manifest to put a
host, and [`test/manifest.test.ts`](test/manifest.test.ts) asserts this app
keeps to it.

**Verify every inbound call.** A context token names one guild, one install and
one scope, and lives about a minute. The scope is checked per route — a token
minted to fetch a source is not usable to run an action
([`src/server.ts`](src/server.ts)).

**An action runs as a member, never as the app.** The one thing this app writes
— opening an issue — uses the credential the context token names, so an
automation opens issues as the person who set it up and stops working when they
withdraw. [`src/github/actions.ts`](src/github/actions.ts).

**Reconcile, do not trust a signal.** Which guilds have this app comes from
asking Initiative ([`src/sync.ts`](src/sync.ts)), on a poll as well as on the
lifecycle signal. A signal that arrives while this app is restarting is gone —
nothing retries it — so an install configured during a deploy would otherwise
stay unconfigured until somebody touched it again.

**A vendor event has no guild in it.** A GitHub delivery names a repository and
that is all. Turning it back into somewhere to emit is the app's own job, and
the reverse lookup is the whole trigger side working
([`src/github/webhooks.ts`](src/github/webhooks.ts)).

## Layout

```
manifest.config.ts      the manifest, authored in TypeScript and built to JSON
src/
  server.ts             every protocol route, in one readable file
  config.ts             what the operator supplies
  listing.config.ts     what this app publishes — the app, and a dashboard
  initiative.ts         the one client for calling Initiative
  sync.ts               keeping this app's picture of its installs true
  github/
    oauth.ts            the member's own vendor flow, keyed by handle
    queries.ts          data sources, each at the scope that answers it
    actions.ts          the one write, as the member who authorized it
    webhooks.ts         a GitHub delivery becoming an Initiative event
    workspace.ts        which repository, read both ways
    shared-access.ts    the guild's credential, held only while it is lent
scripts/
  build-manifest.ts     validates, then writes manifest.json
  build-listing.ts      validates, then writes catalog/*.json
test/manifest.test.ts   the test to copy into your own app
test/listing.test.ts    the listings stay tied to the manifest they publish
test/webhooks.test.ts   the signature, the translation, and their agreement
test/delivery.test.ts   repository back to guild — needs a database
test/shared-access.test.ts  clearing the guild's credential actually stops it
```

## Publishing it

The catalog files are **built, not committed** — the tag is the version here, so
a listing carrying one on `main` would let an ordinary commit stage a release.
Each release attaches them; an operator publishes this app by dropping them into
the directory their `MARKETPLACE_EXTRA_CATALOG_DIR` points at. No fork, no pull
request, no release of Initiative. Removing a file withdraws the listing, and
guilds that installed it keep what they have.

```bash
npm run catalog                        # catalog/*.json at 0.0.0-dev
LISTING_VERSION=1.2.3 npm run catalog  # what the release does
```

The `uid` in [`src/listing.config.ts`](src/listing.config.ts) is
publisher-assigned, immutable and never reused. It is what ties the verified
registration to the listing, and what ties the companion dashboard's widgets to
this app. Mint your own with `npx initiative-app uid`; do not reuse these.

## Running it

```bash
cp .env.example .env      # see below for what each value is
npm install
npm run manifest          # validates, then writes manifest.json
npm test                  # needs DATABASE_URL; see below
npm run dev
```

The tests want a Postgres they may truncate. Any empty database will do:

```bash
createdb initiative_github_test
DATABASE_URL=postgres://localhost/initiative_github_test npm test
```

Then an operator registers it: the deployment fetches
`/.well-known/initiative-app.json`, posts a challenge to `/v1/handshake`, and
both ends prove they hold the same secret without either sending it.

## Deploying it

```
ghcr.io/morelitea/initiative-github:latest
```

Published on tag for `linux/amd64` and `linux/arm64`. `/healthz` is liveness;
`/readyz` additionally proves the database is reachable, so a pod that cannot
serve a source is not sent traffic. `SIGTERM` finishes in-flight requests before
the pool closes.

### What it needs

| | |
|---|---|
| **Postgres** | `DATABASE_URL`. Members' credentials, in-flight vendor handshakes, per-install configuration. The schema is applied idempotently at boot, so every replica can run it. |
| **An encryption key** | `APP_ENCRYPTION_KEY`, 32 bytes base64 (`openssl rand -base64 32`). Members' tokens are sealed at rest, so a database backup is not a pile of GitHub tokens. |
| **A public hostname** | `APP_PUBLIC_URL`. GitHub redirects a browser back to `<APP_PUBLIC_URL>/connect/github/callback`, so this needs DNS and a proxy entry. |
| **A GitHub OAuth app** | `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`, scopes `read:user` and `repo`. You create this; nothing can generate it. Its callback must be the URL above. Members use it for their own connection — the guild's shared read access is a token an admin pastes, and needs none of this. |
| **A webhook secret** | `GITHUB_WEBHOOK_SECRET`, any long random string (`openssl rand -hex 32`). The same value goes into each repository's webhook settings; GitHub signs every delivery with it and this app verifies it before reading the body. |

### Wiring the triggers

The automation nodes this app contributes are only half of a trigger; the other
half is GitHub actually telling it something happened. In each repository a
guild has configured, add a webhook:

| | |
|---|---|
| **Payload URL** | `<APP_PUBLIC_URL>/webhooks/github` |
| **Content type** | `application/json` |
| **Secret** | the same `GITHUB_WEBHOOK_SECRET` |
| **Events** | *Issues* and *Pull requests* |

GitHub sends a `ping` first; a green tick beside it means the secret matches.
From then on a delivery reaches every guild whose install names that repository
— matched from the configuration this app pulls, so a guild that has not filled
in its repository receives nothing.

Deliveries this app has no install for are answered `200` and logged rather than
failed. GitHub retries a failure, and an event with nowhere to go will not
succeed on the second attempt.

### Two addresses, deliberately separate

`INITIATIVE_BASE_URL` is **server-to-server** — where this app fetches the keys
a context token is verified against. In a cluster it should be the in-cluster
Service, so verification does not depend on the public ingress being up.

`APP_PUBLIC_URL` is **browser-facing**, and only that.

This app mounts no embedded surface, so it needs no third address for "where the
iframe loads". An app that *does* embed needs one and must not reuse the
server-to-server address for it: Initiative builds both the iframe URL and the
page's `frame-src` from the registration's `embed_origin`, **falling back to
`base_url` when it is unset** — which is how a cluster ends up framing an
address no browser can resolve.

## What is deliberately simple here

The issue counts come back as a single number because that is what the widget
draws. Sending the vendor's whole payload would put data nobody renders into a
cache and into a browser.

The schema is applied as idempotent DDL at boot rather than through a migration
tool. Three tables of this shape do not earn the dependency — but the statements
are additive on purpose, so a new column is a new statement rather than an edit.

## License

MIT
