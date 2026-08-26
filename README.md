# initiative-github

Brings a repository's issues, reviews and dependency alerts into
[Initiative](https://github.com/Morelitea/initiative) as dashboard widgets, and
lets an automation act on that repository as the person whose automation it is.

[Setting it up](#setting-it-up-beside-a-self-hosted-initiative) is eight steps.

## What it does

| | |
|---|---|
| **A GitHub App** | A party at GitHub in its own right: an identity it signs with, permissions an organization approves when it installs, and one webhook covering every organization that ever does — rather than one added by hand per repository. Registered separately from the Initiative listing; see [Two registrations](#two-registrations). |
| **Everything runs as you** | Every widget and every write runs on the caller's own GitHub credential. You see exactly what you can see at GitHub, and nobody is shown the state of a repository they are not on. |
| **Per-member connections** | GitHub authorizes a *person*, so each member connects their own account and the app holds one credential per person, sealed at rest. Installing never waits for anyone to do it. |
| **One setting to fill in** | An account, and which of its repositories this guild cares about. That is everything an admin types. |
| **Four widgets** | Open issues, pull requests waiting on your review, Dependabot alerts by severity, and a fortnight of opens against closes. Each is a sandboxed browser module handed its data, returning a scene. |
| **Seven writes** | Open an issue, comment, close, reopen, label, request a review, move a Projects v2 card — each as the member whose automation asked for it, or not at all. |
| **Three events** | An issue opened, an issue closed, a review requested, published to whoever subscribed. |
| **Marketplace listings** | Two: the app itself, and a companion dashboard shipping a ready-made arrangement of its widgets. Built from the manifest, so neither can describe an app that no longer exists. |
| **One credential of its own** | The private key its registration is signed with. It names the app rather than a person, reaches nothing until an organization installs it, and stops reaching when they remove it. |

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

Nothing joins them up except [`src/sync.ts`](src/sync.ts), and either half can
be done first. An admin who names the repositories gets a working dashboard
whether or not anybody has installed the GitHub App yet — reads run on each
member's own credential, so they do not wait on it. What waits on it is the
webhook, and an admin who names *no* repositories waits too: with neither side
holding a list, the install reports `github_app_not_installed` until an
organization installs the app and the delivery flips it to `ok`.

**Every deployment registers its own GitHub App.** Acting as the app means
holding its client secret and its private key — both app-level, both enough to
be the app to every organization that installed it. So each operator holds their
own, and a deployment's GitHub access reaches no further than the organizations
that chose it.

That costs a form, once. [Setting it up](#setting-it-up-beside-a-self-hosted-initiative)
walks through it, and `npm run github-app` prints every field.

The only URL on the registration that is *not* an address the deployment answers
on is the homepage, which is a link shown to a reader. It defaults to this
project's page and moves nothing if you change it.

### Registering it in one click

The form is 22 steps, and every field on it is one the code already knows. So
there is a flow that fills it in — the same shape Atlantis and Sourcegraph
settled on, for the same reason:

```bash
INITIATIVE_APP_SETUP_TOKEN=$(openssl rand -hex 32)   # then start the app
open "$APP_PUBLIC_URL/setup/github/register?token=$INITIATIVE_APP_SETUP_TOKEN"
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

**Then remove `INITIATIVE_APP_SETUP_TOKEN`.** Without it the two routes answer `404`
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

There is no migration tool and no column-by-column upgrade path. What stands in
for one is a version: the database records which build of `src/db.ts` created it,
and booting against one built by a different build refuses, naming both. Drop it
and let it be recreated.

Then an operator registers it: the deployment fetches
`/.well-known/initiative-app.json`, posts a challenge to `/v1/handshake`, and
both ends prove they hold the same secret without either sending it.

## Deploying it

```
ghcr.io/morelitea/initiative-github:latest
```

Published on tag for `linux/amd64` and `linux/arm64`. `/healthz` is liveness;
`/readyz` additionally proves the database is reachable, so an instance that
cannot serve a source is not sent traffic. `SIGTERM` finishes in-flight requests
before the pool closes.

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

### Acting at GitHub on an automation's behalf

The app holds the credential, so the app does the writing. An automation service
that held GitHub tokens would be a second place they can leak from and a second
thing to reason about when revoking; keeping them here means an organization's
own installation grant is the whole of what any automation can do at GitHub —
listed in its settings, scoped to the repositories it picked, revoked by the
button that already lives there.

| Route | Who calls it | What it does |
| --- | --- | --- |
| `GET /v1/operations` | anyone | The closed set of things this app will do. Public, like the manifest. |
| `POST /v1/operations` | a delegate | Runs one, and reports whose credential it ran on. |

Seven operations: open an issue, comment, close, reopen, label, request a
review, and move a card on a Projects v2 board.

**Who the write is attributed to** is the part worth reading. A delegation token
names the member it acts for by a pairwise subject — opaque, and meaningless in
this app's namespace. Initiative resolves it to one of *this app's own*
connection refs, the same handle a context token hands over on the read path, so
the app runs the write on that member's own GitHub credential while learning no
more about them than it ever did. The comment says who wrote it and GitHub's
audit log names a person.

When there is no such member, an operation that permits it acts as the app
instead — and the response always says which happened, because an app acting as
itself has done something different from what was asked. An operation whose
whole meaning is *who did it* refuses instead: `request-review` runs as the
member or not at all, because a review request from "Initiative for GitHub" is
not a request from a colleague.

`move-project-item` is the odd one out three times over — GraphQL only,
organization-scoped, and addressed by node id. It is also the only reason this
app asks for a permission that reaches past a repository.

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
a context token is verified against. Where Initiative has a private address as
well as a public one, use the private one: verification then does not depend on
whatever fronts the public address being up.

`APP_PUBLIC_URL` is **browser-facing**, and only that.

This app mounts no embedded surface, so it needs no third address for "where the
iframe loads". An app that *does* embed needs one and must not reuse the
server-to-server address for it: Initiative builds both the iframe URL and the
page's `frame-src` from the registration's `embed_origin`, **falling back to
`base_url` when it is unset** — which is how a deployment ends up framing an
address no browser can resolve.

GitHub has the same split for the same reason, and it matters only on GitHub
Enterprise: `GITHUB_API_BASE` is where the API answers, `GITHUB_WEB_BASE` is
where a person is sent — authorize, install, and the token exchange behind them.
On github.com they are `api.github.com` and `github.com` and both default
correctly; on Enterprise they are different shapes of the same host, so an app
that configures one and hardcodes the other works everywhere except there.

## Setting it up beside a self-hosted Initiative

Start to finish, for somebody running Initiative from its own
`docker-compose.yml` on one machine: two more containers beside the two you
already have.

At the end: this app registered with your Initiative, a GitHub App registered
to your account, and the widgets installable in your guild.

### First, an address

This app needs a hostname of its own, reachable over HTTPS. Two different
parties follow it and both have to arrive: a member's **browser**, which GitHub
redirects after they authorize, and **GitHub's own servers**, which post the
webhook.

You already have the machinery. Initiative's installation checklist has you put
it behind HTTPS with Caddy, Traefik or nginx — give this app one more hostname
on that same proxy, pointed at port 8080:

```
https://github-app.example.com  →  http://127.0.0.1:8080
```

Use that hostname everywhere `APP_PUBLIC_URL` appears below, **including on the
GitHub App form**, which matches it character for character. The examples use
`https://github-app.example.com`; substitute yours.

### Step 1 — Register the GitHub App

A GitHub App is a party at GitHub in its own right. It has an identity it signs
with, an organization installs it and chooses which repositories it may see, and
members separately authorize it to act as themselves. You register one per
deployment, because GitHub matches every URL on it against a live host.

Open **<https://github.com/settings/apps/new>** and fill it in. For an
organization use `https://github.com/organizations/YOUR-ORG/settings/apps/new`
instead.

| Field | Value |
| --- | --- |
| GitHub App name | anything unique — GitHub App names are global |
| Homepage URL | `https://github.com/Morelitea/initiative-github` |
| Callback URL | `https://github-app.example.com/connect/github/callback` |
| Expire user authorization tokens | **checked** |
| Request user authorization (OAuth) during installation | **checked** |
| Setup URL | `https://github-app.example.com/setup/github` |
| Webhook → Active | checked |
| Webhook URL | `https://github-app.example.com/webhooks/github` |
| Webhook secret | `openssl rand -hex 32` — keep it |
| Where can this be installed | Any account |

Then **Repository permissions**: Issues → *Read and write*, Pull requests →
*Read and write*, Dependabot alerts → *Read-only*. And **Organization
permissions**: Projects → *Read and write*.

> Two of those have a near neighbour on the same form. Dependabot alerts is
> spelled `vulnerability_alerts` in the API and *Dependabot alerts* on the page.
> And Projects appears twice: take the **organization** one, which covers
> Projects v2 boards — the repository one covers classic project boards.

Under **Subscribe to events**, tick **Issues** and **Pull request**.

Create it. On the page that follows, collect four things:

1. **Client ID** — shown at the top.
2. **Client secret** — *Generate a new client secret*, copy it now.
3. **Private key** — *Generate a private key*. A `.pem` downloads.
4. **Webhook secret** — the value you generated above.

### Step 2 — Make the secrets the two containers share

```bash
openssl rand -hex 32            # → GITHUB_APP_SECRET, shared with Initiative
openssl rand -base64 32         # → GITHUB_ENCRYPTION_KEY, seals member tokens
openssl genrsa 2048 > platform-signing.pem   # Initiative's app-platform key
base64 -w0 your-app.private-key.pem          # → GITHUB_APP_PRIVATE_KEY
```

The last one matters: a PEM has newlines and an environment variable is one
line, so this app reads the key as base64 of the whole file. (It also accepts a
real PEM or one with `\n` typed literally — all three work.)

Put them in the `.env` beside your `docker-compose.yml`:

```bash
GITHUB_APP_SECRET=REPLACE-with-the-first-openssl-output
GITHUB_ENCRYPTION_KEY=REPLACE-with-the-second-openssl-output
GITHUB_CLIENT_ID=REPLACE-with-the-client-id-github-showed-you
GITHUB_CLIENT_SECRET=REPLACE-with-the-client-secret-you-generated
GITHUB_APP_PRIVATE_KEY=REPLACE-with-the-base64-of-your-pem
GITHUB_WEBHOOK_SECRET=REPLACE-with-the-webhook-secret-you-generated
GITHUB_APP_PUBLIC_URL=https://github-app.example.com
GITHUB_DB_PASSWORD=REPLACE-with-openssl-rand-hex-16
```

Every `REPLACE-…` above is a value only you have. Nothing in this repository
ships a working secret, and a value that looks like one in a guide is a value
somebody eventually pastes into production.

### Step 3 — Tell Initiative the app exists

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
the compose network, not localhost. `allowed_origins` is the browser-facing
address, and is worth setting rather than leaving empty: empty defaults it to
`base_url`, which would publish an address no browser can resolve.

Then get the catalog entries, without which the app registers and **no guild can
install it**:

```bash
mkdir -p catalog
curl -L -o catalog/morelitea.github.json \
  https://github.com/Morelitea/initiative-github/releases/latest/download/morelitea.github.json
curl -L -o catalog/morelitea.github-overview.json \
  https://github.com/Morelitea/initiative-github/releases/latest/download/morelitea.github-overview.json
```

The second is a companion dashboard with this app's four widgets already laid
out — installable separately, and the quickest way to see anything.

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
      # Hourly by default, which is a long time to watch a "pending" row while
      # you are setting up. Put it back afterwards.
      APP_SERVICE_VERIFY_INTERVAL_SECONDS: 60
```

### Step 4 — Add the app and its database

```yaml
  initiative-github-db:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_USER: initiative_github
      # Reachable only from the other containers on this compose network, and
      # still worth generating rather than copying: `openssl rand -hex 16`.
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
value under two names** — each side calls it what it is to them. That is the
whole handshake: both prove they hold it, neither sends it.

### Step 5 — Start it, and check

```bash
docker compose up -d

# From the machine itself, straight at the container:
curl http://127.0.0.1:8080/readyz                       # {"ok":true}

# And through the proxy, which is what GitHub and a browser will use:
curl https://github-app.example.com/.well-known/initiative-app.json | head -c 80

docker compose logs initiative | grep "app services"    # 1 created
```

Both matter. The first says the container is up; the second says the hostname
you put on the GitHub App form actually reaches it, which is the half that fails
silently until somebody tries to connect.

Within a minute the registration verifies. `1 created` followed by nothing else
means Initiative wrote the row and could not reach the app — check `base_url`
matches the service name.

### Step 6 — Install it in your guild

In Initiative: **guild settings → Apps**. *GitHub* is there; install it. Then
open its settings and fill in:

- **Owner or organization** — your GitHub username, or the org's name. Just the
  account: `octocat`, not `octocat/hello-world`.
- **Repositories** — comma-separated, or leave blank for every repository the
  installation covers.

Install **GitHub overview** the same way for a dashboard that already has the
four widgets on it.

### Step 7 — Install the GitHub App on your account

The half GitHub owns. Visit `https://github-app.example.com/install/github` and it
redirects to your app's install page — choose the account and which repositories
it may see.

Installing and authorizing are one trip here, so you will likely come back
already connected.

### Step 8 — Connect your account

If step 7 did not do it: in the app's settings in Initiative, **Your GitHub
account → Connect**. You are sent to GitHub, you authorize, you come back.

Every widget runs on *your* credential, so a member who has not connected sees
"connect your account" rather than somebody else's numbers, and what you see is
exactly what you can see at GitHub.

### When something is wrong

| What you see | What it means |
| --- | --- |
| Container exits immediately | A required setting is missing; the log names it. |
| `GITHUB_APP_PRIVATE_KEY is not a PEM private key` | The base64 lost a character, or you pasted the `.pem` path rather than its contents. |
| Registration stuck `pending` | Initiative cannot reach `base_url`, or the two secrets differ. |
| Every tile says *connect your account* | You have not connected, or the write-back failed — see the next row. |
| *Nearly there* after authorizing | GitHub authorized you and Initiative did not record it. Try again; nothing was lost. |
| Tile says *not installed* | Step 7 is not done for the account in step 6, or you left **Repositories** blank and the app is not installed anywhere. |
| Tile says *repository-required* | The install covers several repositories and the tile does not say which. Name one in the app's settings, or set `repo` on the dashboard tile. |
| `this database was built by a different version of src/db.ts` | Exactly that, caught at boot rather than by whichever query later touched the difference. There is no migration path: drop the app's database and let it be recreated. |
| Redirect mismatch at GitHub | `APP_PUBLIC_URL` and the Callback URL on the form disagree. They must match exactly, scheme and port included. |
| GitHub's *Recent Deliveries* shows red | `401` is the webhook secret differing between the form and the container. A timeout is the proxy: the Webhook URL does not reach port 8080. |


## License

MIT
