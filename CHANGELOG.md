# Changelog

## [Unreleased]

It is a GitHub App now, rather than an OAuth app calling itself one. That is a
second registration with its own audience — an organization owner rather than a
guild admin — and everything below follows from having one.

### Added

- **Writes at GitHub** (`src/operations.ts`, `src/github/operations.ts`). Seven
  operations — open an issue, comment, close, reopen, label, request a review,
  move a card on a Projects v2 board — exposed at `/v1/operations` and run for a
  delegate that proves itself the same way a subscriber does.

  The app does the writing because the app holds the credential. An automation
  service holding GitHub tokens would be a second place they can leak from and
  a second thing to reason about when revoking; keeping them here means an
  organization's own installation grant is the whole of what any automation can
  do at GitHub.

  **The set is closed.** A caller picks from operations written in this repo and
  never describes a request the app performs — the difference between an
  integration and a proxy.

  **The write runs as the member wherever there is one.** A delegation token
  names its member by a pairwise subject that means nothing in this app's
  namespace; Initiative resolves it to one of the app's *own* connection refs —
  the same handle a context token hands over on the read path — so the write
  runs on that member's credential and the app learns no more about them than it
  ever did. Where there is no such member an operation may act as the app
  instead, and the response always says which happened. `request-review` refuses
  rather than substituting: a review request from the app is not a request from
  a colleague.
- **A producer surface** (`src/events.ts`, `src/github/events.ts`), and with it
  the `events` feature. This app publishes three types — an issue opened, an
  issue closed, a review requested — **directly** to whoever subscribed, on the
  shapes `initiative-app-kit` fixes rather than shapes this app invented.
  Nothing about the dashboard depends on any of it: a guild with no automation
  service gets exactly the same widgets.

  Producing directly is the whole design and not an optimization. Posting the
  event to Initiative to fan out cannot work — the vocabulary a webhook
  subscription may name is derived from Initiative's own content tables, so
  nothing can name `app.<id>.<event>` and the dispatcher matches nothing. An
  app already holds its vendor's webhook connection and has already verified its
  vendor's signature; routing the result through a third party adds a hop and a
  place to be dropped.
- Three routes for a subscriber: `GET /v1/events` for what this app produces,
  and `POST`/`GET`/`DELETE` under `/v1/events/subscriptions`. Authorized by a
  delegation token — an app the operator granted `delegation` to, proving
  itself against a key the deployment publishes — which names one guild, so a
  subscription cannot be made for a guild nobody authorized. The token is spent
  once, in the database rather than in a process, so the rule survives a second
  replica.
- Two tables behind that: `event_subscriptions`, whose secret is sealed at rest
  like a member's credential, and `delegation_tokens`, whose primary key *is*
  the one-shot check.
- `issues` and `pull_request` on the GitHub App registration, derived from the
  translator so an event handled in code cannot go missing from the form.
  Neither costs a permission: a webhook event is not one, and both are covered
  by the reads the widgets already need.
- A GitHub App registration, generated from the code that uses it
  (`src/github/registration.ts`, `npm run github-app`). The permissions and the
  webhook events on it are the ones this app actually asks for and actually
  handles, and `test/github-app.test.ts` is what keeps that true. A registration
  typed into a form drifts in two directions that both look like nothing
  happening: an event nobody subscribed to never arrives, and a permission
  nobody uses is granted by every organization forever.
- The app's own identity at GitHub (`src/github/app.ts`): a JWT signed with the
  private key, exchanged for an installation token that lasts an hour and is
  held in memory only.
- `/install/github`, which redirects to this registration's install page —
  derived from the slug GitHub reports for the private key, so it cannot name a
  different app from the one running. And `/setup/github`, where GitHub returns
  somebody afterwards. It deliberately reports nothing about the installation it
  was handed: the redirect carries an `installation_id` and no proof of
  anything.
- PKCE on the member's flow, so an authorization code caught in a redirect
  cannot be exchanged by whoever caught it.
- One-click registration of the GitHub App itself, at `/setup/github/register`
  (`src/github/setup.ts`). It posts the generated manifest to GitHub and shows
  the four credentials once; nothing is stored, so `config.ts` keeps its promise
  that credentials are read at boot and a running deployment's identity cannot
  be changed by reaching a URL. Off unless `INITIATIVE_APP_SETUP_TOKEN` is set, and
  `404` rather than `403` when it is not — a route that answers differently once
  a feature is configured tells an unauthenticated caller which deployments to
  return to. The return leg cannot be guarded by the token, since GitHub sends
  only a code and a `state`, so the state is signed with the token: rotating it
  ends every flow it authorized.
