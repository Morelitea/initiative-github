import type { Widget } from "initiative-app-kit";

import { READ_IDS } from "../vocabulary.js";
import { WHY_NOTHING } from "./unavailable.js";

const SOURCE = READ_IDS.findPullRequests;

export const reviewQueueWidget: Widget = {
  id: "review-queue",
  meta: {
    name: {
      en: "Waiting on you",
      de: "Wartet auf dich",
      es: "Esperando por ti",
      fr: "En attente de vous",
    },
    description: {
      en: "Pull requests that asked for your review.",
      de: "Pull Requests, die deine Review angefragt haben.",
      es: "Pull requests que pidieron tu revisión.",
      fr: "Pull requests qui ont demandé votre revue.",
    },
  },
  endpoints: [SOURCE],
  module_source: `
${WHY_NOTHING}

function render(data) {
  const nothing = missing(data);
  if (nothing) return nothing;
  const rows = data.rows ?? [];
  if (!rows.length) {
    return { v: 1, scene: { kind: "empty", message: "Nothing is waiting on you" } };
  }
  return {
    v: 1,
    scene: {
      kind: "table",
      columns: [
        { key: "number", label: "#", align: "end" },
        { key: "title", label: "Pull request" },
      ],
      rows: rows.slice(0, 10).map((row) => ({
        number: row.numbers ?? "",
        title: row.titles ?? "",
      })),
    },
  };
}
`.trim(),
  sample_data: {
    [SOURCE]: {
      numbers: [812, 809],
      titles: ["Cache the issue counts", "Drop the unused index"],
      urls: ["#", "#"],
      count: 2,
      total: 2,
    },
  },
  requires: { all_of: ["workspace", "account"] },
};
