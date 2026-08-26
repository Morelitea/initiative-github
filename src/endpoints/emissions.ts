import type { Endpoint, EndpointReturn, LocalizedText } from "initiative-app-kit";

import { declare } from "../vocabulary.js";

function text(en: string, de: string, es: string, fr: string): LocalizedText {
  return { en, de, es, fr };
}

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

interface Announcement {
  id: string;
  label: LocalizedText;
  description: LocalizedText;
}

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

const SUBJECT: readonly EndpointReturn[] = [
  value("repository", "string", "Repository", "Repository", "Repositorio", "Dépôt"),
  value("owner", "string", "Owner", "Inhaber", "Propietario", "Propriétaire"),
  value("number", "int", "Number", "Nummer", "Número", "Numéro"),
  value("title", "string", "Title", "Titel", "Título", "Titre"),
  value("url", "url", "Link", "Link", "Enlace", "Lien"),
  value("author", "string", "Author", "Autor", "Autor", "Auteur"),
];

const PER_DELIVERY: Record<string, { group: string; carries: EndpointReturn }> = {
  issues: {
    group: "issues",
    carries: {
      ...value("labels", "string", "Labels", "Labels", "Etiquetas", "Étiquettes"),
      list: true,
    },
  },
  pull_request: {
    group: "reviews",

    carries: value("reviewer", "string", "Reviewer", "Reviewer", "Revisor", "Relecteur"),
  },
};

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

export const EMITTED: readonly string[] = EMIT_ENDPOINTS.map((endpoint) => endpoint.id);

export const SUBSCRIBED_EVENTS: readonly string[] = Object.keys(PUBLISHED).sort();

export interface TranslatedEvent {
    endpoint: string;
    repo: string;
  payload: Record<string, unknown>;
}

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

export function translate(
  event: string,
  payload: Record<string, unknown>
): TranslatedEvent | null {
  const actions = PUBLISHED[event];
  if (!actions) return null;

  const action = textOf(payload, "action");
  const announcement = action ? actions[action] : undefined;
  if (!announcement) return null;

  const repo = textOf(nested(payload, "repository"), "name");
  if (!repo) return null;

  const subject = event === "issues" ? nested(payload, "issue") : nested(payload, "pull_request");
  const number = count(subject, "number");
  if (number === undefined) return null;

  const base: Record<string, unknown> = {
    repository: repo,

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
