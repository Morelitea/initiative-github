/**
 * What repository activity this app publishes, and what it is called.
 *
 * One table, read four ways, so the four cannot disagree:
 *
 *   * {@link EMIT_ENDPOINTS} is what the manifest declares — the vocabulary a
 *     subscriber may name, and the contract this app is authoritative about
 *     because it is the one holding GitHub's webhook connection.
 *   * {@link EMITTED} is the same list as bare ids, for the places that only
 *     need to know which they are.
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
 *
 * ## And it is declared, not discovered
 *
 * An emission is the one endpoint here chosen without ever being called, so
 * everything a consumer knows about it before it fires is what this file says.
 * That is why each carries a `label` — a menu of raw ids is unreadable and
 * untranslatable — and why {@link SUBJECT} states the payload rather than
 * leaving somebody to fire one and look. An automation offers these as values a
 * later step may read, and a step wired to a field this app does not send has
 * to be refusable when it is wired rather than when it runs.
 *
 * The declaration and {@link translate} branch on the same key for the same
 * reason the three lists above are one table: a payload field promised in one
 * place and built in the other is the disagreement nobody notices.
 */

import type { Endpoint, EndpointReturn, LocalizedText } from "initiative-app-kit";

import { declare } from "../public-id.js";

/** One label, in the four languages everything this app declares is written in. */
function text(en: string, de: string, es: string, fr: string): LocalizedText {
  return { en, de, es, fr };
}

/** One payload field, by name, type and the words a consumer picks it out by. */
function value(
  key: string,
  type: EndpointReturn["type"],
  en: string,
  de: string,
  es: string,
  fr: string
): EndpointReturn {
  return { key, type, label: text(en, de, es, fr) };
}

/** One thing this app announces, in the words somebody picks it out of a list by. */
interface Announcement {
  id: string;
  label: LocalizedText;
  description: LocalizedText;
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
const PUBLISHED: Record<string, Record<string, Announcement>> = {
  issues: {
    opened: {
      id: declare("issue-opened"),
      label: text(
        "An issue was opened",
        "Ein Issue wurde geöffnet",
        "Se abrió una incidencia",
        "Un ticket a été ouvert"
      ),
      description: text(
        "Fires when somebody opens an issue in a watched repository.",
        "Wird ausgelöst, wenn jemand ein Issue in einem beobachteten Repository öffnet.",
        "Se dispara cuando alguien abre una incidencia en un repositorio vigilado.",
        "Se déclenche quand quelqu'un ouvre un ticket dans un dépôt surveillé."
      ),
    },
    closed: {
      id: declare("issue-closed"),
      label: text(
        "An issue was closed",
        "Ein Issue wurde geschlossen",
        "Se cerró una incidencia",
        "Un ticket a été fermé"
      ),
      description: text(
        "Fires when somebody closes an issue in a watched repository.",
        "Wird ausgelöst, wenn jemand ein Issue in einem beobachteten Repository schließt.",
        "Se dispara cuando alguien cierra una incidencia en un repositorio vigilado.",
        "Se déclenche quand quelqu'un ferme un ticket dans un dépôt surveillé."
      ),
    },
  },
  pull_request: {
    review_requested: {
      id: declare("review-requested"),
      label: text(
        "A review was requested",
        "Eine Review wurde angefragt",
        "Se solicitó una revisión",
        "Une revue a été demandée"
      ),
      description: text(
        "Fires when a pull request asks a person or a team to review.",
        "Wird ausgelöst, wenn ein Pull Request eine Person oder ein Team um eine Review bittet.",
        "Se dispara cuando una pull request pide revisión a una persona o equipo.",
        "Se déclenche quand une pull request demande une relecture à une personne ou une équipe."
      ),
    },
  },
};

/**
 * What every announcement carries, whichever delivery produced it.
 *
 * The same six fields {@link translate} builds, in the same order, because they
 * are the same six. A type here says what a field *is* when it is there — GitHub
 * omits a title or a login often enough that the translator defaults them to
 * null, and the return vocabulary has no way to say "or nothing", so a consumer
 * that must have one checks for it the way it would check any other value.
 */
const SUBJECT: readonly EndpointReturn[] = [
  value("repository", "string", "Repository", "Repository", "Repositorio", "Dépôt"),
  value("owner", "string", "Owner", "Inhaber", "Propietario", "Propriétaire"),
  value("number", "int", "Number", "Nummer", "Número", "Numéro"),
  value("title", "string", "Title", "Titel", "Título", "Titre"),
  value("url", "url", "Link", "Link", "Enlace", "Lien"),
  value("author", "string", "Author", "Autor", "Autor", "Auteur"),
];

/**
 * What one kind of delivery carries beyond that, and where its announcements
 * are filed.
 *
 * Keyed by GitHub's event name and read with the key {@link translate}
 * branches on, so the extra field a consumer is offered is the extra field the
 * translator actually sets.
 */
const PER_DELIVERY: Record<string, { group: string; carries: EndpointReturn }> = {
  issues: {
    group: "issues",
    carries: {
      // The one list in the whole payload, and saying so is what lets a
      // consumer with room for exactly one value refuse it rather than
      // discover at run time that it was handed several.
      ...value("labels", "string", "Labels", "Labels", "Etiquetas", "Étiquettes"),
      list: true,
    },
  },
  pull_request: {
    group: "reviews",
    // Whose review was asked for. The one field that makes this event
    // actionable rather than merely informational.
    carries: value("reviewer", "string", "Reviewer", "Reviewer", "Revisor", "Relecteur"),
  },
};

/**
 * The same table as manifest endpoints.
 *
 * An emission names no connection and takes no parameters: nobody calls it, so
 * there is nothing for a caller to send and nothing to be satisfied before they
 * do — and the kit refuses a caller side on one for exactly that reason. What
 * it *does* carry is everything a consumer needs to choose it and to read what
 * it sent: an id, a name, a sentence, a payload and a drawer to sit in.
 *
 * Sorted by id so the manifest is stable across builds.
 */
export const EMIT_ENDPOINTS: readonly Endpoint[] = Object.entries(PUBLISHED)
  .flatMap(([event, actions]) =>
    Object.values(actions).map(
      (announcement): Endpoint => ({
        id: announcement.id,
        direction: "emit",
        label: announcement.label,
        description: announcement.description,
        group: PER_DELIVERY[event].group,
        returns: [...SUBJECT, PER_DELIVERY[event].carries],
      })
    )
  )
  .sort((left, right) => left.id.localeCompare(right.id));

/** Every id that table produces, in the order the manifest declares them. */
export const EMITTED: readonly string[] = EMIT_ENDPOINTS.map((endpoint) => endpoint.id);

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
  /** One of {@link EMITTED}. */
  endpoint: string;
  /** Which repository it happened in, for finding the installs that watch it. */
  repo: string;
  payload: Record<string, unknown>;
}

