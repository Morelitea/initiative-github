/**
 * The half an organization owns: installing this app at GitHub.
 *
 * Not a login, and it deliberately shares nothing with one. Nobody authorizes
 * anything here, no code is exchanged, and no credential is stored — an owner
 * grants the app access to an account on GitHub's own page, and what comes back
 * is an *installation*. The credential that installation implies is minted from
 * this app's private key when it is needed and belongs to nobody.
 *
 * That is why this is its own module and its own pair of routes. Sending an
 * install through the authorization callback meant a code arriving for a person
 * nobody asked about, and an app left re-deriving from a query parameter which
 * of the two trips it had started. GitHub already answers that by choosing
 * where to return: an installation goes to the setup URL, an authorization goes
 * to the callback.
 *
 * Initiative's part is the one thing GitHub cannot answer — which installation
 * is this guild's — and this is where the two are joined.
 */

import {
  beginAuthorization,
  exchangeCode,
  fetchJson,
  type ConnectOutcome,
} from "initiative-app-kit";

import { config } from "../config.js";
import { initiative } from "../initiative.js";
import { VERIFY_PATH } from "../vocabulary.js";
import { appIdentity } from "./app.js";
import { claimHandoff, rememberHandoff } from "./handoff.js";

/**
 * Send a guild admin to GitHub's own install page.
 *
 * `null` when GitHub will not name this app's registration, which the caller
 * turns into a page saying so. There is no falling back to the authorization
 * step: that one ends by storing a credential, and this trip is not about one.
 *
 * Whoever follows this may not be able to finish it, and that is GitHub's to
 * handle rather than ours. A member of an organization who cannot install apps
 * is offered a request for an owner to approve, on the same page, and comes
 * back saying so.
 */
export async function beginInstall(
  connectionRef: string,
  guildId: number,
  returnUrl: string | null
): Promise<string | null> {
  const app = await appIdentity();
  if (!app) return null;

  // The install page is not an authorization request. GitHub preserves the
  // `state` it documents and drops what it does not, so this sends a state and
  // nothing else — no challenge, and therefore no verifier stored against a
  // binding GitHub never made.
  const auth = beginAuthorization({ pkce: false });

  await rememberHandoff(auth, connectionRef, guildId, returnUrl);
  return `${config.github.webBase}/apps/${app.slug}/installations/new?${auth.params}`;
}

const verifyUri = () => `${config.publicUrl}${VERIFY_PATH}`;

/**
 * How a trip through the install page ended.
 *
 * `verifying` is the one that is not an ending at all: the person is being sent
 * on to prove that the installation they came back naming is one they actually
 * hold. `requested` is an ending with no installation behind it — a member of
 * an organization asked an owner to approve one — and it is a word of its own
 * because nothing failed and the remedy is to wait.
 */
export type SetupOutcome = ConnectOutcome | "verifying" | "requested" | "elsewhere";

export interface SetupResult {
  outcome: SetupOutcome;
  home: string | null;
  /** Where to send them next, when the claim still has to be proved. */
  authorize?: string;
  /** The guild whose installation was just recorded, for the caller to sync. */
  installedFor?: number;
}

/**
 * The return from GitHub's install page, which settles nothing on its own.
 *
 * GitHub documents the `installation_id` here as untrustworthy: anybody can hit
 * this route with one, including an id belonging to an organization they have
 * nothing to do with. Believing it would let a guild admin bind somebody else's
 * installation to their own guild and read that organization's repositories
 * through this app, because the credential behind an installation is minted
 * from this app's key and would be minted just the same.
 *
 * So the id is taken as a claim and the person is sent to authorize. That step
 * is not a sign-in and stores nothing: it exists to answer one question, which
 * is whether GitHub agrees this installation is theirs.
 */
