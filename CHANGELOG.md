# Changelog

## [Unreleased]

It is a GitHub App now, rather than an OAuth app calling itself one. That is a
second registration with its own audience — an organization owner rather than a
guild admin — and everything below follows from having one.

### Added

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
- `installation` and `installation_repositories` deliveries re-sync the installs
  they affect, so an organization installing or removing the app is reflected in
  Initiative within seconds rather than at the next poll. They emit nothing:
  nobody subscribed to hear that somebody clicked a button.
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

### Changed

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
- Requires `initiative-app-kit` 0.4, for `appListing` and `dashboardListing`.

### Fixed

- The served document carried no `uid`, so nothing tied the verified
  registration to a listing even once one existed.
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
