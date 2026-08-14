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
cp .env.example .env      # fill in the secret, the base URL, and a GitHub OAuth app
npm install
npm run manifest          # validates, then writes manifest.json
npm test
npm run dev
```

Then an operator registers it: the deployment fetches
`/.well-known/initiative-app.json`, posts a challenge to `/v1/handshake`, and
both ends prove they hold the same secret without either sending it.

## What is deliberately simple here

The stores in `oauth.ts` and `workspace.ts` are in-memory maps. A real app has a
database; what a real app must keep is the *shape* — keyed by the opaque handle,
holding the vendor's credential and nothing about the person.

The issue counts come back as a single number because that is what the widget
draws. Sending the vendor's whole payload would put data nobody renders into a
cache and into a browser.

## License

MIT
