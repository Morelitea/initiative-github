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

import { generateKeyPairSync } from "node:crypto";

process.env.INITIATIVE_APP_SECRET ??= "test-registration-secret";
process.env.INITIATIVE_BASE_URL ??= "https://initiative.test";
process.env.APP_PUBLIC_URL ??= "https://github-app.test";
// 32 bytes, base64 — the shape the real one has, and no more secret than any
// other value in a public test file.
process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.GITHUB_CLIENT_ID ??= "Iv1.testclientid";
process.env.GITHUB_CLIENT_SECRET ??= "test-client-secret";
process.env.GITHUB_WEBHOOK_SECRET ??= "test-webhook-secret";

// A real key rather than a placeholder, because the JWT this app signs with it
// is verified in `github-app.test.ts` — against the matching public half, which
// is the only way to prove the signing is actually RS256 over the right bytes.
// Generated per run: it authorizes nothing anywhere, and a key committed to a
// public repository would be a key somebody eventually pastes into a real app.
if (!process.env.GITHUB_APP_PRIVATE_KEY) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  // Kept beside it so the verifying test does not have to derive it.
  process.env.TEST_GITHUB_APP_PUBLIC_KEY = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
}
