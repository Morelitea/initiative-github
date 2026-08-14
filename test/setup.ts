/**
 * What the app needs in its environment before anything imports `config.ts`.
 *
 * Configuration is read once at module load and fails loudly when something is
 * missing — which is the behaviour you want in production and the reason a test
 * importing any module that touches it has to have these set first. A setup
 * file runs before the test files, which is the only ordering that works here.
 *
 * `DATABASE_URL` is deliberately *not* defaulted: a test suite that quietly
 * pointed at some other database would be worse than one that refuses to start.
 * CI supplies it; locally, see README.md.
 */

process.env.INITIATIVE_APP_SECRET ??= "test-registration-secret";
process.env.INITIATIVE_BASE_URL ??= "https://initiative.test";
process.env.APP_PUBLIC_URL ??= "https://github-app.test";
// 32 bytes, base64 — the shape the real one has, and no more secret than any
// other value in a public test file.
process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.GITHUB_CLIENT_ID ??= "test-client-id";
process.env.GITHUB_CLIENT_SECRET ??= "test-client-secret";
process.env.GITHUB_WEBHOOK_SECRET ??= "test-webhook-secret";
