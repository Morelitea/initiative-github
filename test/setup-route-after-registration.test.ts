/**
 * A completed registration closes setup even if an operator has not removed
 * the setup token yet.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SETUP_TOKEN_ENV } from "initiative-app-kit";

let child: ChildProcessWithoutNullStreams;
let origin: string;

beforeAll(async () => {
  child = spawn("node_modules/.bin/tsx", ["test/support/registered-server.ts"], {
    env: {
      ...process.env,
      INITIATIVE_APP_SECRET: "test-registration-secret",
      INITIATIVE_BASE_URL: "https://initiative.test",
      APP_PUBLIC_URL: "https://github-app.test",
      DATABASE_URL: "postgres://localhost/initiative_github_test",
      APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      [SETUP_TOKEN_ENV]: "left-behind-setup-token",
      GITHUB_CLIENT_ID: "registered-client",
      GITHUB_CLIENT_SECRET: "registered-secret",
      GITHUB_APP_PRIVATE_KEY: [
        "-----BEGIN RSA PRIVATE KEY-----",
        "registered-key",
        "-----END RSA PRIVATE KEY-----",
      ].join("\n"),
      GITHUB_WEBHOOK_SECRET: "registered-webhook",
    },
  });

  const lines = createInterface({ input: child.stdout });
  const outcome = await Promise.race([
    once(lines, "line").then(([line]) => ({ line: String(line) })),
    once(child, "exit").then(([code]) => ({ code })),
  ]);
  if (!("line" in outcome)) {
    throw new Error(`registered test server exited with ${outcome.code}`);
  }
  origin = `http://127.0.0.1:${JSON.parse(outcome.line).port}`;
});

afterAll(async () => {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit");
});

describe("setup after registration", () => {
  it.each([
    ["GET", undefined],
    [
      "POST",
      new URLSearchParams({ token: "left-behind-setup-token", org: "attacker-org" }),
    ],
  ])("refuses %s while a setup token remains configured", async (method, body) => {
    const response = await fetch(`${origin}/setup/register?org=attacker-org`, {
      method,
      headers: body ? { "Content-Type": "application/x-www-form-urlencoded" } : undefined,
      body,
    });

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("settings/apps/new");
  });
});
