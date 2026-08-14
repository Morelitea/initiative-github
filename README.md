# initiative-github

The reference app for [Initiative](https://github.com/Morelitea/initiative) —
GitHub issues and reviews, as widgets, an embedded page, and events.

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
| **Guild-scoped connections** | Which repository the guild cares about — one setting a guild admin fills in once. |
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

## Layout

```
manifest.config.ts     the manifest, authored in TypeScript and built to JSON
src/
  server.ts            every protocol route, in one readable file
  config.ts            what the operator supplies
  github/
    oauth.ts           the member's own vendor flow, keyed by handle
    queries.ts         data sources, answered per caller
    actions.ts         the one write, as the member who authorized it
    workspace.ts       the guild-scoped configuration
scripts/
  build-manifest.ts    validates, then writes manifest.json
test/manifest.test.ts  the test to copy into your own app
```

## Running it

```bash
cp .env.example .env      # see below for what each value is
npm install
npm run manifest          # validates, then writes manifest.json
npm test
npm run dev
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
| **A GitHub OAuth app** | `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`, scopes `read:user` and `repo`. You create this; nothing can generate it. Its callback must be the URL above. |

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
