/**
 * What this app answers when Initiative asks for a data source.
 *
 * **Scope each source to the narrowest thing that answers it**, and let the
 * manifest say which. Two of these are guild-scoped: how many issues are open,
 * and how the last fortnight went, are one answer for the whole guild. They run
 * on the **installation** — the grant an organization made when it installed
 * this GitHub App — so nobody hands over a personal account to see a number,
 * and because they name no per-member connection the platform caches each once
 * per guild rather than once per member.
 *
 * The third is per member and could not be anything else: "waiting on my
 * review" has no meaning without a me. It runs on the credential behind the
 * handle the context token carries, so it shows that member exactly what they
 * can see at GitHub and nothing they cannot.
 *
 * Getting this backwards is the easy mistake, and it hides well — answering a
 * shared question from the caller's own token returns the right number, while
 * quietly requiring every member to connect and turning one upstream call into
 * one per person.
 *
 * **Return only what the widget draws.** A source's response is handed to a
 * sandboxed widget module and cached. Sending the vendor's whole payload would
 * put data nobody renders into a cache and into a browser.
 */

import type { ContextClaims } from "initiative-app-kit";

import { config } from "../config.js";
import { installationToken, resolveRepository } from "./app.js";
import { credentialFor } from "./oauth.js";
import { workspaceFor, type StoredWorkspace } from "./workspace.js";

/** What a per-member source returns when that member has not connected. */
const NOT_CONNECTED = { unavailable: "not-connected" } as const;

/** What any source returns when the guild's own setup is incomplete. */
const NOT_CONFIGURED = { unavailable: "not-configured" } as const;

/**
 * What a guild-scoped source returns when nobody has installed the app.
 *
 * Distinct from `not-configured` on purpose, because the remedy is different
 * and belongs to a different person: `not-configured` is a form a guild admin
 * has not finished in Initiative, and this is a GitHub App an organization
 * owner has not installed at GitHub. One tile saying "unavailable" for both
 * would send the wrong person looking.
 */
const NOT_INSTALLED = { unavailable: "not-installed" } as const;

interface Access {
  token: string;
  owner: string;
  repo: string;
}

/**
 * Which repository this call is about, and the token to read it with.
 *
 * The repository half is {@link resolveRepository}, which the write path uses
 * too; this adds the credential a guild-scoped read runs on.
 */
async function access(
  workspace: StoredWorkspace | null,
  params?: URLSearchParams
): Promise<Access | { unavailable: string }> {
  const choice = await resolveRepository(workspace, params?.get("repo"));
  if ("unavailable" in choice) return choice;

  // Non-null by construction: `resolveRepository` refuses before this when
  // there is no installation to mint against.
  const token = await installationToken(workspace!.installationId!);
  // Recorded as installed and now refusing to mint: the org removed the app
  // between the last sync and this call. The reconcile is what corrects the
  // record; this call has only to not pretend.
  if (!token) return NOT_INSTALLED;

  return { token, owner: choice.owner, repo: choice.repo };
}

export async function openIssues(
  claims: ContextClaims,
  params: URLSearchParams
): Promise<Record<string, unknown>> {
  // Guild-scoped: the organization's own grant, not the caller's account.
  const where = await access(await workspaceFor(claims.app_install_id), params);
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
  // Per member: `review-requested:@me` resolves against whoever's credential
  // this is, so this is the one source that has to be the caller's.
  const account = await credentialFor(claims.connection_refs?.account);
  if (!account) return NOT_CONNECTED;

  // Which repository is still the guild's question, and still checked against
  // the organization's grant — the member's token narrows what they see inside
  // it, and cannot widen which repository is asked about.
  const where = await access(await workspaceFor(claims.app_install_id), params);
  if ("unavailable" in where) return where;
  const { owner, repo } = where;

  const response = await fetch(
    `${config.github.apiBase}/search/issues?q=` +
      encodeURIComponent(`repo:${owner}/${repo} is:pr is:open review-requested:@me`),
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

/** How severe an alert is, worst first — the order the widget draws them in. */
const SEVERITIES = ["critical", "high", "medium", "low"] as const;

export async function dependabotAlerts(
  claims: ContextClaims,
  params: URLSearchParams
): Promise<Record<string, unknown>> {
  // Guild-scoped: how exposed the repository is right now is one answer for
  // everybody, and the people who most need to see it are the ones least likely
  // to have connected a personal GitHub account.
  const where = await access(await workspaceFor(claims.app_install_id), params);
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
  const where = await access(await workspaceFor(claims.app_install_id), params);
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
