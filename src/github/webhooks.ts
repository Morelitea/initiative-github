import { createHmac, timingSafeEqual } from "node:crypto";

import { config } from "../config.js";
import { publish, syncInstall } from "../platform.js";

import { translate } from "../endpoints/emissions.js";
import { installsForInstallation, installsWatching } from "../workspace.js";

export const EVENT_HEADER = "x-github-event";
export const SIGNATURE_HEADER = "x-hub-signature-256";
export const DELIVERY_HEADER = "x-github-delivery";

/**
 * What GitHub tells every app about its own installations, subscribed or not.
 *
 * `installation` is one being made, suspended or removed;
 * `installation_repositories` is the boundary changing — an organization
 * ticking another repository, which is how that reaches a guild without
 * anybody coming back through Initiative to say so. Neither can be subscribed
 * to and neither has to be: GitHub sends both to every app.
 */
const LIFECYCLE_EVENTS = new Set(["installation", "installation_repositories"]);

export function verifySignature(body: Uint8Array, header: string | undefined): boolean {
  if (!header || !header.startsWith("sha256=")) return false;

  const expected = createHmac("sha256", config.github.webhookSecret)
    .update(body)
    .digest();
  const offered = Buffer.from(header.slice("sha256=".length), "hex");

  if (offered.length !== expected.length) return false;
  return timingSafeEqual(offered, expected);
}

export interface DeliveryResult {
    resynced: number;
    published: number;
  reason?: "unhandled" | "no-installation" | "nothing-to-say" | "unwatched";
}

export async function handleDelivery(
  event: string,
  payload: Record<string, unknown>,
  deliveryId: string
): Promise<DeliveryResult> {
  if (!LIFECYCLE_EVENTS.has(event)) {
    return publishActivity(event, payload, deliveryId);
  }

  const installation = payload.installation as { id?: unknown } | undefined;
  const installationId = typeof installation?.id === "number" ? installation.id : null;

  if (installationId === null) {
    return { resynced: 0, published: 0, reason: "no-installation" };
  }

  // By id, because that is what a guild is bound to. The account it is on is
  // in the payload too and is not a way to find anybody: a login names an
  // installation only until somebody renames the organization.
  let resynced = 0;
  for (const install of await installsForInstallation(installationId)) {
    try {
      await syncInstall(install.guildId);
      resynced += 1;
    } catch (error) {
      console.error(
        `could not re-sync guild ${install.guildId} after an install change`,
        error
      );
    }
  }
  return { resynced, published: 0 };
}

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
    return { resynced: 0, published: 0, reason: "unwatched" };
  }

  let published = 0;
  for (const install of watching) {
    const outcomes = await publish({
      guildId: install.guildId,
      appInstallId: install.appInstallId,
      endpoint: translated.endpoint,
      identity: translated.identity,
      payload: translated.payload,
      deliveryKey: deliveryId,
    });
    published += outcomes.filter((outcome) => outcome.ok).length;
    for (const failed of outcomes.filter((outcome) => !outcome.ok)) {
      console.warn(
        `subscription ${failed.subscriptionId} did not take ${translated.endpoint}: ` +
          `${failed.error ?? failed.status}`
      );
    }
  }
  return { resynced: 0, published };
}
