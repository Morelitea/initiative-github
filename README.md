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
| **A real GitHub App** | Not an OAuth app: a party at GitHub in its own right, with a private key, permissions an organization approves, installation tokens, and one webhook rather than one per repository. Registered separately from the Initiative listing — see [Two registrations](#two-registrations). |
| **Per-member connections** | GitHub authorizes a *person*, so each member connects their own account and the app holds one credential per person. Installing never waits for anyone to do it. |
| **Guild-scoped access, without a guild credential** | Which repository the guild cares about is the only thing an admin types. The access is the *installation* the organization granted, found from that repository — so nobody pastes a token. |
| **Marketplace listings** | Two: the app itself, and a companion dashboard shipping a ready-made arrangement of its widgets. Built from the manifest, so neither can describe an app that no longer exists. |
| **Two tiers of scope** | Every source is answered at the narrowest level that answers it: the repository's numbers from the guild's own access, one person's review queue from their own account. |
| **Data sources** | Answered per caller, from that member's own credential, returning only what the widget draws. |
| **Widgets** | A sandboxed browser module handed its sources' data, returning a scene. |
| **Events** | Namespaced under this app's own service id. |
| **Automation nodes** | Two triggers and an action, contributed to the canvas as descriptors — no code ships to it. See [AUTOMATION.md](AUTOMATION.md). |
| **One credential of its own, and it is the right one** | The private key its registration is signed with. It names the app rather than a person, reaches nothing until an organization installs it, and stops reaching when they remove it. Every *write* still runs as the member who authorized it. |

## Two registrations

This app is installed twice, by two different people, and neither knows about
the other. That is the shape of every integration of this kind — it is what
Slack's own GitHub app is — and getting it wrong is the first thing that stops
one working.

| | Initiative | GitHub |
|---|---|---|
| **Who** | an operator wiring up a container, then a guild admin installing from the marketplace | somebody who owns the organization |
| **Proves what** | the app serves the manifest at the address the operator registered | the app holds the private key GitHub generated |
| **Says** | which repository this guild cares about | which repositories this app may see, and what it may do in them |
| **Revoked by** | uninstalling in Initiative | uninstalling at GitHub |

Nothing joins them up except [`src/sync.ts`](src/sync.ts), and until both are
done there is nothing to answer with. An admin who fills in the repository
before anybody has installed the GitHub App gets `github_app_not_installed`
beside the install rather than three widgets saying "unavailable" — and when the
organization does install it, the `installation` delivery flips it to `ok`
within seconds. Either half can be done first.

Register the GitHub half with `npm run github-app`, which prints every field and
writes `github-app.json` for [GitHub's manifest
flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest);
or fill the form in by hand following [Registering a GitHub
App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).
Either way the registration comes from
[`src/github/registration.ts`](src/github/registration.ts) rather than from
prose, so the permissions and events on it are the ones the code actually uses —
and [`test/github-app.test.ts`](test/github-app.test.ts) is what says so.

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
are open is one answer for the whole guild, so it runs on the organization's
installation and nobody hands over a personal GitHub account to see a number.
Which pull requests are waiting on *your* review is one answer per person, so it
runs on that member's own credential. The manifest says which, per source:

```ts
// open-issues, issue-throughput — one answer for everyone
requires: { all_of: ["workspace"] }

// review-queue — "waiting on me" has no meaning without a me
requires: { all_of: ["workspace", "account"] }
```

Getting this backwards is the easy mistake and it hides well: answering a shared
question from the caller's own token returns the right number, while quietly
requiring every member to connect. It also costs real work — a source that names
no per-member connection is cached **once per guild**, so twenty people opening a
dashboard is one upstream call rather than twenty.

**A widget must not ask for more than its sources do.** This app shipped a
release where all three widgets required a personal account and only one source
did, so two tiles refused with `CONNECTION_REQUIRED` for every member who had
not connected one — to draw numbers that never needed them. Fixing the sources
and leaving the widgets alone changes nothing a member can see.

**The guild's access is a grant, not a credential.** The version of this app
before it was a GitHub App asked an admin to paste a token with read access to
the repository. That token was a *person's* credential wearing the guild's name:
it carried everything that person could reach, it outlived their interest in the
guild, and revoking it meant finding whoever minted it. An installation is the
organization's own grant — listed in its settings, scoped to the repositories it
picked, revoked by a button that belongs to it. The app cannot widen it and
cannot survive its removal, and nobody types anything secret.

```ts
// what an admin fills in                what the app works out
{ owner: "acme", repo: "widgets" }   →   GET /repos/acme/widgets/installation
```

**A member's token is short-lived, and that is a feature.** A GitHub App's user
token lasts eight hours and is renewed with a refresh token that lasts six
months — where an OAuth app's token lasted until somebody revoked it, which is
to say forever. So the credential is a rotating pair, renewed on use rather than
on a schedule, and renewed under a row lock: refresh tokens are single-use, and
two replicas renewing the same member at once would have one succeed and the
other overwrite a good credential with nothing
([`src/github/oauth.ts`](src/github/oauth.ts)).

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

**Not every delivery is an event.** A GitHub App is also told about its own
installation — an organization adding it, removing it, or changing which
repositories it may see. None of that is something to emit into a guild: no
subscriber asked to hear that somebody clicked a button, and the manifest
declares no event that could carry it. What it changes is whether this app can
answer at all, so it re-runs the sync for the installs it affects. News about
the repository and news about the relationship are different things.

## Layout

```
src/
  manifest.config.ts    the manifest, authored in TypeScript and built to JSON
  server.ts             every protocol route, in one readable file
  config.ts             what the operator supplies
  routes.ts             every path, in one place — two registrations read them
  listing.config.ts     what this app publishes — the app, and a dashboard
  initiative.ts         the one client for calling Initiative
  sync.ts               keeping both halves of the install true
  github/
    registration.ts     how this app describes itself to GitHub
    app.ts              the app's own identity: JWT, installation, token
    oauth.ts            the member's own vendor flow, keyed by handle
    queries.ts          data sources, each at the scope that answers it
    actions.ts          the one write, as the member who authorized it
    webhooks.ts         a delivery becoming an event — or a re-sync
    workspace.ts        which repository, read three ways
scripts/
  build-manifest.ts     validates, then writes manifest.json
  build-listing.ts      validates, then writes catalog/*.json
  build-github-app.ts   writes the GitHub App registration to fill in
test/manifest.test.ts   the test to copy into your own app
test/listing.test.ts    the listings stay tied to the manifest they publish
test/github-app.test.ts the GitHub registration stays tied to the code
test/webhooks.test.ts   the signature, the translation, and their agreement
test/delivery.test.ts   repository back to guild — needs a database
test/installation.test.ts  the guild's access is the organization's grant
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
npm run github-app        # prints the GitHub registration to create
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
| **A public hostname** | `APP_PUBLIC_URL`. Every URL on the GitHub App registration is built from it, so this needs DNS and a proxy entry before you register anything. |
| **A GitHub App** | One registration, giving four values: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_WEBHOOK_SECRET`. You create it; nothing can generate it. `npm run github-app` prints every field to fill in and writes the manifest if you would rather not type them. |

### Wiring the triggers

Nothing to wire. The webhook is part of the registration — one URL and one
secret, covering every organization that installs the app — which is one of the
concrete reasons to be a GitHub App rather than an OAuth app. The version of
this app before it was one needed a webhook added by hand to every repository a
guild configured, and received nothing at all from the one somebody forgot.

GitHub sends a `ping` when the registration is saved; a green tick beside it
means the secret matches. From then on a delivery reaches every guild whose
install names that repository — matched from the configuration this app pulls,
so a guild that has not filled in its repository receives nothing.

Deliveries this app has no install for are answered `200` and logged rather than
failed. GitHub retries a failure, and an event with nowhere to go will not
succeed on the second attempt.

### Installing it on an organization

An admin fills in the repository in Initiative's own settings for the app; the
organization it belongs to has to install the GitHub App. Either order works and
neither blocks the other. The link is this app's own address:

```
<APP_PUBLIC_URL>/install/github
```

It redirects to the registration's install page, which is derived from the slug
GitHub reports for the private key — so it cannot point at a different app from
the one this deployment is. Afterwards GitHub returns the person to
`<APP_PUBLIC_URL>/setup/github`, which tells them the one thing left to do.

That page deliberately reports nothing about the installation it was handed. The
redirect carries an `installation_id` and no proof of anything, so a page that
looked it up would report one organization's repositories to whoever guessed a
number.

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

GitHub has the same split for the same reason, and it matters only on GitHub
Enterprise: `GITHUB_API_BASE` is where the API answers, `GITHUB_WEB_BASE` is
where a person is sent — authorize, install, and the token exchange behind them.
On github.com they are `api.github.com` and `github.com` and both default
correctly; on Enterprise they are different shapes of the same host, so an app
that configures one and hardcodes the other works everywhere except there.

## What is deliberately simple here

The issue counts come back as a single number because that is what the widget
draws. Sending the vendor's whole payload would put data nobody renders into a
cache and into a browser.

Installation tokens are held in memory and nowhere else. One lasts an hour and
can always be minted again from the private key, so writing one down would add a
durable copy of a credential in exchange for nothing.

The schema is applied as idempotent DDL at boot rather than through a migration
tool. Three tables of this shape do not earn the dependency — but the statements
are additive on purpose, so a new column is a new statement rather than an edit.

## License

MIT
