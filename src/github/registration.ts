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

import {
  CALLBACK_PATH,
  REGISTERED_PATH,
  SETUP_PATH,
  WEBHOOK_PATH,
} from "../routes.js";

/**
 * What this app asks an organization for, and nothing beyond it.
 *
 * Read this list against what the code does, because a reviewer at an
 * organization will:
 *
 *   * `issues: write` — the counts and the fortnight of activity are reads; the
 *     `create-issue` automation action is the write. Read alone would be enough
 *     for the dashboard, and is not enough for the automation node.
 *   * `pull_requests: read` — "which pull requests are waiting on my review".
 *   * `vulnerability_alerts: read` — open Dependabot alerts, by severity. Note
 *     the key: the permission is called "Dependabot alerts" everywhere a person
 *     reads it and `vulnerability_alerts` everywhere a machine does, and a key
 *     GitHub does not recognize is not an error — it is a permission that
 *     silently was not asked for.
 *   * `metadata: read` — mandatory for every GitHub App, and granted implicitly
 *     by the others. Stated so the list is the whole truth.
 *
 * Every one of them is repository-scoped. Nothing here reads an organization's
 * members, its teams, or its settings, and `test/github-app.test.ts` refuses a
 * permission whose name says otherwise.
 *
 * Widening this is not free and not silent: GitHub asks every organization that
 * has already installed the app to approve the new permission, and the app
 * keeps the old grant until they do — so a permission added later arrives
 * broken for everybody who installed before it. That asymmetry is a real
 * argument for asking early, and it is not the one this list follows: a
 * permission with nothing reading it is one an organization grants for no
 * feature, and a reviewer cannot tell the difference between "not used yet" and
 * "used for something not described". Each of these arrived with the code that
 * reads it.
 */
export const PERMISSIONS: Readonly<Record<string, string>> = {
  issues: "write",
  pull_requests: "read",
  vulnerability_alerts: "read",
  metadata: "read",
};

/**
 * Which deliveries this app is sent.
 *
 * `issues` and `pull_request` are the two the trigger nodes fire on. The
 * installation lifecycle — an org installing, uninstalling, or changing which
 * repositories the app can see — arrives whether or not it is subscribed to,
 * so it is not listed here and is still handled.
 */
export const WEBHOOK_EVENTS: readonly string[] = ["issues", "pull_request"];

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
  const base = publicUrl.replace(/\/+$/, "");
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
      "Brings a repository's issues and reviews into Initiative as dashboard " +
        "widgets and automation nodes.",
    // Installable by any organization, which is what a marketplace listing
    // implies: the guilds that install it are not the ones that deployed it.
    public: options.public ?? true,
    default_events: [...WEBHOOK_EVENTS],
    default_permissions: { ...PERMISSIONS },
    request_oauth_on_install: true,
    setup_on_update: false,
  };
}
