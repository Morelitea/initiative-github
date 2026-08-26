import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SETTINGS } from "../src/config.js";
import { PUBLIC_ID } from "../src/vocabulary.js";

export const CONTRACT_PATH = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "env-contract.json"
);

export function envContract(): string {
  return `${JSON.stringify(
    {
      service: "initiative-github",
      public_id: PUBLIC_ID,
      required: [...SETTINGS.required],
      optional: [...SETTINGS.optional],
    },
    null,
    2
  )}\n`;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  writeFileSync(CONTRACT_PATH, envContract(), "utf-8");
  process.stdout.write("wrote env-contract.json\n");
}
