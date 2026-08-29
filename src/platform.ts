import {
  ChannelError,
  Emitter,
  mintSubscriptionSecret,
  parseSubscribe,
  type DeliveryOutcome,
  type Emission,
  type InstallConfig,
  type Subscription,
} from "initiative-app-kit";

import { config } from "./config.js";
import { initiative } from "./initiative.js";
import { pool, open, seal } from "./db.js";
import { ENDPOINTS } from "./endpoints/index.js";
import { installationById, installationRepositories } from "./github/app.js";
import { PUBLIC_ID } from "./vocabulary.js";
import {
  forgetInstallsExcept,
  forgetWorkspace,
  installsForInstallation,
  rememberWorkspace,
} from "./workspace.js";

interface Row {
  id: string;
  guild_id: string;
  subscriber: string;
  target_url: string;
  secret: string;
  endpoints: string[];
}

function toSubscription(row: Row): Subscription {
  return {
    id: Number(row.id),
    guildId: Number(row.guild_id),
    subscriber: row.subscriber,
    targetUrl: row.target_url,

    secret: open(row.secret) ?? "",
    endpoints: row.endpoints,
  };
}

async function matching(guildId: number, endpoint: string): Promise<Subscription[]> {
  const found = await pool.query<Row>(
    `SELECT id, guild_id, subscriber, target_url, secret, endpoints
       FROM subscriptions
      WHERE guild_id = $1 AND $2 = ANY(endpoints)`,
    [guildId, endpoint]
  );

  return found.rows.map(toSubscription).filter((sub) => sub.secret !== "");
}

const emitter = new Emitter({ publicId: PUBLIC_ID, store: { matching } });

export async function publish(emission: Emission): Promise<DeliveryOutcome[]> {
  try {
    return await emitter.publish(emission);
  } catch (error) {
    console.error(`could not publish ${emission.endpoint}`, error);
    return [];
  }
}

export async function installFor(guildId: number): Promise<number | null> {
  const found = await pool.query<{ app_install_id: string }>(
    "SELECT app_install_id FROM workspaces WHERE guild_id = $1 LIMIT 1",
    [guildId]
  );
  const row = found.rows[0];
  return row ? Number(row.app_install_id) : null;
}

export interface SubscriptionView {
  id: number;
  guild_id: number;
  target_url: string;
  endpoints: string[];
}

function view(subscription: Subscription): SubscriptionView {
  return {
    id: subscription.id,
    guild_id: subscription.guildId,
    target_url: subscription.targetUrl,
    endpoints: subscription.endpoints,
  };
}

export type SubscribeResult =
  | { ok: true; view: SubscriptionView; secret: string }
  | { ok: false; status: number; error: string };

export async function subscribe(
  subscriber: string,
  guildId: number,
  body: unknown
): Promise<SubscribeResult> {
  const parsed = parseSubscribe(body, ENDPOINTS);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };

  if (parsed.request.guild_id !== guildId) {
    return { ok: false, status: 403, error: "that token is for another guild" };
  }

  if ((await installFor(guildId)) === null) {
    return { ok: false, status: 404, error: "this app is not installed in that guild" };
  }

  const secret = mintSubscriptionSecret();
  const stored = await pool.query<Row>(
    `INSERT INTO subscriptions (guild_id, subscriber, target_url, secret, endpoints)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (guild_id, subscriber, target_url) DO UPDATE
        SET secret = EXCLUDED.secret,
            endpoints = EXCLUDED.endpoints,
            updated_at = now()
     RETURNING id, guild_id, subscriber, target_url, secret, endpoints`,
    [guildId, subscriber, parsed.request.target_url, seal(secret), parsed.request.endpoints]
  );

  return { ok: true, view: view(toSubscription(stored.rows[0])), secret };
}

export async function listSubscriptions(
  subscriber: string,
  guildId: number
): Promise<SubscriptionView[]> {
  const found = await pool.query<Row>(
    `SELECT id, guild_id, subscriber, target_url, secret, endpoints
       FROM subscriptions
      WHERE guild_id = $1 AND subscriber = $2
      ORDER BY id`,
    [guildId, subscriber]
  );
  return found.rows.map((row) => view(toSubscription(row)));
}

