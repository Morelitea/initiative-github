# initiative-github

Brings a repository's issues, reviews and dependency alerts into
[Initiative](https://github.com/Morelitea/initiative) as dashboard widgets, and
lets an automation act on that repository as the person whose automation it is.

An organization grants it twice, on GitHub's own pages: **which permissions**
it has, and **which repositories** they apply to — all of them, or a list you
pick. That grant is the boundary, and this app cannot widen it from here.

Inside it, two credentials do two jobs. Anything about *you* — your review
queue, an issue you open — runs on **your own GitHub credential**, so it shows
exactly what you can see and is attributed to you. Anything about the
repository runs on the installation, so a dashboard answers for everyone in the
guild without each person having to sign in first.

```
ghcr.io/morelitea/initiative-github:latest
```

## What a guild gets

| | |
|---|---|
| **Eleven reads** | Repositories · labels · one issue · find issues · one pull request · find pull requests · Dependabot alerts · project boards · a board's fields · a field's values · an issue's card. |
| **Seven writes** | Open an issue, comment, close, reopen, label, request a review, move a Projects v2 card — each performed as the member whose automation asked for it. |
| **Three announcements** | An issue opened, an issue closed, a review requested. |
| **Four widgets** | Open issues · pull requests waiting on your review · Dependabot alerts by severity · a fortnight of opens against closes. |
| **A ready-made dashboard** | *GitHub overview*, arranging all four so there is something to look at without assembling it. |

All twenty-one are **endpoints**: one list this app declares, one address they
are called at, and the id says which one you want. A widget filling a tile and an
automation asking the app to act reach the same surface, and what separates them
is who they prove themselves as.

Five of the reads do a second job: they are what a caller **fills a picker**
from. `list-repositories`, `list-labels`, `list-projects`,
`list-project-fields` and `list-project-options` answer "which repositories can
you see", "which labels does it have", and the board → field → value chain — so
a consumer building a form has a list rather than a text box, and each step of
the chain takes the one above it.

The manifest says nothing about that, deliberately. What a step looks like on
somebody's canvas is their product and their decision; this app's job is to
make sure the read they need exists and answers honestly.

A read is a question at GitHub rather than the shape of a tile — the
repository's own vocabulary, narrowed by what GitHub narrows it by. So a step in
somebody's automation gets the number to act on, the state to branch on and the
node id the next call needs, and a widget draws from the same endpoint and does
its own narrowing in its own module. There is no private half only a widget can
use.

Each one says what it is, what it hands back and which drawer it belongs in, in
four languages. So an automation service can offer them by name rather than by
id, and can wire the issue one step just opened into the step after it — without
anybody having to fire one to find out what comes back.

The three under Projects v2 are the exception worth knowing: a board is not part
of a repository, most repositories have none, and nothing else here depends on
them. They exist because moving a card takes four node ids and there was
nowhere to get one.

The widgets need nothing but this app. The writes and the announcements exist
for an automation service to use, and a guild without one gets the same
dashboard.

## It is installed twice, in one trip

Two places, and the second is reached from the first. A guild admin installs the
app from the marketplace and presses **Connect** on its GitHub organization,
which opens GitHub's own install page: they choose the account and tick which
repositories the app may see, and come back to a guild that is set up.

| | In Initiative | At GitHub |
|---|---|---|
| **Who** | a guild admin, from the marketplace | the same admin, if they own the account — otherwise somebody who does |
| **Says** | which installation is this guild's | what this app may do, which repositories it may see, and where deliveries come from |
| **Undone by** | uninstalling in Initiative | uninstalling at GitHub |

The repositories are chosen at GitHub, on the page that grants them, and they
stay GitHub's answer: this app writes down the account and the installation, and
asks the installation itself what it covers. So the boundary every call is
checked against is the set of boxes somebody ticked, and adding one later needs
nothing here at all.

There are two credentials in play and they do different jobs, which is why both
halves exist:

| | comes from | answers |
|---|---|---|
| **the installation** | this app's own key, no authorization anywhere | what the organization granted — which repositories, and where deliveries come from |
| **a member's account** | that person authorizing, in step 7 | who is asking, so a tile shows *your* review queue and a write is attributed to you |

Neither substitutes for the other. An installation token acts as the app and
never as a person, so it cannot resolve *your* anything; a member's token
reaches only what that member reaches. Step 6 below is the first half.

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

You do not fill in a form. GitHub takes the registration as a document, and this
app generates it from the same constants the code runs on — so the callbacks,
the setup URL, the webhook, the permissions and the events cannot disagree with
what the code expects.

**From the running app.** Set one variable and open one link:

```bash
INITIATIVE_APP_SETUP_TOKEN=$(openssl rand -hex 32)
```

The app starts with no GitHub credentials at all, refuses every GitHub-shaped
route, and serves exactly one thing:

```
https://github-app.example.com/setup/register?token=THE-TOKEN
```

Add `&org=your-org` to register it in an organization instead of your own
account. GitHub shows you the registration with every field already filled in;
press **Create GitHub App**, and the four values appear on the page.

**Or from a checkout**, if you would rather not put a token on the workload:

```bash
APP_PUBLIC_URL=https://github-app.example.com npm run register
```

Same flow, same document, redirected to a listener on localhost. `GITHUB_APP_ORG`
targets an organization.

Either way you end up with:

```
GITHUB_CLIENT_ID=…
GITHUB_CLIENT_SECRET=…
GITHUB_WEBHOOK_SECRET=…
GITHUB_APP_PRIVATE_KEY=…
```

Put them where this deployment reads its settings and restart it. **GitHub will
not show them again**, and the app has not kept a copy — they are what it reads
at boot, so there is nowhere for it to keep one.

> **Then take the token away.** For as long as `INITIATIVE_APP_SETUP_TOKEN` is
> set, whoever holds it can create a GitHub App in the account they are signed
> into. The route 404s without it — not 403, so it does not advertise itself —
> and an app that has registered has no further use for it.

Registering by hand still works if you want to see what is being asked for:
`npm run github-app` prints the same registration as a form. The two that catch
people out are on that path only — *Request user authorization during
installation* must be **off**, and there are **two** callback URLs.

## Step 2 — Generate the shared secrets

Four came from step 1. These are the ones this deployment makes for itself:

```bash
openssl rand -hex 32                          # → GITHUB_APP_SECRET
openssl rand -base64 32                       # → GITHUB_ENCRYPTION_KEY
openssl rand -hex 16                          # → GITHUB_DB_PASSWORD
openssl genrsa 2048 > platform-signing.pem    # Initiative's app-platform key
```

Put all of it in the `.env` beside your `docker-compose.yml`:

```bash
GITHUB_APP_SECRET=REPLACE-with-the-first-openssl-output
GITHUB_ENCRYPTION_KEY=REPLACE-with-the-second-openssl-output
GITHUB_DB_PASSWORD=REPLACE-with-the-third-openssl-output
GITHUB_APP_PUBLIC_URL=https://github-app.example.com

# these four came out of `npm run register`, ready to paste
GITHUB_CLIENT_ID=…
GITHUB_CLIENT_SECRET=…
GITHUB_WEBHOOK_SECRET=…
GITHUB_APP_PRIVATE_KEY=…
```

Every value here is one only you have. Nothing in this repository ships a
working secret.

> If you registered by hand instead, the private key downloads as a `.pem` and
> an environment variable is one line — `base64 -w0 your-app.private-key.pem`
> is what goes in `GITHUB_APP_PRIVATE_KEY`. A real PEM, or one with `\n` typed
> literally, also work.

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

## Step 6 — Install it in your guild, and at GitHub

In Initiative: **guild settings → Apps**. *GitHub* is there; install it, then open
its settings and press **Connect** on *GitHub organization*.

That opens GitHub's own install page in a new tab. Choose the account — yours or
an organization's — and pick which repositories this app may see. Only somebody
who owns that account can finish it; if that is not you, GitHub raises a request
for an owner to approve, and the tab says so rather than reporting a failure.

GitHub then asks you to authorize, which looks like a second step and is a
different question: the first said *what may this app reach*, and this one says
*who is claiming it*. GitHub hands an app the installation's id in a URL and
documents that it must not be believed, so this checks the claim against the
installations GitHub says you actually hold. The token that answers is spent on
that one question and dropped — nothing about you is stored, and this is not
the same as connecting your account in step 7.

Then you are done, and there is nothing to type. The app writes down the
account and the installation; what that installation covers it reads from
GitHub, every time it syncs, so the boundary is the repositories you ticked and
stays that way without anybody maintaining a copy.

> Pressing **Connect** again is how you move to a different account. Adding or
> removing repositories does not need it — do that at GitHub, on the app's
> *Configure* page, and it arrives here on its own.

Install **GitHub overview** the same way for the ready-made dashboard. Its
four tiles arrive pointed at no repository, and each one is pointed at one
where it sits — the tile's `repo`, chosen from what `list-repositories`
answers for your own installation. A tile that has not been pointed anywhere
says so rather than showing a number.

That is deliberate, and it applies to an install covering one repository as
much as to an install covering forty. This app used to fill a blank `repo` in
with the only repository an installation had, which read as convenience and was
a trap: the tile went on being right until the day somebody ticked a second box
at GitHub, and then stopped, having never said what it was about. Four tiles
and one choice each is the cheaper end of that trade — and it is what lets one
canvas put two repositories side by side.

## Step 7 — Connect your account

Separate from step 6, and everybody does it for themselves: in the app's
settings, **Your GitHub account → Connect**. You are sent to GitHub, you
authorize, and Initiative tells you how it went — this app hands you back rather
than writing that page itself, so you read it in your own language.

What Initiative is told is that you authorized, and nothing else. Your GitHub
account is not asked for and not written down: the credential is sealed in this
app's own database, filed under a handle that says nothing about you, and the
connection is satisfied by a yes. A guild admin can see that you connected and
can end it; they cannot see which GitHub account you connected as, because
nothing on that side holds it.

The admin who installed the app is not exempt. Installing grants what the app
may reach; authorizing says who is asking. Nothing this app shows or does runs
as the installation, so a member who has not connected has not yet given it
anything to answer with.

You do not have to, and the dashboard works either way. A tile about the
repository — open issues, Dependabot alerts, throughput — is answered on the
installation, so it says the same thing to everyone in the guild whether or not
they have connected. Connecting changes two things: a tile about *you* becomes
possible at all (your review queue has no answer without a you), and everything
is answered as you instead — so you see exactly what you can see at GitHub,
which for a guild whose installation covers repositories you cannot open is a
narrower and more honest number.

Writes are always yours. Nothing this app does to a repository is ever
attributed to the app.

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
| *Nearly there* after authorizing | GitHub authorized you and Initiative did not record it. Connect again; nothing was lost. |
| Tile says *not configured* | The install at GitHub was never finished, or was cleared. Press **Connect** on *GitHub organization* in step 6. |
| *Waiting on an owner* after installing | You do not own that account, so GitHub raised a request instead. Nothing is wrong; press **Connect** again once an owner approves it. |
| *Not connected* right after choosing an account | GitHub did not agree the installation you came back naming is one you hold. Start again from **Connect** rather than reusing the link. |
| Tile says *choose a repository* | The tile does not say which repository it is about, which every tile has to. Set `repo` on it — the values are what `list-repositories` answers. Nothing is inferred, including on an install covering exactly one. |
| Tile says *a repository the install does not cover* | The tile's `repo` is not one the installation covers. Add it at GitHub and it arrives within a sync, or fix the tile. |
| Events never arrive | The install at GitHub in step 6 did not finish, or was removed there. Widgets run on members' own credentials and work without it; deliveries do not. |
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
