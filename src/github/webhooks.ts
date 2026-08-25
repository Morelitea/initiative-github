/**
 * The inbound half: GitHub telling this app about its own installation.
 *
 * This file used to do two jobs. It translated repository activity — an issue
 * opened, a review requested — into Initiative events for automation triggers
 * to fire on, and it handled the app's own lifecycle. The first job is gone,
 * and the reason is worth keeping written down because the code looked fine:
 *
 * An app emits through `emitEvent`, the platform accepts it, checks it against
 * the app's pinned definition, and hands it to the dispatcher. The dispatcher
 * delivers to subscriptions naming that event type — and the vocabulary a
 * subscription may name is *derived from Initiative's own content tables*
 * (`{resource}.{action}`), with anything else refused at registration. So no
 * subscription can name `app.<id>.<event>`, the dispatcher matches nothing, and
 * the emit returns success having delivered to no one. Not an error anywhere;
 * just an event that stops.
 *
 * So what remains is the job that works, and it is the one that matters for
 * this app being correct rather than for it being interesting: an organization
 * installing it, removing it, or changing which repositories it may see. None
 * of that is something to emit into a guild — no subscriber asked to hear that
 * somebody clicked a button — but all of it changes whether this app can answer
 * anything, so it re-runs the sync for the installs it affects.
 *
 * The signature check is unchanged and is the reason to trust any of it. One
 * secret, on the app's own registration, covering every organization that
 * installs it — where an OAuth app would have needed a webhook added by hand to
 * every repository, and would silently receive nothing from the one somebody
 * forgot.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { config } from "../config.js";
import { syncInstall } from "../sync.js";
import { forgetInstallation, forgetRepositories } from "./app.js";
import { installsAwaiting, installsForInstallation } from "./workspace.js";

/** GitHub's own headers on a delivery. */
export const EVENT_HEADER = "x-github-event";
export const SIGNATURE_HEADER = "x-hub-signature-256";
export const DELIVERY_HEADER = "x-github-delivery";

/**
 * The deliveries this app acts on.
 *
 * It subscribes to nothing. These three arrive regardless — GitHub sends them
 * to every app and says so: "All GitHub Apps receive this event by default. You
 * cannot manually subscribe to this event." So the registration's event list is
 * empty and this still works, which is the least an app can ask for and still
 * know its own state.
 */
const LIFECYCLE_EVENTS = new Set([
  "installation",
  "installation_repositories",
]);

/**
 * Whether GitHub signed these exact bytes.
 *
 * Over the raw body, before any parser has touched it: a signature is over what
 * arrived, and a re-serialized object is different bytes.
 */
export function verifySignature(body: Uint8Array, header: string | undefined): boolean {
  if (!header || !header.startsWith("sha256=")) return false;

  const expected = createHmac("sha256", config.github.webhookSecret)
    .update(body)
    .digest();
  const offered = Buffer.from(header.slice("sha256=".length), "hex");
  // `timingSafeEqual` requires equal lengths — it raises rather than returning
  // false — so a malformed header is caught here before it reaches the compare.
  if (offered.length !== expected.length) return false;
  return timingSafeEqual(offered, expected);
}

/** What a delivery did, for the answer GitHub sees in its own log. */
export interface DeliveryResult {
  /** Installs re-synced because the relationship changed. */
  resynced: number;
  reason?: "unhandled" | "no-installation";
}

/**
 * Handle one verified delivery.
 *
 * Everything unrecognized is accepted and ignored rather than refused. A
 * repository sends deliveries this app never asked for, and failing them would
 * fill an organization's webhook log with red for events working exactly as
 * intended.
 *
 * Both directions have to be found, and by different means. An install being
 * *removed* names an installation this app already recorded, so the lookup is
 * by installation id. An install being *created* names one this app has never
 * seen, so no row can name it — and the guild that has been sitting at
 * `github_app_not_installed` waiting for exactly this is found by the account
 * instead.
 */
export async function handleDelivery(
  event: string,
  payload: Record<string, unknown>
): Promise<DeliveryResult> {
  if (!LIFECYCLE_EVENTS.has(event)) return { resynced: 0, reason: "unhandled" };

  const installation = payload.installation as
    | { id?: unknown; account?: { login?: unknown } }
    | undefined;
  const installationId = typeof installation?.id === "number" ? installation.id : null;
  const owner =
    typeof installation?.account?.login === "string"
      ? installation.account.login
      : null;

  if (installationId === null && owner === null) {
    return { resynced: 0, reason: "no-installation" };
  }

  const guilds = new Map<number, number>();

  if (installationId !== null) {
    // Whatever just happened, what is held for it is no longer trustworthy: the
    // token may have been revoked, and the repository list is the very thing
    // this delivery is usually about.
    forgetInstallation(installationId);
    forgetRepositories(installationId);
    for (const install of await installsForInstallation(installationId)) {
      guilds.set(install.appInstallId, install.guildId);
    }
  }

  if (owner) {
    for (const install of await installsAwaiting(owner)) {
      guilds.set(install.appInstallId, install.guildId);
    }
  }

  let resynced = 0;
  for (const guildId of guilds.values()) {
    try {
      await syncInstall(guildId);
      resynced += 1;
    } catch (error) {
      // One guild's failure is not the others', and the poll will catch it.
      console.error(`could not re-sync guild ${guildId} after an install change`, error);
    }
  }
  return { resynced };
}
