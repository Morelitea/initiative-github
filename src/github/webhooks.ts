/**
 * The inbound half: GitHub telling this app what happened.
 *
 * Two jobs, and they are worth keeping apart because they are answerable by
 * different things:
 *
 *   * **The app's own lifecycle.** An organization installing this app,
 *     removing it, or changing which repositories it may see. Nobody
 *     subscribes to that — it is not news, it is a fact about whether this app
 *     can answer anything at all — so it re-runs the sync for the installs it
 *     affects and tells no one.
 *   * **Repository activity.** An issue opened, a review requested. This *is*
 *     news, and it goes to whoever asked to hear it.
 *
 * The second goes straight to the subscriber, with Initiative not in the path
 * at all. This app already holds GitHub's
 * webhook connection and has already verified GitHub's signature; posting the
 * result through a third party to reach a consumer that could be handed it adds
 * a hop and a place to be dropped. What that costs is that this app has to be a
 * producer — which is `../events.ts`, and is the kit's shapes rather than this
 * app's.
 *
 * The signature check is unchanged and is the reason to trust any of it. One
 * secret, on the app's own registration, covering every organization that
 * installs it — where an OAuth app would have needed a webhook added by hand to
 * every repository, and would silently receive nothing from the one somebody
 * forgot.
 *
 * ## A delivery is handled twice without harm
 *
 * GitHub signs the body and not a timestamp, so a delivery it re-sends — or one
 * replayed at this endpoint — carries a signature that still checks out. Every
 * handler below is written to survive that, and it is a property to preserve
 * rather than a coincidence to rely on quietly: a re-sync run twice is a
 * re-sync, and a republished event carries the delivery id in its envelope id,
 * so the subscriber recognises it as the one it already has.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { config } from "../config.js";
import { publish } from "../subscriptions.js";
import { syncInstall } from "../sync.js";
import { translate } from "./emissions.js";
import {
  installsAwaiting,
  installsForInstallation,
  installsWatching,
} from "./workspace.js";

/** GitHub's own headers on a delivery. */
export const EVENT_HEADER = "x-github-event";
export const SIGNATURE_HEADER = "x-hub-signature-256";
export const DELIVERY_HEADER = "x-github-delivery";

/**
 * The deliveries that are about this app rather than about a repository.
 *
 * These arrive whether or not the registration asks for them — GitHub sends
 * them to every app and says so: "All GitHub Apps receive this event by
 * default. You cannot manually subscribe to this event." So they are handled
 * here and named nowhere in the registration, which is the least an app can ask
 * for and still know its own state.
 *
 * One event, not two. GitHub also sends `installation_repositories` when an
 * organization widens or narrows what an installation covers, and this app has
 * nothing to do with it: what a call may reach is the list a guild admin wrote
 * down, so a grant changing under it moves no boundary here. It falls through
 * with everything else this app does not publish.
 */
const LIFECYCLE_EVENTS = new Set(["installation"]);

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
  /** Subscribers this delivery was published to. */
  published: number;
  reason?: "unhandled" | "no-installation" | "nothing-to-say" | "unwatched";
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
  payload: Record<string, unknown>,
  deliveryId: string
): Promise<DeliveryResult> {
  if (!LIFECYCLE_EVENTS.has(event)) {
    return publishActivity(event, payload, deliveryId);
  }

  const installation = payload.installation as
    | { id?: unknown; account?: { login?: unknown } }
    | undefined;
  const installationId = typeof installation?.id === "number" ? installation.id : null;
  const owner =
    typeof installation?.account?.login === "string"
      ? installation.account.login
      : null;

  if (installationId === null && owner === null) {
    return { resynced: 0, published: 0, reason: "no-installation" };
  }

  const guilds = new Map<number, number>();

  if (installationId !== null) {
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
  return { resynced, published: 0 };
}

/**
 * Republish one repository delivery to whoever asked for it.
 *
 * Two narrowings, in this order, and neither is optional:
 *
 *   * **Is this something this app publishes?** `translate` answers, and it
 *     says no far more often than yes — this app hears every action on the
 *     deliveries it subscribed to and publishes four of them.
 *   * **Whose is it?** A delivery names an installation and a repository, and
 *     the installs watching that pair are the guilds entitled to hear about it.
 *     Matching on the installation rather than on the owner's name is the point:
 *     GitHub asserts the installation, whereas an owner is a string somebody
 *     typed and a repository can be renamed or transferred under one.
 *
 * The delivery id becomes the envelope's id, which is what makes a redelivery
 * recognizable as one. GitHub re-sends a delivery it believes failed with the
 * same id, so the subscriber sees the id it already has rather than a second
 * copy of the same event.
 */
async function publishActivity(
  event: string,
  payload: Record<string, unknown>,
  deliveryId: string
): Promise<DeliveryResult> {
  const translated = translate(event, payload);
  if (!translated) return { resynced: 0, published: 0, reason: "nothing-to-say" };

  const installation = payload.installation as { id?: unknown } | undefined;
  const installationId = typeof installation?.id === "number" ? installation.id : null;
  if (installationId === null) {
    return { resynced: 0, published: 0, reason: "no-installation" };
  }

  const watching = await installsWatching(installationId, translated.repo);
  if (watching.length === 0) {
    // An organization granted this app a repository no guild has pointed at.
    // Ordinary, and not something to fail the delivery over.
    return { resynced: 0, published: 0, reason: "unwatched" };
  }

  let published = 0;
  for (const install of watching) {
    const outcomes = await publish({
      guildId: install.guildId,
      appInstallId: install.appInstallId,
      endpoint: translated.endpoint,
      payload: translated.payload,
      deliveryKey: deliveryId,
    });
    published += outcomes.filter((outcome) => outcome.ok).length;
    for (const failed of outcomes.filter((outcome) => !outcome.ok)) {
      // Logged and dropped. A subscriber that is down is not GitHub's problem,
      // and asking GitHub to retry would re-run every other subscriber too.
      console.warn(
        `subscription ${failed.subscriptionId} did not take ${translated.endpoint}: ` +
          `${failed.error ?? failed.status}`
      );
    }
  }
  return { resynced: 0, published };
}
