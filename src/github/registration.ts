/**
 * How this app describes itself **to GitHub**.
 *
 * There are two registrations in this app's life and they are easy to conflate
 * because both are "registering the app". They have different audiences and
 * neither derives from the other:
 *
 *   * The **Initiative** registration is an operator wiring up a container they
 *     decided to run, verified against `/.well-known/initiative-app.json`.
 *   * The **GitHub App** registration is this app becoming a party at GitHub —
 *     an identity an organization can install, with permissions it agreed to
 *     and events it will be sent.
 *
 * This file is the second one, and it exists as code for the same reason the
 * Initiative manifest does: a registration typed into a form by hand is a copy
 * of the app's requirements that nothing checks. Add a webhook the code handles
 * and forget the form, and the delivery never arrives. Ask for a permission the
 * code stopped using, and every org that installs it grants more than it needs,
 * forever, because permission changes require every one of them to re-approve.
 *
 * So the permissions and the events live here, once, and:
 *
 *   * `npm run github-app` writes them as a GitHub App manifest, which GitHub
 *     will accept as a filled-in registration form.
 *   * `test/github-app.test.ts` checks them against what the code actually
 *     does — every event this subscribes to is one the translator handles, and
 *     every URL is one the server serves.
 *
 * @see https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app
 */

import { stripTrailingSlashes } from "initiative-app-kit";

import {
  CALLBACK_PATH,
  REGISTERED_PATH,
  SETUP_PATH,
  WEBHOOK_PATH,
} from "../routes.js";
import { SUBSCRIBED_EVENTS } from "./emissions.js";

/**
 * What this app asks an organization for, and nothing beyond it.
 *
 * Read this list against what the code does, because a reviewer at an
 * organization will:
 *
 *   * `issues: write` — reading is how many are open and a fortnight of opens
 *     against closes; writing is opening one, commenting, closing, reopening
 *     and labelling. Labels ride this permission rather than one of their own,
 *     which is worth knowing before looking for a `labels` key that does not
 *     exist. The `issues` deliveries this app republishes need only the read.
 *   * `pull_requests: write` — reading is "which pull requests are waiting on
 *     my review"; writing is requesting one. Commenting on a pull request does
 *     *not* need this: pull requests and issues share a comments endpoint and a
 *     number space, so a comment is an issues write wherever it lands.
 *   * `vulnerability_alerts: read` — open Dependabot alerts, by severity. Note
 *     the key: the permission is called "Dependabot alerts" everywhere a person
 *     reads it and `vulnerability_alerts` everywhere a machine does, and a key
 *     GitHub does not recognize is not an error — it is a permission that
 *     silently was not asked for.
 *   * `organization_projects: write` — moving a card on a Projects v2 board.
 *     **The one permission here that reaches past a repository**, because a
 *     board does: Projects v2 belongs to the organization, has no REST surface,
 *     and has no repository-scoped equivalent. `repository_projects` is the
 *     classic repo board and is a different, older thing. An organization that
 *     does not want this should say so — the write is the only thing that
 *     uses it, and everything else here keeps working without it.
 *   * `metadata: read` — mandatory for every GitHub App, and granted implicitly
 *     by the others. Stated so the list is the whole truth.
 *
 * Widening this is not free and not silent: GitHub asks every organization that
 * has already installed the app to approve the new permission, and the app
 * keeps the old grant until they do — so a permission added later arrives
 * broken for everybody who installed before it. Which is the argument for
 * asking now rather than in pieces, and against asking for anything speculative:
 * a permission with nothing behind it is one an organization grants for no
 * feature, and a reviewer cannot tell "not used yet" from "used for something
 * not described". Each of these arrived with the code that uses it, and
 * `test/github-app.test.ts` is what keeps that true.
 */
export const PERMISSIONS: Readonly<Record<string, string>> = {
  issues: "write",
  pull_requests: "write",
  vulnerability_alerts: "read",
  organization_projects: "write",
  metadata: "read",
};

