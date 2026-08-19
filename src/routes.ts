/**
 * Every path this app serves, in one place, because two audiences read them.
 *
 * Initiative learns these from the manifest. GitHub learns them from the app's
 * registration — a callback URL, a setup URL, a webhook URL, all typed into a
 * form once and then invisible. A path that changes in the code and not in that
 * form fails at GitHub, at the moment somebody tries to connect, with an error
 * about a redirect URI mismatch that says nothing about what moved.
 *
 * So the paths are constants, the manifest is built from them, and so is the
 * GitHub App registration. Neither side can be edited into disagreeing with the
 * code that serves it.
 *
 * Nothing here imports configuration on purpose: these are paths, and the two
 * things that turn a path into an address — Initiative's registration and this
 * app's public URL — are both somebody else's to supply.
 */

/** Where a member starts the vendor flow. Initiative sends them here. */
export const CONNECT_PATH = "/connect/github";

/** Where GitHub sends them back. The app's registered callback URL. */
export const CALLBACK_PATH = "/connect/github/callback";

/**
 * Where GitHub sends an org owner after they install the app.
 *
 * A GitHub App has somewhere to land after installation whether or not it
 * wants one; an app that names nothing leaves the person on a GitHub page with
 * no idea what to do next.
 */
export const SETUP_PATH = "/setup/github";

/** A redirect to the app's own install page, so the link can be handed out. */
export const INSTALL_PATH = "/install/github";

/** The app's one webhook endpoint — registered once, not per repository. */
export const WEBHOOK_PATH = "/webhooks/github";
