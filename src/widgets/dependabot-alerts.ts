import type { Widget } from "initiative-app-kit";

import { READ_IDS } from "../vocabulary.js";

const SOURCE = READ_IDS.listAlerts;

export const dependabotAlertsWidget: Widget = {
  id: "dependabot-alerts",
  meta: {
    name: {
      en: "Dependabot alerts",
      de: "Dependabot-Warnungen",
      es: "Alertas de Dependabot",
      fr: "Alertes Dependabot",
    },
    description: {
      en: "Open dependency alerts, worst first.",
      de: "Offene Abhängigkeitswarnungen, die schlimmsten zuerst.",
      es: "Alertas de dependencias abiertas, las peores primero.",
      fr: "Alertes de dépendances ouvertes, les pires d'abord.",
    },
  },
  endpoints: [SOURCE],
  module_source: `
export default function render({ data }) {
  const rows = data[${JSON.stringify(SOURCE)}] ?? {};
  const severities = rows.severities ?? [];
  const counts = {};
  for (const severity of severities) {
    counts[severity] = (counts[severity] ?? 0) + 1;
  }
  // Worst first, and only the ones that happened — an empty "Low" line is noise.
  const shown = ["critical", "high", "medium", "low"].filter((s) => counts[s]);
  if (!shown.length) {
    return { kind: "empty", label: "No open Dependabot alerts" };
  }
  return {
    kind: "list",
    items: shown.map((severity) => ({
      label: severity.charAt(0).toUpperCase() + severity.slice(1)
        + " \\u00b7 " + counts[severity],
      href: rows.url,
    })),
  };
}
`.trim(),
  sample_data: {
    [SOURCE]: {
      severities: ["critical", "high", "high", "medium", "medium", "medium", "medium"],
      packages: ["left-pad", "lodash", "lodash", "minimist", "minimist", "qs", "qs"],
      count: 7,
      total: 7,
      url: "#",
    },
  },
  requires: { all_of: ["workspace", "account"] },
};
