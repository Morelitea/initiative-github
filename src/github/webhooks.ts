import { createHmac, timingSafeEqual } from "node:crypto";

import { config } from "../config.js";
import { publish, syncInstall } from "../platform.js";

import { translate } from "../endpoints/emissions.js";
import {
  installsAwaiting,
  installsForInstallation,
  installsWatching,
} from "../workspace.js";

export const EVENT_HEADER = "x-github-event";
export const SIGNATURE_HEADER = "x-hub-signature-256";
export const DELIVERY_HEADER = "x-github-delivery";

const LIFECYCLE_EVENTS = new Set(["installation"]);

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
      console.error(`could not re-sync guild ${guildId} after an install change`, error);
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
