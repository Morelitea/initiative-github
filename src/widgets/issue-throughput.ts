import type { Widget } from "initiative-app-kit";

import { READ_IDS } from "../vocabulary.js";

const SOURCE = READ_IDS.findIssues;

export const issueThroughputWidget: Widget = {
  id: "issue-throughput",
  meta: {
    name: {
      en: "Issues opened and closed",
      de: "Geöffnete und geschlossene Issues",
      es: "Incidencias abiertas y cerradas",
      fr: "Tickets ouverts et fermés",
    },
    description: {
      en: "A fortnight of opens against closes.",
      de: "Zwei Wochen Öffnungen gegen Schließungen.",
      es: "Dos semanas de aperturas frente a cierres.",
      fr: "Deux semaines d'ouvertures contre fermetures.",
    },
  },
  endpoints: [SOURCE],
  module_source: `
export default function render({ data }) {
  const rows = data[${JSON.stringify(SOURCE)}] ?? {};
  const days = new Map();
  const bucket = (iso) => {
    const day = iso.slice(0, 10);
    if (!days.has(day)) days.set(day, { opened: 0, closed: 0 });
    return days.get(day);
  };
  for (const iso of rows.created_at ?? []) {
    if (iso) bucket(iso).opened += 1;
  }
  for (const iso of rows.closed_at ?? []) {
    if (iso) bucket(iso).closed += 1;
  }
  // ISO dates sort as text, which is the one thing that makes this cheap.
  const points = [...days.entries()].sort((left, right) =>
    left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0
  );
  return {
    kind: "series",
    x: points.map((point) => point[0]),
    series: [
      { label: "Opened", values: points.map((point) => point[1].opened) },
      { label: "Closed", values: points.map((point) => point[1].closed) },
    ],
  };
}
`.trim(),
  sample_data: {
    [SOURCE]: {
      created_at: [
        "2026-08-17T09:00:00Z",
        "2026-08-17T11:00:00Z",
        "2026-08-18T09:00:00Z",
        "2026-08-19T09:00:00Z",
      ],
      closed_at: ["2026-08-17T15:00:00Z", "2026-08-19T15:00:00Z", "", ""],
      count: 4,
      total: 4,
    },
  },
  requires: { all_of: ["workspace", "account"] },
};