- `installation` and `installation_repositories` deliveries re-sync the installs
  they affect, so an organization installing or removing the app is reflected in
  Initiative within seconds rather than at the next poll. They are published to
  nobody: no consumer asked to hear that somebody clicked a button.
- **Dependabot alerts**, as a guild-scoped source and a fourth widget: open
  alerts by severity, worst first, answered from the installation. The tier
  matters more here than anywhere else — the people who most need to see how
  exposed a repository is are the ones least likely to have connected a personal
  GitHub account. It arrives with the `vulnerability_alerts: read` permission
  that reads it, which is the rule the permission list follows: a permission
  with no feature behind it is one an organization grants for nothing, and a
  reviewer cannot tell "not used yet" from "used for something not described".
  Note the key — the permission is called *Dependabot alerts* everywhere a
  person reads it and `vulnerability_alerts` everywhere a machine does, and
  GitHub does not complain about the wrong one; it grants nothing.
- `GITHUB_WEB_BASE`, beside the API base it always had. On GitHub Enterprise the
  API and the pages a person visits are different hosts, so configuring one and
  hardcoding the other worked everywhere except there.
- Two catalog listings, built from the manifest by `npm run catalog` and
  attached to each release: the app itself, and **GitHub overview**, a companion
  dashboard shipping a ready-made arrangement of this app's three widgets. An
  operator publishes both by dropping them into their catalog directory. The app
  was registered, live, healthy — and could not be installed by anybody, because
  nothing derives a listing from a served manifest.
- A catalog `uid`, carried by the served document as well as by the listings.
  Without one a registration verifies and names nothing, and a mandatory install
  is skipped as "has not verified yet".

### Removed

- **The automation surface.** Two trigger nodes, a `create-issue` action, and
  AUTOMATION.md. A node an app contributes is a thing that executes inside
  somebody's deployment, and that stays first-party — an app declares what its
  vendor did and stops there. `automations` is not a feature this app declares.

### Fixed

- **A member who connected their GitHub account was still told to connect, by
  every tile, forever.** The app stored the credential and never told Initiative
  it had one.

  The platform decides whether a per-member connection may be used from its own
  record — `is_satisfied` reads what is stored *against the connection*, and a
  connection declaring no fields is never satisfied by anything. `account`
  declared `fields: []`, so there was nothing to store and nothing to satisfy
  it, and the write-back that would have stored it was never called.

  Three things close it: `account` declares one `managed` field carrying the
  GitHub login — not the token, which stays sealed here — the callback writes
  it back, and the guild id needed to address that write is carried from the
  handoff through `oauth_states` rather than read off a callback GitHub
  controls. A credential that later lapses is now reported too, so the platform
  stops showing somebody as connected while every call fails.

  It predates this release and only broke `review-queue`, which is why it was
  not noticed; moving every source onto the same gate made it total.

### Changed

- **Every source runs on the caller's own GitHub credential.** Not the
  organization's installation. A member sees exactly what they can see at
  GitHub, and every source and widget now names `account` in `requires`.

  Two of these were guild-scoped and it read as generous: nobody had to connect
  an account to see how many issues were open. It is the wrong shape. That
  number is the state of a private repository, and answering it from the
  organization's grant shows it to every member of a guild including the ones
  with no access to the repository at all. The app is not in a position to
  judge — a context token names a guild and an install and nothing about what
  this person may reach — so it stops judging and lets GitHub's own permissions
  decide.

  What it costs, stated rather than discovered: every member must connect before
  any tile answers; the platform caches per member rather than once per guild,
  so one upstream call becomes one per person; and Dependabot alerts show only
  to members with security access on the repository. All three are the principle
  working.
- **Resolving which repository no longer asks GitHub, where the guild said.**
  An install that named its repositories resolves from its own list — no
  installation token, no page walk, and a working dashboard before an
  organization owner has installed the app. Blank still means "everything the
  organization granted", which only the installation can enumerate. An install
  that named repositories is no longer reported `github_app_not_installed`,
  because its tiles answer; what still waits on the installation is the webhook.