export async function completeInstall(
  params: URLSearchParams
): Promise<SetupResult> {
  const handoff = await claimHandoff(params.get("state") ?? "");

  // No state is a trip this app did not start — a link somebody kept, or a
  // replay. There is nothing to bind and nobody to hand back to.
  if (!handoff) return { outcome: "elsewhere", home: null };

  const home = handoff.returnUrl;

  // An owner has to approve before there is anything to claim. GitHub says so
  // with `setup_action=request` and no installation.
  if (params.get("setup_action") === "request") {
    return { outcome: "requested", home };
  }

  const named = params.get("installation_id");
  const claimed = Number(named);
  if (!named || !Number.isSafeInteger(claimed) || handoff.guildId === null) {
    return { outcome: "refused", home };
  }

  const auth = beginAuthorization({
    clientId: config.github.clientId,
    redirectUri: verifyUri(),
  });

  await rememberHandoff(auth, handoff.connectionRef, handoff.guildId, home, claimed);

  return {
    outcome: "verifying",
    home,
    authorize: `${config.github.webBase}/login/oauth/authorize?${auth.params}`,
  };
}

/**
 * The installations GitHub says this person holds, asked as them.
 *
 * The whole of the check, and the reason the trip above exists. `null` is
 * GitHub not answering, which is not the same as a claim being false and is
 * never treated as one.
 */
async function heldBy(accessToken: string): Promise<Map<number, string> | null> {
  const answer = await fetchJson<{ installations?: unknown }>(
    `${config.github.apiBase}/user/installations?per_page=100`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
      },
    }
  );

  if (!answer.ok) {
    console.error(`could not read which installations they hold: ${answer.detail}`);
    return null;
  }

  const listed = answer.body.installations;
  if (!Array.isArray(listed)) return null;

  const held = new Map<number, string>();
  for (const entry of listed) {
    const one = entry as { id?: unknown; account?: { login?: unknown } } | null;
    if (typeof one?.id === "number" && typeof one.account?.login === "string") {
      held.set(one.id, one.account.login);
    }
  }
  return held;
}

/**
 * The end of it: the claim checked, and the installation written down.
 *
 * The token exchanged here is spent on one question and dropped. It is not
 * stored and no connection is satisfied by it — the person's own account is a
 * separate thing they connect separately, and conflating the two would leave a
 * credential filed against the guild's connection rather than theirs.
 *
 * The account comes out of the same answer that proved the claim, which is why
 * nothing else has to be asked: the installation this person holds is the
 * installation, and its account is the owner.
 */
export async function completeVerify(
  params: URLSearchParams
): Promise<SetupResult> {
  const handoff = await claimHandoff(params.get("state") ?? "");
  if (!handoff) return { outcome: "expired", home: null };

  const home = handoff.returnUrl;
  const claimed = handoff.claimedInstallation;
  const code = params.get("code") ?? "";

  if (claimed === null || handoff.guildId === null) {
    return { outcome: "refused", home };
  }
  if (!code) return { outcome: "refused", home };

  const exchanged = await exchangeCode({
    tokenUrl: `${config.github.webBase}/login/oauth/access_token`,
    clientId: config.github.clientId,
    clientSecret: config.github.clientSecret,
    code,
    redirectUri: verifyUri(),
    verifier: handoff.codeVerifier,
  });

  if (!exchanged.ok) {
    console.error(`the installer's authorization did not complete: ${exchanged.detail}`);
    return { outcome: "refused", home };
  }

  const held = await heldBy(exchanged.grant.accessToken);
  if (!held) return { outcome: "not_recorded", home };

  const owner = held.get(claimed);
  if (!owner) {
    // Either a spoofed id or an installation they have since lost access to.
    // Both are the same answer: GitHub does not agree this is theirs, so
    // nothing is written down.
    console.warn(`installation ${claimed} was claimed by somebody who does not hold it`);
    return { outcome: "refused", home };
  }

  try {
    await initiative.writeConnection(handoff.guildId, handoff.connectionRef, {
      values: { owner, installation_id: claimed },
      status: "connected",
    });
  } catch (error) {
    console.error(`could not record installation ${claimed}`, error);
    return { outcome: "not_recorded", home };
  }

  return { outcome: "connected", home, installedFor: handoff.guildId };
}
