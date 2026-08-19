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
import { installationToken } from "./app.js";
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

/** What the whole guild reads this repository with. */
async function guildAccess(
  workspace: StoredWorkspace | null
): Promise<{ token: string; workspace: StoredWorkspace } | { unavailable: string }> {
  if (!workspace) return NOT_CONFIGURED;
  if (workspace.installationId === null) return NOT_INSTALLED;
  const token = await installationToken(workspace.installationId);
  // Recorded as installed and now refusing to mint: the org removed the app
  // between the last sync and this call. The reconcile is what corrects the
  // record; this call has only to not pretend.
  if (!token) return NOT_INSTALLED;
  return { token, workspace };
}

export async function openIssues(
  claims: ContextClaims,
  params: URLSearchParams
): Promise<Record<string, unknown>> {
  // Guild-scoped: the organization's own grant, not the caller's account.
  const access = await guildAccess(await workspaceFor(claims.app_install_id));
  if ("unavailable" in access) return access;
  const { token, workspace } = access;

  const query = new URLSearchParams({ state: "open", per_page: "1" });
  const label = params.get("label");
  if (label) query.set("labels", label);

  const response = await fetch(
    `${config.github.apiBase}/repos/${workspace.owner}/${workspace.repo}/issues?${query}`,
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
  claims: ContextClaims
): Promise<Record<string, unknown>> {
  // Per member: `review-requested:@me` resolves against whoever's credential
  // this is, so this is the one source that has to be the caller's.
  const account = await credentialFor(claims.connection_refs?.account);
  if (!account) return NOT_CONNECTED;

  const workspace = await workspaceFor(claims.app_install_id);
  if (!workspace) return NOT_CONFIGURED;

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
  // Guild-scoped for the same reason as the count, and it matters more here:
  // this is the heaviest call this app makes, and it runs once per guild per
  // TTL rather than once per member.
  const access = await guildAccess(await workspaceFor(claims.app_install_id));
  if ("unavailable" in access) return access;
  const { token, workspace } = access;

  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const response = await fetch(
    `${config.github.apiBase}/repos/${workspace.owner}/${workspace.repo}` +
      `/issues?state=all&per_page=100&since=${encodeURIComponent(since)}`,
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
