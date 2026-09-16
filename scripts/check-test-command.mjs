import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

function runWithName(pattern) {
  const result = spawnSync("npm", ["test", "--", `--testNamePattern=${pattern}`], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: process.env,
  });
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

test("npm test forwards a matching name filter to Vitest", () => {
  const result = runWithName("declares every operation under this app's own name");

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /1 of \d+ test\(s\) executed/);
});

test("npm test rejects a name filter that executes nothing", () => {
  const result = runWithName("__definitely_no_test_matches__");

  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /executed none of them/);
});
