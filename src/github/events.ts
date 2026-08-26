/**
 * What repository activity this app publishes, and what it is called.
 *
 * One table, read three ways, so the three cannot disagree:
 *
 *   * {@link EVENT_TYPES} is what the manifest declares — the vocabulary a
 *     subscriber may name, and the contract this app is authoritative about
 *     because it is the one holding GitHub's webhook connection.
 *   * {@link SUBSCRIBED_EVENTS} is what the GitHub App registration asks
 *     GitHub to send. Derived, not restated: an event handled here but absent
 *     from the registration simply never arrives, and nothing anywhere says so.
 *   * {@link translate} is what turns one delivery into one of those types.
 *
 * ## This costs no organization a re-approval
 *
 * The two deliveries taken here need `issues: read` and `pull_requests: read`,
 * which this app already holds because its widgets read them. Subscribing to a
 * webhook event is not a permission change, so nothing is asked of an
 * organization that has already installed the app — which is the only reason
 * these can come back at all after having been removed. Widening a *permission*
 * would be the opposite: every existing installation would keep the old grant
 * until somebody approved the new one.
 *
 * ## What travels, and why so little
 *
 * The payload carries identifiers and the handful of fields a trigger narrows
 * itself by. Not the whole delivery: an issue body is somebody's prose, a
 * label set is churn, and a consumer that wanted either can ask GitHub for it
 * with its own credential. `repository` is the field that matters most, because
 * it is how a guild watching several repositories narrows an automation to one
 * of them — an app event names no initiative, so a payload field is the only
 * thing there is to narrow by.
 */

import { PUBLIC_ID } from "../public-id.js";

/** `app.<public id>.<name>`, which is the namespacing the platform enforces. */
function declare(name: string): string {
  return `app.${PUBLIC_ID}.${name}`;
}

/**
 * The delivery-and-action pairs this app publishes, and what each becomes.
 *
 * Keyed by GitHub's own event name, then by the `action` inside it. An action
 * that is not here is not an event this app has anything to say about — GitHub
 * sends `edited`, `labeled`, `assigned` and a dozen more on `issues` alone, and
 * publishing all of them would be a vocabulary nobody asked for and a delivery
 * volume nobody wants.
 */
const PUBLISHED: Record<string, Record<string, string>> = {
  issues: {
    opened: declare("issue-opened"),
    closed: declare("issue-closed"),
  },
  pull_request: {
    review_requested: declare("review-requested"),
  },
};

/** Every type this app declares, for the manifest. */
export const EVENT_TYPES: readonly string[] = Object.values(PUBLISHED)
  .flatMap((actions) => Object.values(actions))
  .sort();

/**
 * Which deliveries the GitHub App registration asks for.
 *
 * Derived from the table above rather than written out beside it. The
 * installation lifecycle is deliberately *not* here: GitHub sends those to
 * every app whether it asked or not — "All GitHub Apps receive this event by
 * default. You cannot manually subscribe to this event" — so naming them would
 * be asking for something already arriving.
 */
export const SUBSCRIBED_EVENTS: readonly string[] = Object.keys(PUBLISHED).sort();

/** One delivery, as something this app publishes. */
export interface TranslatedEvent {
  /** One of {@link EVENT_TYPES}. */
  eventType: string;
  /** Which repository it happened in, for finding the installs that watch it. */
  repo: string;
  payload: Record<string, unknown>;
}

/** A field off a delivery, or undefined — GitHub's payloads are wide and loose. */
function text(source: unknown, key: string): string | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function count(source: unknown, key: string): number | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

function nested(source: unknown, key: string): unknown {
  if (typeof source !== "object" || source === null) return undefined;
  return (source as Record<string, unknown>)[key];
}

/**
 * Turn one verified delivery into one event this app publishes, or nothing.
 *
 * Nothing is the common answer and not a failure: this app hears every action
 * on the two deliveries it subscribed to, and publishes four of them. A
 * delivery it has nothing to say about is dropped here rather than at the
 * route, so the route stays about signatures and this stays about meaning.
 */
export function translate(
  event: string,
  payload: Record<string, unknown>
): TranslatedEvent | null {
  const actions = PUBLISHED[event];
  if (!actions) return null;

  const action = text(payload, "action");
  const eventType = action ? actions[action] : undefined;
  if (!eventType) return null;

  // A delivery with no repository cannot be routed to an install, since which
  // installs care is answered by repository. There is no useful fallback.
  const repo = text(nested(payload, "repository"), "name");
  if (!repo) return null;

  const subject = event === "issues" ? nested(payload, "issue") : nested(payload, "pull_request");
  const number = count(subject, "number");
  if (number === undefined) return null;

  const base: Record<string, unknown> = {
    repository: repo,
    // The owner too, because two guilds may watch same-named repositories under
    // different organizations and a trigger should be able to tell them apart.
    owner: text(nested(nested(payload, "repository"), "owner"), "login") ?? null,
    number,
    title: text(subject, "title") ?? null,
    url: text(subject, "html_url") ?? null,
    author: text(nested(subject, "user"), "login") ?? null,
  };

  if (event === "pull_request") {
    // Whose review was asked for. The one field that makes this event
    // actionable rather than merely informational.
    base.reviewer =
      text(nested(payload, "requested_reviewer"), "login") ??
      text(nested(payload, "requested_team"), "slug") ??
      null;
  } else {
    const labels = nested(payload, "issue") as { labels?: unknown } | undefined;
    base.labels = Array.isArray(labels?.labels)
      ? labels.labels
          .map((label) => text(label, "name"))
          .filter((name): name is string => typeof name === "string")
      : [];
  }

  return { eventType, repo, payload: base };
}