- **`GITHUB_APP_SETUP_TOKEN` is now `INITIATIVE_APP_SETUP_TOKEN`**, and the gate
  behind it moved to `initiative-app-kit`. Nothing about "an operator needs a
  one-time, self-gated bootstrap page" is GitHub-shaped: any app with a
  per-deployment vendor registration needs the same switch and the same signed
  return leg, so an operator should learn one name rather than one per
  integration.

  It also holds **more than one** token now, comma or space separated. The state
  that carries authority across the vendor's redirect is signed by whichever
  token opened the flow, so letting a second operator in — or replacing a token
  — ends exactly the flows that token authorized and leaves the rest running.
- **Every regular expression is gone**, from this app and from the kit. Three of
  them were wrong, in the way patterns are: the public-id check accepted `a..b`
  because a character class cannot say a label is non-empty; the private-address
  check saw `127.0.0.1` but not `0177.0.0.1` or `2130706433`; and the IPv6 check
  matched text that `URL` had already normalized away, so `::ffff:127.0.0.1`
  read as public. Addresses now go through `node:net` and byte comparison, and
  identifier checks read a character at a time.

  `escapeHtml` was four chained passes over a string each had already changed —
  correct only because `&` happened to be first. It is one pass over a table.
- **The permission list widened, deliberately and once.** `issues` and
  `pull_requests` went to `write`, and `organization_projects: write` is new.
  Widening is the one direction GitHub charges for — every organization that has
  already installed the app keeps the old grant until somebody re-approves — so
  it is worth doing in one go rather than in pieces, and worth doing before
  anybody has installed it. `organization_projects` is the only permission here
  that reaches past a repository, because a Projects v2 board does; there is no
  repository-scoped equivalent to prefer instead, and `repository_projects` is
  the older classic board rather than a narrower version of the same thing.
- **An install covers repositories, not a repository.** The `workspace`
  connection now takes an account and an optional list, where blank means every
  repository the installation covers — the organization already chose when it
  installed the app, and asking an admin to restate that is two copies of one
  decision. Every source takes a `repo` parameter, so a dashboard says which one
  a tile is about; since dashboards are initiative-scoped, binding it there is
  what pins one team to one repository. The app enforces "inside what the
  organization granted" and cannot enforce "inside what this team may see" —
  a context token names a guild and an install and nothing finer, so what holds
  that boundary is who may edit the dashboard.
- Sources narrow further from the same place: `milestone` and `assignee` on
  `open-issues`, `label` on `issue-throughput`, a severity floor on
  `dependabot-alerts`. The platform caches per parameter set, so two teams' tiles
  are one source answered twice rather than one answer shared.
- Every published event carries `repository` and `owner`. An app event names no
  initiative — there is nothing in a GitHub delivery that could say which one —
  so a payload field is the only thing a consumer can narrow by, and these are
  part of the pinned definition a guild installed: widening them later is a
  version every guild has to take.
- An installation is discovered from the **account** rather than from one
  repository — one grant covers every repository the organization chose, so
  asking per repository was one call per repository to learn the same id.
- A delivery is matched to installs by the installation that produced it, then
  narrowed by the guild's list. An owner is a string an admin typed and a
  repository can be renamed or transferred under one; the installation is a
  fact GitHub asserts. An `installation.created` delivery names an installation
  nothing has recorded yet, so that one is matched by account instead — which is
  exactly the guild sitting at `github_app_not_installed` waiting for it.
- **The guild's access is the organization's installation, not a token an admin
  pasted.** The `shared_account` connection is gone. An admin fills in the
  repository — the thing they were always going to fill in — and the app asks
  GitHub which installation covers it. A personal access token was a *person's*
  credential wearing the guild's name: it carried everything that person could
  reach, outlived their interest in the guild, and revoking it meant finding
  whoever minted it. An installation is listed in the organization's own
  settings, scoped to the repositories it picked, and revoked by a button that
  belongs to it.
- An install whose repository nobody has installed the app on reports
  `github_app_not_installed` rather than looking unconfigured. It is a different
  problem with a different owner.
- A member's credential is a rotating pair. A GitHub App's user token lasts
  eight hours; it is renewed on use, under a row lock, because refresh tokens
  are single-use and two replicas renewing at once would have one of them
  overwrite a good credential with nothing.
- No scopes on the member's flow. A GitHub App's user token carries the
  installation's permissions narrowed to what that member already reaches, so
  `read:user repo` had nowhere to land.
- One webhook, on the registration, covering every organization that installs
  the app — instead of one added by hand to every repository a guild configured,
  which silently received nothing from the one somebody forgot.
