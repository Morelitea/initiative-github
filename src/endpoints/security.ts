import type { Caller } from "./index.js";
import { config } from "../config.js";
import type { Read } from "./index.js";
import {
  COUNT_OUT,
  READ_IDS,
  REPO,
  TOTAL_OUT,
  UNAVAILABLE,
  URL_OUT,
  many,
  text,
} from "../vocabulary.js";
import type {
  Connection,
} from "../github/api.js";
import {
  NOT_FOUND,
  PAGE,
  access,
  empty,
  graphql,
  plain,
  rows,
  states,
} from "../github/api.js";
import {
  where,
} from "../github/api.js";

export const listAlerts: Read = {
  declaration: {
    id: READ_IDS.listAlerts,
    direction: "read",
    label: text(
      "Dependabot alerts",
      "Dependabot-Warnungen",
      "Alertas de Dependabot",
      "Alertes Dependabot"
    ),
    description: text(
      "Open dependency alerts, with the severity and package of each.",
      "Offene Abhängigkeitswarnungen, mit Schwere und Paket zu jeder.",
      "Alertas de dependencias abiertas, con la severidad y el paquete de cada una.",
      "Alertes de dépendances ouvertes, avec la gravité et le paquet de chacune."
    ),
    group: "security",
    actors: ["member"],
    visibility: "member",

    cache_ttl_seconds: 300,
    params: [REPO],

    returns: [
      many("numbers", "int", "Alert numbers", "Warnungsnummern", "Números de alerta", "Numéros d'alerte"),
      many("severities", "string", "Severities", "Schweregrade", "Severidades", "Gravités"),
      many("packages", "string", "Packages", "Pakete", "Paquetes", "Paquets"),
      many("urls", "url", "Links", "Links", "Enlaces", "Liens"),
      COUNT_OUT,
      TOTAL_OUT,

      URL_OUT,
      UNAVAILABLE,
    ],
    requires: { all_of: ["workspace", "account"] },
  },

  async run(caller: Caller, params: URLSearchParams) {
    const where = await access(caller, params);
    if ("unavailable" in where) return where;
    const { token, owner, repo } = where;

    const answer = await graphql<{
      repository: {
        vulnerabilityAlerts: Connection<{
          number?: number;
          securityVulnerability?: {
            severity?: string;
            package?: { name?: string };
          } | null;
        }>;
      } | null;
    }>(
      token,
      `query Alerts($owner: String!, $repo: String!, $first: Int!) {
         repository(owner: $owner, name: $repo) {
           vulnerabilityAlerts(first: $first, states: [OPEN]) {
             totalCount
             nodes { number securityVulnerability { severity package { name } } }
           }
         }
       }`,
      { owner, repo, first: PAGE }
    );

    if (empty(answer)) return answer;
    if (!answer.body.repository) return NOT_FOUND;

    const alerts = rows(answer.body.repository.vulnerabilityAlerts);
    const security = `${config.github.webBase}/${owner}/${repo}/security/dependabot`;

    return {
      numbers: alerts.map((alert) => alert.number ?? 0),

      severities: alerts.map((alert) => {
        // GraphQL says MODERATE where the rest of GitHub says medium.
      const severity = plain(alert.securityVulnerability?.severity);
        return severity === "moderate" ? "medium" : (severity ?? "");
      }),
      packages: alerts.map((alert) => alert.securityVulnerability?.package?.name ?? ""),
      urls: alerts.map((alert) => `${security}/${alert.number ?? ""}`),
      count: alerts.length,
      total: answer.body.repository.vulnerabilityAlerts.totalCount ?? alerts.length,

      url: security,
    };
  },
};