/**
 * Which deliveries this app subscribes to.
 *
 * Derived from the translator rather than written out here, which is the whole
 * point of the file it comes from: an event handled in code but missing from
 * this list never arrives, and an event on this list that nothing handles is
 * delivery volume for nobody. Neither failure says anything at either end.
 *
 * Two things worth knowing about changing it:
 *
 *   * **Adding one is cheap; adding a permission is not.** A webhook event is
 *     not a permission, so a delivery covered by a permission this app already
 *     holds costs no organization a re-approval. Widening {@link PERMISSIONS}
 *     is the opposite — every existing installation keeps the old grant until
 *     somebody approves the new one.
 *   * **The installation lifecycle is not here, and must not be.** GitHub's own
 *     words: "All GitHub Apps receive this event by default. You cannot
 *     manually subscribe to this event." Naming it would be asking for
 *     something already arriving.
 */
export const WEBHOOK_EVENTS: readonly string[] = SUBSCRIBED_EVENTS;

/**
 * Where somebody deciding whether to install this app goes to read about it.
 *
 * The one URL on the registration that is **not** an address this deployment
 * answers on. Everything else here — the callback, the setup page, the webhook
 * — is matched exactly by GitHub against a live host, which is why each
 * deployment registers its own app. This is a link on a page, so it should be
 * the same stable place for all of them, and the project's own page is the only
 * thing that is stable across self-hosters.
 *
 * An operator with somewhere better to send people overrides it. A private
 * deployment pointing at an internal runbook is a perfectly good answer, and a
 * URL nobody outside the company can open is not, which is why this is not
 * defaulted to the deployment's own address: a homepage no reader can reach is
 * worse than one that is merely generic.
 */
export const HOMEPAGE = "https://github.com/Morelitea/initiative-github";

/** The registration, as GitHub's own manifest format. */
export interface GithubAppManifest {
  name: string;
  url: string;
  hook_attributes: { url: string; active: boolean };
  redirect_url: string;
  callback_urls: string[];
  setup_url: string;
  description: string;
  public: boolean;
  default_events: string[];
  default_permissions: Record<string, string>;
  request_oauth_on_install: boolean;
  setup_on_update: boolean;
}

/**
 * The registration this app needs, for one deployment.
 *
 * Every URL is built from the one public address, so a deployment cannot
 * register a callback that points at a different host from the webhook.
 *
 * Two flags are the interesting ones:
 *
 *   * `request_oauth_on_install` — an org owner who installs the app is taken
 *     straight on to authorize it, so installing and connecting are one trip
 *     instead of two disconnected ones. It is why the callback URL, not just
 *     the setup URL, matters at install time.
 *   * `setup_on_update` is off: this app has nothing to say when somebody
 *     changes which repositories an existing installation covers, because it
 *     re-reads that on the next delivery anyway.
 *
 * @param publicUrl the deployment's `APP_PUBLIC_URL`, without a trailing slash
 * @param options.homepage where to send a reader; not an address this app serves
 */
export function githubAppManifest(
  publicUrl: string,
  options: {
    name?: string;
    description?: string;
    homepage?: string;
    public?: boolean;
  } = {}
): GithubAppManifest {
  const base = stripTrailingSlashes(publicUrl);
  return {
    name: options.name ?? "Initiative for GitHub",
    // Deliberately not `base`. See HOMEPAGE: this is the one field a reader
    // follows rather than a machine.
    url: options.homepage ?? HOMEPAGE,
    hook_attributes: { url: `${base}${WEBHOOK_PATH}`, active: true },
    // Three redirects, three audiences, and they are not interchangeable —
    // which is easy to get wrong because all three are "where GitHub sends
    // somebody afterwards":
    //
    //   * `redirect_url` — the *operator*, once, immediately after this
    //     manifest creates the app. It carries the code that is exchanged for
    //     the app's credentials, and it is never used again.
    //   * `callback_urls` — a *member*, every time they authorize.
    //   * `setup_url` — an *organization owner*, after they install.
    redirect_url: `${base}${REGISTERED_PATH}`,
    callback_urls: [`${base}${CALLBACK_PATH}`],
    setup_url: `${base}${SETUP_PATH}`,
    description:
      options.description ??
      "Brings a repository's issues, reviews and dependency alerts into " +
        "Initiative as dashboard widgets.",
    // Installable by any organization, which is what a marketplace listing
    // implies: the guilds that install it are not the ones that deployed it.
    public: options.public ?? true,
    default_events: [...WEBHOOK_EVENTS],
    default_permissions: { ...PERMISSIONS },
    request_oauth_on_install: true,
    setup_on_update: false,
  };
}
