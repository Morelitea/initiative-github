/**
 * The embedded page, rendered inside Initiative's iframe.
 *
 * Two things an embedded surface has to respect, and neither is enforceable
 * from the platform's side alone:
 *
 * **The frame is granted only what the manifest asked for.** This app declared
 * `clipboard-write` and nothing else, so `navigator.clipboard.writeText` works
 * and a camera call would be denied by the browser. Asking for a capability the
 * page does not use is worth avoiding — a guild admin sees the list at install.
 *
 * **The handoff token arrives by `postMessage`, never in the URL.** A query
 * string is logged, copied and shared; the platform posts the token to the
 * frame instead. The page below waits for it rather than reading `location`.
 *
 * Deliberately a plain string of HTML: a real app renders however it likes, and
 * a build step here would hide the two rules above behind tooling.
 */

export function renderBoard(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>GitHub</title>
  <style>
    :root { color-scheme: light dark; }
    body { font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 1.25rem; }
    .empty { color: color-mix(in srgb, currentColor 60%, transparent); }
    button { font: inherit; cursor: pointer; }
    ul { list-style: none; padding: 0; }
    li { display: flex; gap: .75rem; align-items: baseline; padding: .4rem 0; }
  </style>
</head>
<body>
  <h1>Review queue</h1>
  <p class="empty" id="state">Waiting for the host…</p>
  <ul id="items"></ul>

  <script type="module">
    // The platform posts the handoff token in; it is never in the URL.
    // Only accept a message from the origin that framed this page.
    const HOST = document.referrer ? new URL(document.referrer).origin : null;

    window.addEventListener("message", async (event) => {
      if (!HOST || event.origin !== HOST) return;
      const message = event.data;
      if (!message || message.type !== "initiative:handoff") return;

      document.getElementById("state").textContent = "Loading…";
      try {
        const response = await fetch("/data/review-queue", {
          headers: { Authorization: "Bearer " + message.token },
        });
        const body = await response.json();
        render(body);
      } catch {
        document.getElementById("state").textContent = "Could not load.";
      }
    });

    // Tell the host this frame is ready to receive it.
    if (HOST) window.parent.postMessage({ type: "initiative:ready" }, HOST);

    function render(body) {
      const state = document.getElementById("state");
      const list = document.getElementById("items");
      list.replaceChildren();

      if (body.unavailable === "not-connected") {
        state.textContent = "Connect your GitHub account in this app's settings.";
        return;
      }
      if (body.unavailable) {
        state.textContent = "Nothing to show yet.";
        return;
      }
      if (!body.items?.length) {
        state.textContent = "Nothing is waiting on you.";
        return;
      }

      state.textContent = "";
      for (const item of body.items) {
        const li = document.createElement("li");
        const link = document.createElement("a");
        link.href = item.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "#" + item.number + " " + item.title;
        const copy = document.createElement("button");
        copy.textContent = "Copy link";
        // Works because the manifest declared clipboard-write, and only that.
        copy.addEventListener("click", () => navigator.clipboard.writeText(item.url));
        li.append(link, copy);
        list.append(li);
      }
    }
  </script>
</body>
</html>`;
}
