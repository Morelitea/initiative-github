/**
 * The only HTML this app serves, and it is the fallback rather than the ending.
 *
 * A member Initiative sent goes back to Initiative when a vendor flow is over,
 * because Initiative knows what language they read and this app does not. What
 * is left here is for everybody else: somebody who assembled a connect URL by
 * hand, somebody whose in-flight row expired and took the return address with
 * it, and the org owner who followed a bare install link and was never in
 * Initiative at all.
 *
 * English, and that is the honest answer rather than a gap — nothing here knows
 * anything about the person reading it, which is the whole argument for handing
 * the ones we do know back.
 *
 * Every page is a fixed sentence written here. Nothing a caller supplies is
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
