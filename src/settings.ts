/**
 * What a deployment has to supply, as data rather than as source to be read.
 *
 * Its own module for one reason: `config.ts` reads the environment at import,
 * so anything importing *that* to learn the setting names has to have the
 * environment already. This is the table alone, importable by a build script,
 * by a test, and by nothing that needs a running app.
 */

/**
 * Every setting this app reads, and whether it refuses to start without one.
 *
 * **This list is the contract, not a description of it.** The values below are
 * read *through* it — `required()` and `optional()` both look their name up
 * here and throw if it is absent — so a setting that exists in the code and not
 * in this table fails on the first boot rather than drifting quietly.
 *
 * That matters outside this repository. A deployment has to supply every
 * required name, and the chart that does is checked against this contract. The
 * check used to read `config.ts` and pull names out with a pattern, which
 * worked until a value was read through a helper instead of a literal call —
 * `GITHUB_APP_PRIVATE_KEY`, through `privateKey()` — and then reported a clean
 * bill for a chart that was missing a setting the container dies without. A
 * pattern over source code cannot see an indirection; a table can be published,
 * and `npm run env-contract` publishes this one.
 */
export const SETTINGS = {
  required: [
    "INITIATIVE_APP_SECRET",
    "INITIATIVE_BASE_URL",
    "APP_PUBLIC_URL",
    "DATABASE_URL",
    "APP_ENCRYPTION_KEY",
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_WEBHOOK_SECRET",
  ],
  optional: [
    "PORT",
    "INITIATIVE_APP_SETUP_TOKEN",
    "GITHUB_API_BASE",
    "GITHUB_WEB_BASE",
    "SYNC_INTERVAL_SECONDS",
  ],
} as const;
