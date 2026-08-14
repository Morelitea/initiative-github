/**
 * What the operator supplies, read once at boot.
 *
 * **Two addresses, and they are not the same one.** Conflating them is what
 * makes a cluster deployment hairpin out through its own ingress and back:
 *
 *   * `INITIATIVE_BASE_URL` — where **this server** reaches Initiative, to
 *     fetch the verification keys a context token is checked against. That is
 *     server-to-server, so in a cluster it belongs on the in-cluster Service
 *     and never depends on the public ingress being up.
 *   * `APP_PUBLIC_URL` — where **a person's browser** reaches this app, used to
 *     build the GitHub OAuth callback. Public by necessity: GitHub redirects a
 *     browser to it.
 *
 * This app mounts no embedded surface, so it has no third address for "where
 * the iframe loads" — an app that *does* embed needs one, and must not reuse
 * the server-to-server address for it. Initiative calls that one `embed_origin`
 * on the registration, and falls back to `base_url` when it is unset, which is
 * exactly how a cluster ends up framing an address no browser can resolve.
 *
 * Everything here is required and fails loudly. A half-configured app that
 * starts and then refuses every call is harder to diagnose than one that does
 * not start.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required — see README.md`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),

  /** The shared secret this app's registration was wired with. */
  appSecret: required("INITIATIVE_APP_SECRET"),

  /**
   * Server-to-server: where this app reaches Initiative — both to fetch the
   * verification keys a context token is checked against, and to make its own
   * signed calls back on the app-service channel.
   */
  initiativeBaseUrl: required("INITIATIVE_BASE_URL"),

  /** Browser-facing: where GitHub redirects a member back to. */
  publicUrl: required("APP_PUBLIC_URL"),

  /** Members' credentials and in-flight vendor handshakes live here. */
  databaseUrl: required("DATABASE_URL"),

  /** Seals members' credentials at rest. 32 bytes, base64. */
  encryptionKey: required("APP_ENCRYPTION_KEY"),

  github: {
    clientId: required("GITHUB_CLIENT_ID"),
    clientSecret: required("GITHUB_CLIENT_SECRET"),
    apiBase: process.env.GITHUB_API_BASE ?? "https://api.github.com",
    /**
     * What GitHub signs its deliveries with — the same value typed into each
     * repository's webhook settings. Required like everything else here: the
     * webhook route verifies against it on every delivery, so a deployment
     * missing it serves a route that can accept nothing.
     */
    webhookSecret: required("GITHUB_WEBHOOK_SECRET"),
  },

  /**
   * How often to re-read which guilds have this app, in seconds.
   *
   * The lifecycle signal is the fast path; this is the floor under it. A signal
   * that arrives while this app is restarting is simply missed, and without a
   * poll that install stays unconfigured until something else moves.
   */
  syncIntervalSeconds: Number(process.env.SYNC_INTERVAL_SECONDS ?? 300),
} as const;