- Requires `initiative-app-kit` 0.5, for the producer surface and delegation
  verification.

### Fixed

- The served document carried no `uid`, so nothing tied the verified
  registration to a listing even once one existed.
- The GitHub registration's `redirect_url` pointed at the member's OAuth
  callback. It is not that URL: `redirect_url` is where GitHub returns the
  *operator* once, after a manifest creates the app — a different audience and a
  different moment from `callback_urls` and `setup_url`. All three are "where
  GitHub sends somebody afterwards", which is why they get conflated, and each
  one fails only when somebody happens to exercise that path.
- All three widgets required a member's personal account while only one of their
  sources did, so two tiles refused with `CONNECTION_REQUIRED` for every member
  who had not connected one — to draw numbers that never needed them. 0.3.0
  fixed this on the sources and left the widgets behind, which changed nothing
  anybody could see. `test/manifest.test.ts` now checks a widget against its own
  sources.

## [0.3.0]

Scoping. Every source now runs at the narrowest level that answers it, rather
than asking every member for a personal GitHub account to read a number that is
the same for the whole guild.

### Added

- A `shared_account` guild connection: one token an admin supplies, used for
  everything the whole guild sees the same answer to. A fine-grained token with
  `Issues: read` on the repository is enough.
- Held in memory rather than written down. It is Initiative's credential, lent
  on each configuration pull, so clearing the field, switching the app off or
  uninstalling stops it on the next pull — with tests for each of those.

### Changed

- `open-issues` and `issue-throughput` are answered from the guild's shared
  access. Neither has a per-person component, and naming no per-member
  connection also means the platform caches each **once per guild** instead of
  once per member — twenty people on a dashboard is now one upstream call.
- `review-queue` and the `create-issue` action stay per member, which is the
  only thing they can be: one is "waiting on my review", the other opens an
  issue under somebody's name.
- Connecting a personal GitHub account is now optional. A member who never does
  still sees the repository widgets.

### Fixed

- The well-known document now carries the envelope a registrar requires, so the
  app registers at all. Nothing it declares has changed. Released as 0.2.1.
- All three sources declared `requires: { all_of: ["workspace", "account"] }`,
  so every widget refused with `CONNECTION_REQUIRED` until each member had
  personally authorized — including the two that show identical numbers to
  everyone.

## [0.2.1]

The same fix as above, on top of 0.2.0, so an app that could not be registered
did not have to wait for the next feature.

### Fixed

- The well-known document now carries the envelope a registrar requires.

## [0.2.0]

The app talked about its installs without ever asking about them. It now holds
both halves of the conversation.

### Added

- A GitHub webhook receiver at `/webhooks/github`, verified against
  `GITHUB_WEBHOOK_SECRET`. An opened issue, a closed issue and a requested
  review become the events the manifest declares, in every guild whose install
  names that repository — the trigger nodes had nothing emitting to them.
- An install reconcile: which guilds have this app, and what each configured,
  read from Initiative at boot and on an interval as well as on the lifecycle
  signal. A signal that arrives during a restart is gone, so the poll is what
  makes it recoverable.
- The app's verdict on the configuration it was handed is reported back, so an
  admin who typed a repository this app cannot see sees that beside the install
  rather than three widgets saying "unavailable".

### Fixed

- Nothing ever pulled an install's configuration, so `workspaces` was never
  written and every data source and the create-issue action answered
  "not configured" indefinitely.
- The lifecycle signal was accepted and discarded.
- The README and package description still described an embedded page, which
  this app deliberately does not have.

### Changed

- Requires `initiative-app-kit` 0.2, for its signed channel client.

## [0.1.0]

First release: a deployable service rather than a sketch.

### Added

- Data sources, widgets, events and automation descriptors for GitHub issues
  and reviews, with per-member connections and one guild-scoped setting.
- Postgres for members' credentials, in-flight vendor handshakes and per-install
  configuration, so a restart keeps connections and more than one replica works.
- Credentials sealed at rest with AES-256-GCM under `APP_ENCRYPTION_KEY`.
- A container image published to `ghcr.io/morelitea/initiative-github` on tag,
  for `linux/amd64` and `linux/arm64`.
- `/healthz` and `/readyz`, and a graceful shutdown that finishes in-flight
  requests before the pool closes.

### Notes

- The automation block is a contract for the automation service to be built
  against; that service's half is not built yet. See `AUTOMATION.md`.
