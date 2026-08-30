import type { Widget } from "initiative-app-kit";

import { READ_IDS } from "../vocabulary.js";
import { WHY_NOTHING } from "./unavailable.js";

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
${WHY_NOTHING}

function render(data) {
  const nothing = missing(data);
  if (nothing) return nothing;
  const counts = {};
  for (const row of data.rows ?? []) {
    const severity = row.severities;
    if (severity) counts[severity] = (counts[severity] ?? 0) + 1;
  }
  // Worst first, and only the ones that happened — an empty "Low" bar is noise.
  const shown = ["critical", "high", "medium", "low"].filter((s) => counts[s]);
  if (!shown.length) {
    return { v: 1, scene: { kind: "empty", message: "No open Dependabot alerts" } };
  }
  return {
    v: 1,
    scene: {
      kind: "series",
      mark: "bar",
      series: [
        {
          name: "Alerts",
          points: shown.map((severity) => ({
            x: severity.charAt(0).toUpperCase() + severity.slice(1),
            y: counts[severity],
          })),
        },
      ],
    },
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
