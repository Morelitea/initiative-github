# The `automation` block

Initiative stores this block verbatim and gives it no meaning — it is checked
for shape and size and passed through. The **automation service** is what parses
it, against the contract below.

That split is deliberate: automations are a separate product with its own
vocabulary, and duplicating any of it in the platform would be a second
definition of a contract the platform does not own.

## What an app contributes

An app contributes a **domain** — a section in the node palette — and the
**nodes** inside it. It ships no code to the canvas: a node is a *descriptor*,
and the automation service's generic renderer draws its form, exactly as it does
for the built-in domains.

```jsonc
"automation": {
  "contract": 1,
  "domain": { "id": "github", "label": { "en": "GitHub" }, "icon": "Braces" },
  "nodes": [ /* triggers and actions */ ],
  "operations": [ /* where each action is served */ ]
}
```

Node types are namespaced by the service on the way in — a node with
`"key": "issue-opened"` from `morelitea.github` becomes
`app.morelitea.github.issue-opened` — so two apps can both contribute a
`create-issue` and neither can shadow a built-in.

## Triggers

A trigger names an **event this manifest also declares**. When that event
arrives on the events channel from the registration that owns it, automations
whose entry node is this trigger fire.

```jsonc
{
  "key": "issue-opened",
  "category": "trigger",
  "icon": "Zap",
  "label": { "en": "A GitHub issue is opened" },
  "description": { "en": "Starts when someone opens an issue…" },
  "event": "app.morelitea.github.issue-opened",
  "fields": [ { "key": "label", "type": "string", "label": { "en": "Only issues with this label" } } ],
  "outputs": ["issue_number", "issue_title", "issue_url", "issue_labels"]
}
```

`fields` narrow *which* occurrences start a run — they are matched against the
event's payload. `outputs` names what the event carries into the run for later
nodes to read.

## Actions

An action names an **operation**, which is a path this app serves. The
automation service calls it with a context token scoped to `action` and naming
that operation — so a token minted to fetch a dashboard source cannot run it.

```jsonc
{
  "key": "create-issue",
  "category": "action",
  "icon": "FolderPlus",
  "label": { "en": "Open a GitHub issue" },
  "operation": "create-issue",
  "fields": [ { "key": "title", "type": "string", "required": true, "label": { "en": "Title" } } ],
  "outputs": ["issue_number", "issue_url"]
}
```

The operation says where it is served and what it needs:

```jsonc
"operations": [
  { "id": "create-issue", "path": "/actions/create-issue",
    "requires": { "all_of": ["workspace", "account"] } }
]
```

## Fields reuse the manifest's own vocabulary

`fields` are the **same closed set a connection's fields use** — `string`,
`url`, `bool`, `select`, `int` — deliberately, so one generic renderer draws a
node's form and a connection's alike, and an app author learns one thing rather
than two.

`secret` is absent. A node's config is stored in an automation's graph and shown
in an editor; a credential belongs in a connection, which is held in custody and
never returned.

## The rule an action must keep

**An action runs as the member whose credential the token names**, from
`connection_refs`, and never from an app-wide token. See
[`src/github/actions.ts`](src/github/actions.ts).

That is what makes revoking mean something: an automation that opens issues
opens them as the person who set it up, and stops working when they disconnect.
An app that wrote from its own credential would leave automations running for
people who had withdrawn, which no amount of platform enforcement can fix from
outside.

## Status

The platform stores and serves this block today. The automation service's half —
reading these descriptors from installed apps, registering the domain and its
nodes, firing triggers from inbound events, and calling operations — is Phase 13
of the platform design and is **not built yet**. This app declares the block so
the contract has a concrete first implementation to be built against.
