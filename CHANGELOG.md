# Changelog

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
