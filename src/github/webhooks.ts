/**
 * The inbound half: a GitHub delivery becoming an Initiative event.
 *
 * This is the trigger side of the automation surface. The manifest declares
 * three events and two trigger nodes that fire on them; this is what actually
 * emits them, and without it those nodes could never fire.
 *
 * The trip, and why each step is where it is:
 *
 * 1. **GitHub signs its delivery**, and this verifies it against the secret the
 *    repository's webhook settings were given. That check is what establishes
 *    the caller, the way a context token does on the platform's own routes.
 * 2. **The delivery names a repository, and nothing else this app can use.**
 *    There is no guild in it. The `workspaces` table — filled by the install
 *    sync — is what turns `owner/repo` back into the installs that asked about
 *    it, and there may be more than one.
 * 3. **Initiative checks it again.** An event type is accepted only if the
 *    *pinned* definition of this app declares it and it sits under this app's
 *    own namespace, so a guild running an older version does not receive an
 *    event that version never promised.
 *
 * Only the fields the trigger nodes declared as `outputs` are carried across.
 * A GitHub issue payload is large and mostly about people; a run's state is not
 * the place for it, and a later node can only read what was named anyway.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { ChannelError } from "initiative-app-kit";

import { config } from "../config.js";
import { initiative } from "../initiative.js";
import { PUBLIC_ID } from "../manifest.config.js";
import { installsWatching } from "./workspace.js";

/** GitHub's own headers on a delivery. */
export const EVENT_HEADER = "x-github-event";
export const SIGNATURE_HEADER = "x-hub-signature-256";
export const DELIVERY_HEADER = "x-github-delivery";

/** The event types this app emits, all declared in its manifest. */
export const EVENTS = {
  issueOpened: `app.${PUBLIC_ID}.issue-opened`,
  issueClosed: `app.${PUBLIC_ID}.issue-closed`,
  reviewRequested: `app.${PUBLIC_ID}.review-requested`,
} as const;

/**
 * Whether GitHub signed these exact bytes.
 *
 * Over the raw body, before any parser has touched it: a re-serialized object
 * is different bytes and would never match.
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

interface Repository {
  owner: string;
  repo: string;
}

/** `full_name` is `owner/repo`; nothing else in the payload gives both halves. */
function readRepository(payload: Record<string, unknown>): Repository | null {
  const repository = payload.repository as { full_name?: unknown } | undefined;
  const fullName = repository?.full_name;
  if (typeof fullName !== "string") return null;
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) return null;
  return { owner, repo };
}

/** One event to emit, or nothing if this delivery is not one this app cares about. */
interface Translated {
  type: string;
  payload: Record<string, unknown>;
}

function readLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (entry as { name?: unknown } | null)?.name)
    .filter((name): name is string => typeof name === "string")
    // The trigger's `label` field matches against these, so a payload with a
    // hundred labels would be matched against a hundred; a repository does not
    // have that many, and a bound here is cheaper than one downstream.
    .slice(0, 50);
}

/**
 * A GitHub delivery as one of this app's declared events.
 *
 * GitHub sends one `issues` event for every verb — opened, edited, labeled,
 * assigned — so the action is what decides, and everything unrecognized is
 * accepted and ignored rather than refused: a repository sends deliveries this
 * app never asked for, and failing them would fill an admin's webhook log with
 * red for events working exactly as intended.
 */
export function translate(
  event: string,
  payload: Record<string, unknown>
): Translated | null {
  if (event === "issues") {
    const action = payload.action;
    if (action !== "opened" && action !== "closed") return null;
    const issue = payload.issue as Record<string, unknown> | undefined;
    if (!issue) return null;
    return {
      type: action === "opened" ? EVENTS.issueOpened : EVENTS.issueClosed,
      // Exactly the trigger node's declared outputs.
      payload: {
        issue_number: issue.number,
        issue_title: issue.title,
        issue_url: issue.html_url,
        issue_labels: readLabels(issue.labels),
      },
    };
  }

  if (event === "pull_request" && payload.action === "review_requested") {
    const pull = payload.pull_request as Record<string, unknown> | undefined;
    if (!pull) return null;
    return {
      type: EVENTS.reviewRequested,
      payload: {
        pull_number: pull.number,
        pull_title: pull.title,
        pull_url: pull.html_url,
      },
    };
  }

  return null;
}

/** What a delivery did, for the answer GitHub sees in its own log. */
export interface DeliveryResult {
  emitted: number;
  reason?: "unhandled" | "no-repository" | "no-install";
}

/**
 * Handle one verified delivery.
 *
 * Emits to every install watching the repository. A refused emit is logged and
 * stepped over rather than failing the delivery: GitHub retries a failure, and
 * retrying an event one guild has already accepted would deliver it twice
 * there to get it once somewhere else.
 */
export async function handleDelivery(
  event: string,
  payload: Record<string, unknown>
): Promise<DeliveryResult> {
  const translated = translate(event, payload);
  if (!translated) return { emitted: 0, reason: "unhandled" };

  const repository = readRepository(payload);
  if (!repository) return { emitted: 0, reason: "no-repository" };

  const installs = await installsWatching(repository.owner, repository.repo);
  if (installs.length === 0) return { emitted: 0, reason: "no-install" };

  let emitted = 0;
  for (const install of installs) {
    try {
      await initiative.emitEvent(install.guildId, translated.type, translated.payload);
      emitted += 1;
    } catch (error) {
      if (error instanceof ChannelError) {
        console.error(
          `could not emit ${translated.type} into guild ${install.guildId}: ` +
            `${error.status} ${error.detail}`
        );
      } else {
        console.error(`could not emit ${translated.type}`, error);
      }
    }
  }
  return { emitted };
}
