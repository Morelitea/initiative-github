/**
 * The only HTML this app serves.
 *
 * Three plain pages, all of them somewhere a person lands after a trip to
 * GitHub: a member who connected, an org owner who installed, and whoever
 * followed a link that had expired. There is no fourth, because this app mounts
 * no embedded surface — everything it offers renders inside Initiative's own.
 *
 * One template rather than one per route, so the two files that serve a page
 * cannot drift into looking like two different apps.
 */

export function page(title: string, body: string): string {
  return pageHtml(title, `<p>${body}</p>`);
}

/** The same page for the one flow whose body is more than a sentence. */
export function pageHtml(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;margin:4rem auto;max-width:44rem;padding:0 1rem}
pre{background:#f4f4f5;padding:1rem;border-radius:6px;overflow-x:auto;font-size:13px}
code{font-size:13px}
.warn{border-left:4px solid #d97706;padding-left:1rem;color:#78350f}
</style>
</head><body><h1>${title}</h1>${body}</body></html>`;
}

/** What each character escapes to. `&` first is not enough on its own — see below. */
const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Anything interpolated into a page that did not come from this repository.
 *
 * One pass, building the result character by character, which is the property
 * that matters: chained replacements are four passes over a string that each
 * one has already changed, so `&` has to be first or `<` becomes `&amp;lt;` —
 * correct here by ordering rather than by construction, and one reordering away
 * from being wrong. A single pass cannot re-escape its own output.
 *
 * `'` is escaped too. It was not, and everything in this app interpolates into
 * element text where it does not matter — but "does not matter given where this
 * is used today" is a property of the call sites, not of the function, and the
 * function is the thing named `escapeHtml`.
 */
export function escapeHtml(value: string): string {
  let out = "";
  for (const character of value) {
    out += ESCAPES[character] ?? character;
  }
  return out;
}
