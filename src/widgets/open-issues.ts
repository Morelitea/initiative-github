import type { Widget } from "initiative-app-kit";

import { READ_IDS } from "../vocabulary.js";
import { WHY_NOTHING } from "./unavailable.js";

const SOURCE = READ_IDS.findIssues;

export const openIssuesWidget: Widget = {
  id: "open-issues",
  meta: {
    name: {
      en: "Open issues",
      de: "Offene Issues",
      es: "Incidencias abiertas",
      fr: "Tickets ouverts",
    },
    description: {
      en: "How many issues are open.",
      de: "Wie viele Issues offen sind.",
      es: "Cuántas incidencias están abiertas.",
      fr: "Combien de tickets sont ouverts.",
    },
  },
  endpoints: [SOURCE],

  module_source: `
${WHY_NOTHING}

function render(data) {
  const nothing = missing(data);
  if (nothing) return nothing;
  const values = data.values ?? {};
  return {
    v: 1,
    scene: {
      kind: "metric",
      value: typeof values.total === "number" ? values.total : (data.rows ?? []).length,
      label: "Open issues",
    },
  };
}
`.trim(),

  sample_data: {
    [SOURCE]: { numbers: [812], titles: ["Cache the issue counts"], count: 1, total: 42 },
  },

  requires: { all_of: ["workspace", "account"] },
};
