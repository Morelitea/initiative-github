/**
 * The inbound half: a GitHub delivery becoming an Initiative event.
 *
 * This is the trigger side of the automation surface. The manifest declares
 * three events and two trigger nodes that fire on them; this is what actually
 * emits them, and without it those nodes could never fire.
 *
 * The trip, and why each step is where it is:
 *
 * 1. **GitHub signs its delivery**, and this verifies it against the secret on
 *    the *app's own registration*. One secret, typed once, covering every
 *    organization that installs it — where an OAuth app would have needed a
 *    webhook added to every repository by hand, and would silently receive
 *    nothing from the one somebody forgot. That check is what establishes the
 *    caller, the way a context token does on the platform's own routes.
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
 *
 * **Not every delivery is an event.** A GitHub App is also told about its own
 * installation — an org adding it, removing it, or changing which repositories
 * it may see. Those are not things to emit into a guild; they are things that
 * change whether this app can answer at all, so they re-run the sync for the
 * installs they affect. It is the difference between news about the repository
 * and news about the relationship.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { ChannelError } from "initiative-app-kit";

import { config } from "../config.js";
import { initiative } from "../initiative.js";
import { PUBLIC_ID } from "../manifest.config.js";
import { syncInstall } from "../sync.js";
import { forgetInstallation } from "./app.js";
import { installsForInstallation, installsWatching } from "./workspace.js";

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
  /** Installs re-synced because the relationship changed, not the repository. */
  resynced?: number;
  reason?: "unhandled" | "no-repository" | "no-install" | "installation";
}

/** The deliveries that are about this app rather than about a repository. */
const LIFECYCLE_EVENTS = new Set(["installation", "installation_repositories"]);

/** `owner/repo` out of whichever list of repositories a payload carries. */
function readRepositories(payload: Record<string, unknown>): Repository[] {
  const lists = ["repositories", "repositories_added", "repositories_removed"];
  const found: Repository[] = [];
  for (const key of lists) {
    const value = payload[key];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      const fullName = (entry as { full_name?: unknown } | null)?.full_name;
      if (typeof fullName !== "string") continue;
      const [owner, repo] = fullName.split("/");
      if (owner && repo) found.push({ owner, repo });
    }
  }
  return found;
}

/**
 * An organization added, removed, or re-scoped this app's installation.
 *
 * Nothing is emitted: no guild asked to be told that an org owner clicked a
 * button, and there is no event in the manifest that would carry it. What it
 * changes is whether the guild-scoped sources can answer, so the affected
 * installs are re-synced — which re-runs the discovery and reports the verdict
 * back to Initiative, so the install flips between `ok` and
 * `github_app_not_installed` within seconds instead of at the next poll.
 *
 * Both directions have to be found, and by different means. An install being
 * *removed* names an installation this app already recorded, so the lookup is
 * by installation id. An install being *created* names repositories this app
 * has never seen an installation for, so the lookup is by repository — which is
 * exactly the guild that has been sitting at `github_app_not_installed` waiting
 * for this to happen.
 */
async function handleInstallation(
  payload: Record<string, unknown>
): Promise<DeliveryResult> {
  const installation = payload.installation as { id?: unknown } | undefined;
  const installationId =
    typeof installation?.id === "number" ? installation.id : null;

  const guilds = new Map<number, number>();
  if (installationId !== null) {
    // Whatever just happened, the token held for it is no longer trustworthy:
    // it may have been revoked, or narrowed to fewer repositories.
    forgetInstallation(installationId);
    for (const install of await installsForInstallation(installationId)) {
      guilds.set(install.appInstallId, install.guildId);
    }
  }
  for (const repository of readRepositories(payload)) {
    for (const install of await installsWatching(repository.owner, repository.repo)) {
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
  return { emitted: 0, resynced, reason: "installation" };
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
  if (LIFECYCLE_EVENTS.has(event)) return handleInstallation(payload);

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
