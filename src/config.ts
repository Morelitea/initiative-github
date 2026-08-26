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
    "GITHUB_API_BASE",
    "GITHUB_WEB_BASE",
    "SYNC_INTERVAL_SECONDS",
  ],
} as const;

type Required = (typeof SETTINGS.required)[number];
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

function withoutTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "/") end -= 1;
  return value.slice(0, end);
}

function privateKey(name: Required): string {
  const raw = required(name).trim();

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
            clientId: required("GITHUB_CLIENT_ID"),
      clientSecret: required("GITHUB_CLIENT_SECRET"),

            privateKey: privateKey("GITHUB_APP_PRIVATE_KEY"),

            webhookSecret: required("GITHUB_WEBHOOK_SECRET"),

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