export async function unsubscribe(
  subscriber: string,
  guildId: number,
  id: number
): Promise<boolean> {
  const result = await pool.query(
    "DELETE FROM subscriptions WHERE id = $1 AND guild_id = $2 AND subscriber = $3",
    [id, guildId, subscriber]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function spendToken(jti: string, expiresAt: number): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO delegation_tokens (jti, expires_at)
     VALUES ($1, to_timestamp($2))
     ON CONFLICT (jti) DO NOTHING`,
    [jti, expiresAt]
  );
  if ((result.rowCount ?? 0) === 0) return false;
  await pool.query("DELETE FROM delegation_tokens WHERE expires_at < now()");
  return true;
}

/**
 * What the guild's workspace connection holds, in this app's own words.
 *
 * Every value here was written by this app at the end of an admin's install
 * flow rather than typed into a form, which is why the parsing stayed: the
 * shape on the wire is the same one it has always been, and a value that
 * arrived some other way — an install configured before the flow existed —
 * still reads correctly.
 */
/**
 * What the guild's workspace connection holds.
 *
 * The installation, and the account it is on. Both were written by this app
 * when an admin's install was verified, and neither was typed — the account is
 * kept because every repository URL is built from it, and re-reading it from
 * GitHub on every sync would be a request to learn something that cannot
 * change without the installation changing too.
 */
interface Configured {
  owner: string;
  installationId: number;
}

function readWorkspace(installConfig: InstallConfig): Configured | null {
  const values = installConfig.connections.workspace;
  if (!values) return null;

  const owner = typeof values.owner === "string" ? values.owner.trim() : "";
  if (!owner || owner.includes("/")) return null;

  const named = values.installation_id;
  if (typeof named !== "number" || !Number.isSafeInteger(named) || named <= 0) {
    return null;
  }

  return { owner, installationId: named };
}

export async function syncInstall(guildId: number): Promise<boolean> {
  const installConfig = await initiative.config(guildId);
  const installId = installConfig.install_id;

  const configured = readWorkspace(installConfig);
  if (!configured) {
    await forgetInstall(installId);

    if (!installConfig.needs_config) {
      await initiative.reportStatus(guildId, {
        state: "invalid",
        detail: "not_installed",
      });
    }
    return false;
  }

  // `undefined` where GitHub would not answer, which leaves the stored id
  // alone. Recording "no installation" on a failed lookup would take the
  // guild-scoped sources down until a later sync happened to succeed.
  const found = await installationById(configured.installationId);
  const installationId = found.known ? found.installationId : undefined;

  // What the organization granted, asked of the installation rather than of a
  // person. Every sync, because it is one request and it is the only way a
  // repository added at GitHub reaches this guild without anybody coming back
  // through Initiative to say so. `undefined` on a failure the same way the id
  // is: an unanswered question is not an empty boundary.
  const repos =
    installationId === undefined || installationId === null
      ? undefined
      : ((await installationRepositories(installationId)) ?? undefined);

  await rememberWorkspace(installId, guildId, configured.owner, installationId, repos);

  // `ok` even where GitHub named no installation. Reads that can run as a
  // member still answer, so calling a working dashboard invalid would be
  // false; what an absent installation costs is the webhook and everything
  // guild-wide, and the poll keeps looking.
  await initiative.reportStatus(guildId, { state: "ok" });
  return true;
}

/**
 * Re-read every guild bound to one installation.
 *
 * For the changes nobody made from Initiative: a repository selection widened
 * at GitHub, an approval that finally came through. There is no trip to bind
 * and nothing to write down — the installation is already this guild's, and
 * what it covers is read afresh.
 */
export async function resyncInstallation(installationId: number): Promise<number> {
  let done = 0;
  for (const install of await installsForInstallation(installationId)) {
    try {
      await syncInstall(install.guildId);
      done += 1;
    } catch (error) {
      console.error(`could not re-sync guild ${install.guildId}`, error);
    }
  }
  return done;
}

export async function forgetInstall(installId: number): Promise<void> {
  await forgetWorkspace(installId);
}

/**
 * Whether a failed sync means there is no install, or only that this one did
 * not finish.
 *
 * Only Initiative can say the first — it is the party that knows — and it says
 * it by refusing the config read for a guild whose install is gone. Everything
 * else is a failure to find out: the channel being unreachable, the database,
 * GitHub. Forgetting a workspace on one of those takes every widget in the
 * guild down until the poll next succeeds, to fix nothing.
 */
export function installIsGone(error: unknown): boolean {
  return error instanceof ChannelError && (error.status === 404 || error.status === 410);
}

export async function syncAllInstalls(): Promise<void> {
  const installs = await initiative.installs();

  for (const install of installs) {
    if (!install.enabled) {
      await forgetInstall(install.install_id);
      continue;
    }
    try {
      await syncInstall(install.guild_id);
    } catch (error) {
      console.error(`could not sync install in guild ${install.guild_id}`, error);
    }
  }

  const present = installs.filter((i) => i.enabled).map((i) => i.install_id);
  const dropped = await forgetInstallsExcept(present);
  if (dropped) console.log(`dropped ${dropped} install(s) this app is no longer in`);
}

export function startSync(): { stop: () => void } {
  // An unregistered app has no key to sign with, so every pass would throw on
  // the first lookup. Said once, at boot, rather than every interval.
  if (!config.github.registered) {
    console.log(
      "not registered at GitHub yet — no syncing until it is. " +
        "Set INITIATIVE_APP_SETUP_TOKEN and open /setup/register?token=…"
    );
    return { stop: () => {} };
  }

  const run = () =>
    syncAllInstalls().catch((error) => {
      if (error instanceof ChannelError) {
        console.error(`sync refused: ${error.status} ${error.detail}`);
      } else {
        console.error("sync failed", error);
      }
    });

  void run();
  const timer = setInterval(run, Math.max(30, config.syncIntervalSeconds) * 1000);

  timer.unref();
  return { stop: () => clearInterval(timer) };
}
