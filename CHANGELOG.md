# Changelog

## [Unreleased]

The app was registered, live, healthy — and could not be installed by anybody,
because it shipped no marketplace listing and nothing derives one from a served
manifest.

### Added

- Two catalog listings, built from the manifest by `npm run catalog` and
  attached to each release: the app itself, and **GitHub overview**, a companion
  dashboard shipping a ready-made arrangement of this app's three widgets. An
  operator publishes both by dropping them into their catalog directory.
- A catalog `uid`, carried by the served document as well as by the listings.
  Without one a registration verifies and names nothing, and a mandatory install
  is skipped as "has not verified yet".

### Fixed

- The served document carried no `uid`, so nothing tied the verified
  registration to a listing even once one existed.

### Changed

- Requires `initiative-app-kit` 0.4, for `appListing` and `dashboardListing`.

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
