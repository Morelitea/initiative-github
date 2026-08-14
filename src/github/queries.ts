/**
 * What this app answers when Initiative asks for a data source.
 *
 * Two rules a source has to keep, and both are visible here:
 *
 * **Answer for the caller, not for the app.** The context token carries the
 * `connection_refs` for this call; the credential used is the one behind the
 * handle. A source that answered from some app-wide token would show every
 * member the same thing, and would show them things they cannot see at the
 * vendor — the platform cannot check that for you.
 *
 * **Return only what the widget draws.** A source's response is handed to a
 * sandboxed widget module and cached per guild. Sending the vendor's whole
 * payload would put data nobody renders into a cache and into a browser.
 */

import { config } from "../config.js";
import type { ContextClaims } from "initiative-app-kit";

import { credentialFor } from "./oauth.js";
import { workspaceFor } from "./workspace.js";

/** What a source returns when the member has not connected their account. */
const NOT_CONNECTED = { unavailable: "not-connected" } as const;

export async function openIssues(
  claims: ContextClaims,
  params: URLSearchParams
): Promise<Record<string, unknown>> {
  const account = credentialFor(claims.connection_refs?.account);
  if (!account) return NOT_CONNECTED;

  const workspace = workspaceFor(claims.app_install_id);
  if (!workspace) return { unavailable: "not-configured" };

  const query = new URLSearchParams({
    state: "open",
    per_page: "1",
  });
  const label = params.get("label");
  if (label) query.set("labels", label);

  const response = await fetch(
    `${config.github.apiBase}/repos/${workspace.owner}/${workspace.repo}/issues?${query}`,
    {
      headers: {
        Authorization: `Bearer ${account.accessToken}`,
        Accept: "application/vnd.github+json",
      },
    }
  );
  if (!response.ok) return { unavailable: "vendor-error" };

  // GitHub reports the count in the Link header rather than the body when
  // paginating; a real app would parse it. The shape is what matters here.
  const total = Number(response.headers.get("x-total-count") ?? 0);

  // Only what the widget draws.
  return { total, delta: 0 };
}

export async function reviewQueue(
  claims: ContextClaims
): Promise<Record<string, unknown>> {
  const account = credentialFor(claims.connection_refs?.account);
  if (!account) return NOT_CONNECTED;

  const workspace = workspaceFor(claims.app_install_id);
  if (!workspace) return { unavailable: "not-configured" };

  const response = await fetch(
    `${config.github.apiBase}/search/issues?q=` +
      encodeURIComponent(
        `repo:${workspace.owner}/${workspace.repo} is:pr is:open review-requested:@me`
      ),
    {
      headers: {
        Authorization: `Bearer ${account.accessToken}`,
        Accept: "application/vnd.github+json",
      },
    }
  );
  if (!response.ok) return { unavailable: "vendor-error" };

  const body = (await response.json()) as {
    total_count?: number;
    items?: Array<{ number: number; title: string; html_url: string }>;
  };

  return {
    total: body.total_count ?? 0,
    // Trimmed to the three fields the surface renders, rather than the vendor's
    // whole item.
    items: (body.items ?? []).slice(0, 10).map((item) => ({
      number: item.number,
      title: item.title,
      url: item.html_url,
    })),
  };
}

export async function issueThroughput(
  claims: ContextClaims
): Promise<Record<string, unknown>> {
  const account = credentialFor(claims.connection_refs?.account);
  if (!account) return NOT_CONNECTED;

  const workspace = workspaceFor(claims.app_install_id);
  if (!workspace) return { unavailable: "not-configured" };

  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const response = await fetch(
    `${config.github.apiBase}/repos/${workspace.owner}/${workspace.repo}` +
      `/issues?state=all&per_page=100&since=${encodeURIComponent(since)}`,
    {
      headers: {
        Authorization: `Bearer ${account.accessToken}`,
        Accept: "application/vnd.github+json",
      },
    }
  );
  if (!response.ok) return { unavailable: "vendor-error" };

  const issues = (await response.json()) as Array<{
    created_at: string;
    closed_at: string | null;
    pull_request?: unknown;
  }>;

  // Bucketed here rather than in the widget: a widget module runs in a sandbox
  // with a time budget, and a fortnight of raw issues is not what it draws.
  const days = new Map<string, { opened: number; closed: number }>();
  const bucket = (iso: string) => {
    const day = iso.slice(0, 10);
    if (!days.has(day)) days.set(day, { opened: 0, closed: 0 });
    return days.get(day)!;
  };

  for (const issue of issues) {
    // GitHub returns pull requests from the issues endpoint; this counts issues.
    if (issue.pull_request) continue;
    bucket(issue.created_at).opened += 1;
    if (issue.closed_at) bucket(issue.closed_at).closed += 1;
  }

  const points = [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, counts]) => ({ day, ...counts }));

  return { points };
}
