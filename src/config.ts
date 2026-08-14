/**
 * What the operator supplies, read once at boot.
 *
 * Two things this app never holds: a URL of its own (the platform's
 * registration says where this app lives, and the manifest carries paths), and
 * any credential belonging to a person other than through the vendor flow they
 * ran themselves.
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
   * The deployment calling this app. Used to fetch its verification keys and
   * as the only origin allowed to frame this app's pages.
   */
  initiativeBaseUrl: required("INITIATIVE_BASE_URL"),

  /** Where this app is reachable, for building the OAuth callback. */
  publicUrl: required("APP_PUBLIC_URL"),

  github: {
    clientId: required("GITHUB_CLIENT_ID"),
    clientSecret: required("GITHUB_CLIENT_SECRET"),
    apiBase: process.env.GITHUB_API_BASE ?? "https://api.github.com",
  },
} as const;
