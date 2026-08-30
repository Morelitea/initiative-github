/**
 * Why a tile has nothing to draw, in words the person looking at it can act on.
 *
 * Every read here answers `unavailable` in the body rather than as a status,
 * precisely so that a widget can draw it — a 4xx is something a canvas draws
 * nothing at all from. What was missing was any widget doing so. All four fell
 * through to their ordinary path, so a read that had refused to answer arrived
 * as `rows: []` and was drawn as a zero: "0 open issues" for a tile that had
 * never been told which repository, on an install that may well have had
 * hundreds.
 *
 * A zero is the worst of the available lies, because it is a number and it is
 * plausible. So this runs first in every widget, and the tile says which thing
 * is missing and who can supply it.
 *
 * Prepended into each `module_source` rather than repeated in four of them:
 * the reasons come from this app's own endpoints, and four copies would be four
 * places to add the fifth reason to.
 */
export const WHY_NOTHING = `
// The reasons this app's reads give, and what somebody can do about each. An
// unknown one is still said out loud: a tile that draws nothing looks broken.
var WHY = {
  "repository-required": "Choose a repository for this tile",
  "repository-not-listed": "This tile names a repository the install does not cover",
  "not-configured": "No GitHub organization is connected yet",
  "not-connected": "Connect your GitHub account to see this",
  "not-found": "That repository is not there, or not yours to see",
  "vendor-error": "GitHub did not answer",
};

function missing(data) {
  var why = (data.values || {}).unavailable;
  if (!why) return null;
  return { v: 1, scene: { kind: "empty", message: WHY[why] || "There is nothing to show" } };
}
`.trim();
