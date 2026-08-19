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

/** Anything interpolated into a page that did not come from this repository. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
