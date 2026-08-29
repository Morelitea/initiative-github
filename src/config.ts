export const SETTINGS = {
  required: [
    "INITIATIVE_APP_SECRET",
    "INITIATIVE_BASE_URL",
    "APP_PUBLIC_URL",
    "DATABASE_URL",
    "APP_ENCRYPTION_KEY",
  ],
  /**
   * What GitHub gives you when the app is registered there.
   *
   * Not required at boot, and that is the whole point: an app cannot be asked
   * to hold the credentials for a registration it has not made yet. Without
   * them this one starts, answers nothing GitHub-shaped, and serves the single
   * route that creates the registration — see `INITIATIVE_APP_SETUP_TOKEN`.
   *
   * Every one of them is checked before anything reaches GitHub, so the state
   * is "not registered" rather than "half configured".
   */
  registration: [
    "GITHUB_CLIENT_ID",
    "GITHUB_CLIENT_SECRET",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_WEBHOOK_SECRET",
  ],
  optional: [
    "PORT",
    "GITHUB_API_BASE",
    "GITHUB_WEB_BASE",
    "SYNC_INTERVAL_SECONDS",
    // Opens the registration route, and is the only thing that does. Set it to
    // register, then take it away.
    "INITIATIVE_APP_SETUP_TOKEN",
  ],
} as const;

type Required = (typeof SETTINGS.required)[number];
type Registration = (typeof SETTINGS.registration)[number];
type Optional = (typeof SETTINGS.optional)[number];

function required(name: Required): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required — see README.md`);
  }
  return value;
}

function optional(name: Optional): string | undefined {
  return process.env[name] || undefined;
}

function given(name: Registration): string {
  return (process.env[name] ?? "").trim();
}

function withoutTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

function privateKey(name: Registration): string {
  const raw = given(name);
  if (!raw) return "";

  const pem = raw.includes("-----BEGIN")
    ? raw.split("\\n").join("\n")
    : Buffer.from(raw, "base64").toString("utf-8");
  if (!pem.includes("-----BEGIN")) {
    throw new Error(
      `${name} is not a PEM private key — paste the .pem GitHub gave you, ` +
        "or base64 of it"
    );
  }
  return pem;
}

function read() {
  return {
    port: Number(optional("PORT") ?? 8080),

        appSecret: required("INITIATIVE_APP_SECRET"),

        initiativeBaseUrl: required("INITIATIVE_BASE_URL"),

        publicUrl: withoutTrailingSlash(required("APP_PUBLIC_URL")),

        databaseUrl: required("DATABASE_URL"),

        encryptionKey: required("APP_ENCRYPTION_KEY"),

    github: {
            clientId: given("GITHUB_CLIENT_ID"),
      clientSecret: given("GITHUB_CLIENT_SECRET"),

            privateKey: privateKey("GITHUB_APP_PRIVATE_KEY"),

            webhookSecret: given("GITHUB_WEBHOOK_SECRET"),

      /**
       * Whether this deployment has a registration at all.
       *
       * All four or none: a deployment holding three of them cannot sign, and
       * an app that discovered that one route at a time would fail differently
       * on each. Read once, so every GitHub-shaped route can refuse in the
       * same words and point at the one that fixes it.
       */
      registered:
        SETTINGS.registration.every((name) => given(name) !== "") &&
        privateKey("GITHUB_APP_PRIVATE_KEY") !== "",

            apiBase: withoutTrailingSlash(optional("GITHUB_API_BASE") ?? "https://api.github.com"),

            webBase: withoutTrailingSlash(optional("GITHUB_WEB_BASE") ?? "https://github.com"),
    },

        syncIntervalSeconds: Number(optional("SYNC_INTERVAL_SECONDS") ?? 300),
  } as const;
}

type Config = ReturnType<typeof read>;

let cached: Config | null = null;

// Read on first use for the same reason the pool is opened on first use. Still
// loud and still at boot, because the server reads config before it listens.
export const config: Config = new Proxy({} as Config, {
  get(_target, key) {
    cached ??= read();
    return cached[key as keyof Config];
  },
});
