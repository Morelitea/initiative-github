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
 *   * `APP_PUBLIC_URL` — where **a person's browser** reaches this app. Public
 *     by necessity: GitHub redirects a browser to it, and every URL on this
 *     app's GitHub App registration is built from it.
 *
 * This app mounts no embedded surface, so it has no third address for "where
 * the iframe loads" — an app that *does* embed needs one, and must not reuse
 * the server-to-server address for it. Initiative calls that one `embed_origin`
 * on the registration, and falls back to `base_url` when it is unset, which is
 * exactly how a cluster ends up framing an address no browser can resolve.
 *
 * **Two addresses at GitHub, as well**, for the same reason and less obviously.
 * `api.github.com` answers the API; `github.com` serves the pages a person is
 * sent to — authorize, install, and the token exchange behind them. On GitHub
 * Enterprise they are different hosts with different shapes, so an app that
 * hardcodes one and configures the other works everywhere except there.
 *
 * Everything without a default is required and fails loudly. A half-configured
 * app that starts and then refuses every call is harder to diagnose than one
 * that does not start.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required — see README.md`);
  }
  return value;
}

/**
 * A PEM private key out of an environment variable.
 *
 * GitHub hands you a `.pem` file and an environment variable is one line, so
 * the value arrives in one of three shapes depending on who wrote it: the real
 * thing with newlines, the same with `\n` typed literally, or base64 of the
 * whole file. All three are common enough that refusing two of them is a
 * deployment failure with a message about cryptography.
 */
function privateKey(name: string): string {
  const raw = required(name).trim();
  const pem = raw.includes("-----BEGIN")
    ? raw.replace(/\\n/g, "\n")
    : Buffer.from(raw, "base64").toString("utf-8");
  if (!pem.includes("-----BEGIN")) {
    throw new Error(
      `${name} is not a PEM private key — paste the .pem GitHub gave you, ` +
        "or base64 of it"
    );
  }
  return pem;
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
  publicUrl: required("APP_PUBLIC_URL").replace(/\/+$/, ""),

  /** Members' credentials and in-flight vendor handshakes live here. */
  databaseUrl: required("DATABASE_URL"),

  /** Seals members' credentials at rest. 32 bytes, base64. */
  encryptionKey: required("APP_ENCRYPTION_KEY"),

  github: {
    /**
     * The GitHub App's client id, which is two things at once.
     *
     * It identifies the app in the user-to-server flow, the way an OAuth app's
     * would — and it is also what the app signs its own JWT as. GitHub accepts
     * either the numeric app id or the client id as the `iss` claim and
     * recommends the client id, so this app needs only the one value and there
     * is no second id to get out of step with it.
     */
    clientId: required("GITHUB_CLIENT_ID"),
    clientSecret: required("GITHUB_CLIENT_SECRET"),

    /**
     * The private key GitHub generated for this app, and the thing that makes
     * it a GitHub App rather than an OAuth app.
     *
     * Everything the app does as *itself* is signed with this: a JWT good for
     * ten minutes, exchanged for an installation token good for one hour. It is
     * the one credential here that belongs to the app, and it authorizes
     * nothing on its own — an org that has not installed the app is unreachable
     * with it, and one that uninstalls becomes unreachable again.
     */
    privateKey: privateKey("GITHUB_APP_PRIVATE_KEY"),

    /**
     * What GitHub signs its deliveries with, typed once into the app's own
     * registration rather than into every repository. Required like everything
     * else here: the webhook route verifies against it on every delivery, so a
     * deployment missing it serves a route that can accept nothing.
     */
    webhookSecret: required("GITHUB_WEBHOOK_SECRET"),

    /** Where the API answers. */
    apiBase: (process.env.GITHUB_API_BASE ?? "https://api.github.com").replace(/\/+$/, ""),

    /** Where a person is sent — authorize, install, and the token exchange. */
    webBase: (process.env.GITHUB_WEB_BASE ?? "https://github.com").replace(/\/+$/, ""),
  },

  /**
   * How often to re-read which guilds have this app, in seconds.
   *
   * The lifecycle signal is the fast path; this is the floor under it. A signal
   * that arrives while this app is restarting is simply missed, and without a
   * poll that install stays unconfigured until something else moves.
   *
   * It is also the floor under the *GitHub* side: an org that installs the app
   * after an admin filled the form in sends no signal Initiative knows about,
   * so this poll is what turns that install from `invalid` to `ok`.
   */
  syncIntervalSeconds: Number(process.env.SYNC_INTERVAL_SECONDS ?? 300),
} as const;
