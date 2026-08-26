/**
 * The one name everything this app publishes is namespaced under.
 *
 * Its own module for the same reason `routes.ts` is: the manifest needs it, and
 * so do things the manifest imports. Leaving it in `manifest.config.ts` would
 * make the event vocabulary import the manifest that declares the event
 * vocabulary, which is a cycle a bundler resolves by handing somebody
 * `undefined` at module load — and an event type reading
 * `app.undefined.issue-opened` validates as a string and is refused by the
 * platform with a message about a prefix.
 */

/** `<publisher>.<slug>`. Immutable once anything has installed this app. */
export const PUBLIC_ID = "morelitea.github";
