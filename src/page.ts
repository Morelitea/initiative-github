/**
 * The only HTML this app serves.
 *
 * Three plain pages, all of them somewhere a person lands after a trip to
 * GitHub: a member who connected, an org owner who installed, and whoever
 * followed a link that had expired. There is no fourth, because this app mounts
 * no embedded surface — everything it offers renders inside Initiative's own.
 *
 * Every one is a fixed sentence written here. Nothing a caller supplies is
 * interpolated, which is why there is no escaping in this file — if that ever
 * stops being true, the escaping has to come back with it.
 */

export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;margin:4rem auto;max-width:44rem;padding:0 1rem}
</style>
</head><body><h1>${title}</h1><p>${body}</p></body></html>`;
}