/** A field off a delivery, or undefined — GitHub's payloads are wide and loose. */
function textOf(source: unknown, key: string): string | undefined {
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
 * on the two deliveries it subscribed to, and publishes three of them. A
 * delivery it has nothing to say about is dropped here rather than at the
 * route, so the route stays about signatures and this stays about meaning.
 *
 * What it builds is {@link SUBJECT} plus the one field {@link PER_DELIVERY}
 * names for this kind of delivery — the shape the manifest promised, keyed off
 * the same `event` the promise was keyed off.
 */
export function translate(
  event: string,
  payload: Record<string, unknown>
): TranslatedEvent | null {
  const actions = PUBLISHED[event];
  if (!actions) return null;

  const action = textOf(payload, "action");
  const announcement = action ? actions[action] : undefined;
  if (!announcement) return null;

  // A delivery with no repository cannot be routed to an install, since which
  // installs care is answered by repository. There is no useful fallback.
  const repo = textOf(nested(payload, "repository"), "name");
  if (!repo) return null;

  const subject = event === "issues" ? nested(payload, "issue") : nested(payload, "pull_request");
  const number = count(subject, "number");
  if (number === undefined) return null;

  const base: Record<string, unknown> = {
    repository: repo,
    // The owner too, because two guilds may watch same-named repositories under
    // different organizations and a trigger should be able to tell them apart.
    owner: textOf(nested(nested(payload, "repository"), "owner"), "login") ?? null,
    number,
    title: textOf(subject, "title") ?? null,
    url: textOf(subject, "html_url") ?? null,
    author: textOf(nested(subject, "user"), "login") ?? null,
  };

  if (event === "pull_request") {
    base.reviewer =
      textOf(nested(payload, "requested_reviewer"), "login") ??
      textOf(nested(payload, "requested_team"), "slug") ??
      null;
  } else {
    const labels = nested(payload, "issue") as { labels?: unknown } | undefined;
    base.labels = Array.isArray(labels?.labels)
      ? labels.labels
          .map((label) => textOf(label, "name"))
          .filter((name): name is string => typeof name === "string")
      : [];
  }

  return { endpoint: announcement.id, repo, payload: base };
}
