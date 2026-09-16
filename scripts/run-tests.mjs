import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const vitest = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
const report = ".vitest-result.json";
const run = spawnSync(
  process.execPath,
  [
    vitest,
    "run",
    ...process.argv.slice(2),
    "--reporter=default",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  { stdio: "inherit" }
);

if (run.error) throw run.error;
if (run.status !== 0) process.exit(run.status ?? 1);

const assertion = spawnSync(
  process.execPath,
  [fileURLToPath(new URL("./assert-tests-ran.mjs", import.meta.url)), report],
  { stdio: "inherit" }
);
if (assertion.error) throw assertion.error;
process.exit(assertion.status ?? 1);
