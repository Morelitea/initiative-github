# initiative-github

The reference app for [Initiative](https://github.com/Morelitea/initiative) —
GitHub issues, reviews and dependency alerts, as dashboard widgets.

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

**Every deployment registers its own GitHub App**, and there is no shared one to
hand out. The obvious obstacle is that GitHub matches the callback, setup and
webhook URLs exactly and admits no wildcards — but that one is shallow, and a
redirect broker keyed on `state` would get around it. The real obstacle is
underneath: completing a member's connection needs the **client secret**, and
minting an installation token needs the **private key**. Both are app-level, so
any deployment acting *as* the app has to hold them — and one app shared across
independent operators means every operator holds the app's identity and can
impersonate it to every organization that ever installed it.

The alternative is a broker that keeps the secrets and hands tokens back to each
deployment, which puts its owner in the credential path for every self-hosted
guild's GitHub access. That is not self-hosting, and it is the arrangement the
rest of this file argues against. GitHub's model is one app, one operator.

What that costs a self-hoster is a form, once — `npm run github-app` prints
every field. What it buys is that nobody is waiting on anybody, and no third
party can reach their repositories.

The only URL on the registration that is *not* an address the deployment answers
on is the homepage, which is a link shown to a reader. It defaults to this
project's page and moves nothing if you change it.

### Registering it in one click

The form is 22 steps, and every field on it is one the code already knows. So
there is a flow that fills it in — the same shape Atlantis and Sourcegraph
settled on, for the same reason:

```bash
GITHUB_APP_SETUP_TOKEN=$(openssl rand -hex 32)   # then start the app
open "$APP_PUBLIC_URL/setup/github/register?token=$GITHUB_APP_SETUP_TOKEN"
```

It posts a filled-in manifest to GitHub, you confirm the name and permissions,
and GitHub hands back an app already carrying the right permissions, events and
URLs. Add `?org=YOUR-ORG` to create it under an organization, which is usually
what you want — an app owned by a personal account leaves the organization
unable to manage it.

**Nothing is stored.** The last page shows the four values once, for you to put
wherever this deployment reads its environment. Writing them to the database
instead would be more convenient and would cost the two things
[`config.ts`](src/config.ts) promises: credentials read once at boot, and a
running deployment whose identity cannot be changed by reaching a URL.

**Then remove `GITHUB_APP_SETUP_TOKEN`.** Without it the two routes answer `404`
rather than `403` — indistinguishable from a deployment that never had the
feature, because a route that answers differently once a feature is configured
tells an unauthenticated caller which deployments to come back to. The second
route cannot be guarded by the token at all, since GitHub redirects to it
carrying only a code and a `state`; the state is signed with the token instead,
so rotating the token ends every flow it authorized
([`src/github/setup.ts`](src/github/setup.ts)).

Or fill the form in by hand: `npm run github-app` prints every field, following
[Registering a GitHub
App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).
Either way the registration comes from
[`src/github/registration.ts`](src/github/registration.ts) rather than from
prose, so the permissions and events on it are the ones the code actually uses —
and [`test/github-app.test.ts`](test/github-app.test.ts) is what says so.

## The shape worth copying

**No embedded page, on purpose.** Everything this app offers lands inside
Initiative's own surfaces — dashboard widgets, and the companion dashboard that
arranges them — rather than in an iframe holding a second UI. An embed is for an app whose product *is* a
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

**Every permission arrives with the code that reads it.** The registration asks
for `issues: write`, `pull_requests: read`, `vulnerability_alerts: read` and the
mandatory `metadata: read` — all repository-scoped, nothing about an
organization's members or settings. Widening the list later is not a change you
can just ship: GitHub asks every organization that already installed the app to
approve it, and each keeps the old grant until they do, so a permission added in
six months arrives broken for everyone who installed before it. That asymmetry
is a real argument for asking early and it is not the one this list follows — a
permission with nothing reading it is one an organization grants for no feature,
and a reviewer cannot tell "not used yet" from "used for something not
described". [`test/github-app.test.ts`](test/github-app.test.ts) asserts each one
has a source behind it.

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

**One install, several repositories; one initiative, one of them.** An
installation covers whatever repositories the organization granted, so an admin
types an account and — usually — nothing else. Which repository a *tile* is
about comes from its dashboard, through a fixed `repo` on the binding:

```ts
// team-alpha's dashboard                 // team-beta's dashboard
binding: { source_id: "open-issues",      binding: { source_id: "open-issues",
           params: { repo: "widgets" } }             params: { repo: "gadgets" } }
```

That works because [dashboards are
initiative-scoped](../initiative/backend/app/models/tenant/dashboard.py) — there
is no guild-wide one — so a dashboard *is* an initiative, and binding a
repository there pins one team to one repository. The same trick narrows the
same tile by label, milestone or assignee, and the platform caches per parameter
set, so two teams' tiles are one source answered twice rather than one answer
shared.

Be exact about what that does and does not enforce. This app checks every call
against what the organization granted, because GitHub tells it that. It cannot
keep one team out of another team's repository, because a context token names a
guild and an install and **nothing finer** — there is no initiative in it. What
holds that boundary is who may edit the dashboard. Making it enforced rather
than conventional needs `initiative_id` on the context token, which is a change
on the platform side, not here.

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

**This app only reads.** It contributed automation nodes once — two triggers and
an action that opened issues — and both halves are gone. The action went because
the nodes did; the nodes went because the events behind them could not arrive.

That is worth writing down rather than quietly deleting, because the code was
fine and the manifest validated. An app emits through `emitEvent`, the platform
accepts it, checks it against the app's pinned definition and hands it to the
dispatcher — and the vocabulary a webhook subscription may name is *derived from
Initiative's own content tables* (`{resource}.{action}`), with anything else
refused at registration. So nothing can subscribe to `app.<id>.<event>`, the
dispatcher matches no subscription, and the emit returns success having
delivered to nobody. No error anywhere.

The permission came down with it: `issues` went from `write` to `read`.
Narrowing is the one direction that is free — GitHub asks nobody to re-approve a
permission an app stopped wanting.

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
    setup.ts            registering that, in one click, once
    app.ts              the app's own identity: JWT, installation, token
    oauth.ts            the member's own vendor flow, keyed by handle
    queries.ts          data sources, each at the scope that answers it
    webhooks.ts         a delivery becoming an event — or a re-sync
    workspace.ts        which repository, read three ways
scripts/
  build-manifest.ts     validates, then writes manifest.json
  build-listing.ts      validates, then writes catalog/*.json
  build-github-app.ts   writes the GitHub App registration to fill in
test/manifest.test.ts   the test to copy into your own app
test/listing.test.ts    the listings stay tied to the manifest they publish
test/github-app.test.ts the GitHub registration stays tied to the code
test/app-setup.test.ts  the gate in front of the one-click registration
test/webhooks.test.ts   the signature, which is the whole reason to trust it
test/delivery.test.ts   an installation back to guilds — needs a database
test/installation.test.ts  the guild's access is the organization's grant
test/repositories.test.ts  which repository, and the boundary it can enforce
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

### The webhook, and the two jobs it does

Nothing to wire. One URL and one secret on the app's own registration, covering
every organization that installs it, and two kinds of delivery arrive there.

**The installation lifecycle** arrives whether the app asks for it or not —
*"All GitHub Apps receive this event by default. You cannot manually subscribe
to this event."* An organization installing this app, removing it, or changing
which repositories it may see is the one thing this app cannot work out for
itself in time to matter, so a delivery re-runs the sync for the installs it
affects and tells nobody else.

**Repository activity** — an issue opened or closed, a review requested — is
republished to whoever asked to hear it. That is the producer surface below,
and it is not the same thing as the widgets: a guild with no automation service
gets its dashboard either way, because the data path never touches any of this.

### Telling an automation service what happened

An app holds its vendor's webhook connection, so it is the thing that knows
when something happened there. This app publishes three event types, declared
in its manifest and produced **directly** to whoever subscribed. Initiative is
not in that path.

| Route | Who calls it | What it does |
| --- | --- | --- |
| `GET /v1/events` | anyone | The event types this app produces. Public, like the manifest that declares them. |
| `POST /v1/events/subscriptions` | a delegate | Records an address to deliver to, and hands back the signing secret once. |
| `GET /v1/events/subscriptions` | a delegate | What that delegate has asked for in that guild. |
| `DELETE /v1/events/subscriptions/{id}` | a delegate | Drops one of its own. |

A **delegate** is an app the operator granted `delegation` to. It proves itself
with a token it signed, verified against a key the deployment publishes for it,
and the token names one guild — so a subscription is for that guild and nothing
in the request can widen it. The shapes come from `initiative-app-kit` rather
than from this app, which is the point: a subscriber that can read one app's
events can read every app's.

Two properties worth knowing, both of which the tests pin:

- **A redelivery is recognizable.** The envelope's id is derived from GitHub's
  own delivery id, so a delivery GitHub re-sends carries the id the subscriber
  already recorded rather than looking like a second event.
- **Nothing here can break the dashboard.** A subscriber that is down is logged
  and dropped; GitHub still gets its `200`.

Deliveries this app has no install for are answered `200` and logged rather than
failed, for the same reason: GitHub retries a failure, and a delivery with
nowhere to go will not succeed on the second attempt.

The webhook is part of the registration — one URL and one secret, covering every
organization that installs the app — which is one of the concrete reasons to be
a GitHub App rather than an OAuth app. The version of this app before it was one
needed a webhook added by hand to every repository a guild configured, and
received nothing at all from the one somebody forgot.

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
