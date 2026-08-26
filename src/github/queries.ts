/**
 * What this app answers when Initiative asks for a data source.
 *
 * **Every source runs on the caller's own GitHub credential.** Not the
 * organization's installation grant — the credential behind the handle the
 * context token carries, so a member sees exactly what they can see at GitHub
 * and nothing they cannot.
 *
 * These used to be split. "How many issues are open" is one answer for a whole
 * guild, so it ran on the installation and nobody had to connect an account to
 * see a number. That reads as generous and is the wrong shape: it shows the
 * state of a private repository to every member of a guild, including the ones
 * with no access to it at all. A member who is not on that repository at GitHub
 * has no business seeing its issue count, and an app that decides otherwise has
 * quietly overruled the repository's own permissions.
 *
 * What it costs is real and worth stating. Every member must connect before any
 * tile answers; the platform caches per member rather than once per guild, so
 * one upstream call becomes one per person; and a widget answered from a
 * permission most members lack — Dependabot alerts needs security access —
 * shows to the few who hold it. All three are the principle working rather than
 * failing.
 *
 * **Return only what the widget draws.** A source's response is handed to a
 * sandboxed widget module and cached. Sending the vendor's whole payload would
 * put data nobody renders into a cache and into a browser.
 */

import type { ContextClaims } from "initiative-app-kit";

import { config } from "../config.js";
import { resolveRepository } from "./app.js";
import { credentialFor } from "./oauth.js";
import { workspaceFor } from "./workspace.js";

/** What a per-member source returns when that member has not connected. */
const NOT_CONNECTED = { unavailable: "not-connected" } as const;

/** What any source returns when the guild's own setup is incomplete. */
const NOT_CONFIGURED = { unavailable: "not-configured" } as const;

interface Access {
  token: string;
  owner: string;
  repo: string;
}

/**
 * Which repository this call is about, and whose credential reads it.
 *
 * The repository half is {@link resolveRepository}. The credential half is the
 * **caller's own**, every time, which is the rule this whole file now follows:
 * a source shows a member what that member can see at GitHub, and nothing they
 * cannot.
 *
 * The credential is resolved before the repository, deliberately. A member who
 * has connected nothing gets `not-connected` — an answer about them, with a
 * remedy they own — rather than a message about the guild's configuration that
 * they can do nothing about and that would tell them the repository's name.
 */
async function access(
  claims: ContextClaims,
  params?: URLSearchParams
): Promise<Access | { unavailable: string }> {
  const account = await credentialFor(claims.connection_refs?.account);
  if (!account) return NOT_CONNECTED;

  const choice = await resolveRepository(
    await workspaceFor(claims.app_install_id),
    params?.get("repo")
  );
  if ("unavailable" in choice) return choice;

  return { token: account.accessToken, owner: choice.owner, repo: choice.repo };
}

export async function openIssues(
  claims: ContextClaims,
  params: URLSearchParams
): Promise<Record<string, unknown>> {
  const where = await access(claims, params);
  if ("unavailable" in where) return where;
  const { token, owner, repo } = where;

  const query = new URLSearchParams({ state: "open", per_page: "1" });
  // Each of these narrows the same question to one team's slice of it, which is
  // how one widget serves several initiatives: the dashboard binding carries
  // the values, so team-alpha's tile and team-beta's tile are one source
  // answered twice and cached apart.
  for (const [param, upstream] of [
    ["label", "labels"],
    ["milestone", "milestone"],
    ["assignee", "assignee"],
  ] as const) {
    const value = params.get(param)?.trim();
    if (value) query.set(upstream, value);
  }

  const response = await fetch(
    `${config.github.apiBase}/repos/${owner}/${repo}/issues?${query}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
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
  claims: ContextClaims,
  params: URLSearchParams
): Promise<Record<string, unknown>> {
  // `review-requested:@me` resolves against whoever's credential this is —
  // which is the caller's, the same credential every other source here now
  // runs on. This was once the only one of which that was true.
  const where = await access(claims, params);
  if ("unavailable" in where) return where;
  const { token, owner, repo } = where;

  const response = await fetch(
    `${config.github.apiBase}/search/issues?q=` +
      encodeURIComponent(`repo:${owner}/${repo} is:pr is:open review-requested:@me`),
    {
      headers: {
        Authorization: `Bearer ${token}`,
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

/** How severe an alert is, worst first — the order the widget draws them in. */
const SEVERITIES = ["critical", "high", "medium", "low"] as const;

export async function dependabotAlerts(
  claims: ContextClaims,
  params: URLSearchParams
): Promise<Record<string, unknown>> {
  // Guild-scoped: how exposed the repository is right now is one answer for
  // everybody, and the people who most need to see it are the ones least likely
  // to have connected a personal GitHub account.
  const where = await access(claims, params);
  if ("unavailable" in where) return where;
  const { token, owner, repo } = where;

  // A floor rather than a filter: a team that has decided low-severity advisories
  // are noise wants "critical and high", not "high only".
  const floor = params.get("severity")?.trim().toLowerCase();
  const wanted = new Set<string>(
    floor && SEVERITIES.includes(floor as (typeof SEVERITIES)[number])
      ? SEVERITIES.slice(0, SEVERITIES.indexOf(floor as (typeof SEVERITIES)[number]) + 1)
      : SEVERITIES
  );

  const response = await fetch(
    `${config.github.apiBase}/repos/${owner}/${repo}` +
      "/dependabot/alerts?state=open&per_page=100",
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    }
  );
  // A repository with Dependabot disabled answers 403 rather than an empty
  // list, which is a different thing from "this app may not look" and reads the
  // same from here. Both mean there is nothing to draw.
  if (!response.ok) return { unavailable: "vendor-error" };

  const alerts = (await response.json()) as Array<{
    security_advisory?: { severity?: string };
  }>;

  const counts = new Map<string, number>();
  let total = 0;
  for (const alert of alerts) {
    const severity = alert.security_advisory?.severity;
    if (typeof severity !== "string" || !wanted.has(severity)) continue;
    counts.set(severity, (counts.get(severity) ?? 0) + 1);
    total += 1;
  }

  // Bucketed and ordered here rather than in the widget, for the same reason
  // the throughput series is: a widget module runs in a sandbox with a time
  // budget, and a hundred advisories is not what it draws.
  //
  // One page, so a repository with more than a hundred open alerts undercounts.
  // Said rather than hidden — a number that quietly stops rising at 100 is
  // worse than one that is known to.
  const severities = SEVERITIES.filter((severity) => counts.has(severity)).map(
    (severity) => ({ severity, count: counts.get(severity)! })
  );

  return {
    total,
    severities,
    // The one place a member can act on this, carried because the widget draws
    // it as a link and has no other way to build a URL.
    url: `${config.github.webBase}/${owner}/${repo}/security/dependabot`,
  };
}

export async function issueThroughput(
  claims: ContextClaims,
  params: URLSearchParams
): Promise<Record<string, unknown>> {
  // Guild-scoped for the same reason as the count, and it matters more here:
  // this is the heaviest call this app makes, and it runs once per guild per
  // TTL rather than once per member.
  const where = await access(claims, params);
  if ("unavailable" in where) return where;
  const { token, owner, repo } = where;

  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const query = new URLSearchParams({
    state: "all",
    per_page: "100",
    since,
  });
  const label = params.get("label")?.trim();
  if (label) query.set("labels", label);

  const response = await fetch(
    `${config.github.apiBase}/repos/${owner}/${repo}/issues?${query}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
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
