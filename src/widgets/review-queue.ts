import type { Widget } from "initiative-app-kit";

import { READ_IDS } from "../vocabulary.js";

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
export default function render({ data }) {
  const rows = data[${JSON.stringify(SOURCE)}] ?? {};
  const numbers = rows.numbers ?? [];
  if (!numbers.length) {
    return { kind: "empty", label: "Nothing is waiting on you" };
  }
  const titles = rows.titles ?? [];
  const urls = rows.urls ?? [];
  return {
    kind: "list",
    items: numbers.slice(0, 10).map((number, index) => ({
      label: "#" + number + " " + (titles[index] ?? ""),
      href: urls[index] ?? "",
    })),
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
