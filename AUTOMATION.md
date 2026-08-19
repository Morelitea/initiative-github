# The `automation` block

Initiative stores this block verbatim and gives it no meaning — it is checked
for shape and size and passed through. The **automation service** is what parses
it, against the contract below.

That split is deliberate: automations are a separate product with its own
vocabulary, and duplicating any of it in the platform would be a second
definition of a contract the platform does not own.

Because the platform does not check it, **a mistake here does not fail
registration** — it fails quietly, as a node that never appears in anybody's
palette. `initiative-app-kit`'s `validateAutomation` is what turns that into a
message, and it runs the same schema the automation service generates from the
rules it enforces.

## What an app contributes

An app contributes a **domain** — a drawer in the node palette — and the
**nodes** inside it. It ships no code to the canvas: a node is a *descriptor*,
and the automation service's generic renderer draws its form, exactly as it does
for the built-in domains.

```jsonc
"automation": {
  "contract": 1,
  "domain": { "label": { "en": "GitHub" }, "icon": "Braces" },
  "nodes": [ /* triggers, conditions and actions */ ],
  "operations": [ /* where each condition and action is served */ ]
}
```

Node types are namespaced by the service on the way in — a node with
`"key": "issue-opened"` from `morelitea.github` becomes
`app.morelitea.github.issue-opened` — so two apps can both contribute a
`create-issue` and neither can shadow a built-in.

**The domain has no id.** The drawer is always `app.<public_id>`, derived from
the registration Initiative already matched the app by; the manifest supplies a
label and an icon. An id a publisher chose could collide with a built-in drawer,
and both ways that fails are silent: `"id": "tags"` would file these nodes into
Initiative's own tag drawer, and `"id": "guild"` would inherit a scope rule that
makes them vanish inside an initiative.

One app is one drawer. An app cannot file nodes into an existing domain, which
is what keeps "one drawer per tool" true — an app *is* the tool.

## The four categories, and the three an app may fill

The palette's top level is `trigger`, `condition`, `action`, `logic` — four,
structurally, for built-in and app nodes alike. An app is a **domain inside**
them: this app's drawer appears under Triggers and under Actions because it has
nodes in both, the same way Initiative's own Tags drawer appears under
Conditions and Actions.

An app may declare `trigger`, `condition` and `action`. **`logic` stays with the
service**, and that is not an omission: flow control is resolved from a graph's
*edges* — a gate's operands are the branches arriving at it — so an app-declared
gate would either duplicate AND/OR/XOR or turn combining two branches into a
network round trip.

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
  "outputs": [
    { "key": "issue_title",  "type": "string", "label": { "en": "Issue title" } },
    { "key": "issue_number", "type": "int",    "label": { "en": "Issue number" } },
    { "key": "issue_labels", "type": "string", "list": true, "label": { "en": "Labels" } }
  ],
  "fields": [
    { "key": "label", "type": "string", "matches": "issue_labels",
      "label": { "en": "Only issues with this label" } }
  ]
}
```

`outputs` names what the event carries into the run for later nodes to read.
`fields` narrow *which* occurrences start one.

**A filter says what it matches.** `matches` names an output of this same node —
so the vocabulary is already declared and already typed. A scalar output is
compared for equality; a `list` one for containment. Omitted, `matches` defaults
to the field's own key, which is the common case and why this app's `repository`
filter says nothing. A field that matches nothing is **refused**: a filter that
can never match is a control that looks right and is silently dead.

A field left empty does not filter.

## Conditions and actions

Both name an **operation**, which is a path this app serves. The automation
service calls it with a context token scoped to `action` and naming that
operation — so a token minted to fetch a dashboard source cannot run it.

```jsonc
{
  "key": "create-issue",
  "category": "action",
  "icon": "FolderPlus",
  "label": { "en": "Open a GitHub issue" },
  "operation": "create-issue",
  "fields": [
    { "key": "title", "type": "string", "required": true, "label": { "en": "Title" } }
  ],
  "outputs": [
    { "key": "issue_number", "type": "int", "label": { "en": "Issue number" } },
    { "key": "issue_url",    "type": "url", "label": { "en": "Issue URL" } }
  ]
}
```

The operation says where it is served and what it needs:

```jsonc
"operations": [
  { "id": "create-issue", "path": "/actions/create-issue",
    "requires": { "all_of": ["workspace", "account"] } }
]
```

What separates the two categories is what the answer means, not how it is
called. An **action** does something; a **condition** decides whether the branch
continues, and never reports having worked — so an automation that only asked
questions is not charged for the run.

## The answer is an envelope

```jsonc
{ "ok": true, "outputs": { "issue_number": 12, "issue_url": "https://…" } }
```

| Key | Meaning |
|---|---|
| `ok` | Did the operation do its work? `false` ends the branch. |
| `reason` | A short code when `!ok`, for the run log. Bounded. |
| `passed` | Conditions only. Defaults to `ok`. |
| `outputs` | Only keys the node declared. Anything else is dropped. |

The data sits under `outputs` rather than beside `ok` so that an envelope field
and a data field are never competing for one namespace — flat, an app could
never declare an output called `ok`, `passed` or `reason`.

## Reading an output in a later node

A field's stored value may be a **reference** instead of a literal:

```jsonc
"config": { "title": { "$from": { "node": "n3", "output": "issue_title" } } }
```

`node` is a node **key** in the graph, not a node type — two nodes of one type
carry different values, and a type could not tell them apart.

Checked when the automation is saved: the named node runs before this one, it
declares that output, and the output's type fits the field's. A `list` output
cannot be bound into a field that takes one value. At run time a reference to a
node whose branch was skipped resolves to nothing, and a `required` field with
nothing in it fails the run rather than sending a blank.

It is an object rather than `{{n3.issue_title}}` because config here is typed
JSON: a template would force every bindable field to be a string and erase the
types that make the check above possible. Interpolating a value into a sentence
is a real want and is deliberately not in this version.

## Fields reuse the manifest's own vocabulary

`fields` are the **same closed set a connection's fields use** — `string`,
`url`, `bool`, `select`, `int` — deliberately, so one generic renderer draws a
node's form and a connection's alike, and an app author learns one thing rather
than two.

`outputs` use that set minus `select`, because a select is a *control* and the
value behind one is a string.

`secret` is absent from both. A node's config is stored in an automation's graph
and shown in an editor; a credential belongs in a connection, which is held in
custody and never returned.

## One bad node costs one node

The manifest is read at request time from a party the automation service does
not control, so refusing a whole block over one malformed entry would take the
app's entire drawer away *and* break automations already using its good nodes.

A node that is malformed, names an operation that does not exist, or declares a
filter matching nothing is dropped **on its own**, with the reason logged.
Unknown keys are ignored. The one thing that refuses the whole block is a
`contract` the service does not know — that is news from the future rather than
a mistake, and reading it as if it were this shape would offer nodes whose
behaviour nobody agreed to.

## When the app goes away

* **Saving** — an automation may name these nodes as long as the guild has this
  app installed, enabled or not; a disabled app is a switch somebody can flip
  back. Not installed at all reads as an unknown node type.
* **Opening** — a stored graph naming a node from an app that has since been
  removed still opens; the node shows as unrecognised rather than vanishing.
* **Running** — such a fire parks rather than failing outright, because the
  answer changes when somebody reinstalls.

## Caps

Initiative bounds the whole block at 64 KiB. Within that: 40 nodes, 20
operations, 12 fields and 12 outputs per node, 40 options on a select. An
operation's `requires` may only name connections this manifest declares.

## The rule an action must keep

**An action runs as the member whose credential the token names**, from
`connection_refs`, and never from an app-wide token. See
[`src/github/actions.ts`](src/github/actions.ts).

That is what makes revoking mean something: an automation that opens issues
opens them as the person who set it up, and stops working when they disconnect.
An app that wrote from its own credential would leave automations running for
people who had withdrawn, which no amount of platform enforcement can fix from
outside.

This app has an app-wide credential now — it is a GitHub App, and the
installation an organization granted it can open issues perfectly well. That
makes the rule a choice rather than a limitation, and it is still the right one.
An issue opened by the installation is attributed to the app, so the automation
outlives the person who set it up and there is nobody to ask about it. The
guild-scoped tier is for questions that have one answer for everybody; a write
has an author.

## Status

The platform stores and serves this block. The automation service **reads it**:
it fetches the guild's installs, parses each block against the contract above,
and offers the nodes in the editor's palette, where they can be configured,
bound with `$from`, and saved.

Two halves are not built yet, and both are the same missing piece from opposite
ends — nothing calls an operation, and no app event reaches a trigger:

* **Calling an operation** needs Initiative to mint a context token with
  `scope: "action"` and proxy the call to `operations[].path`. The minting
  supports it and nothing uses it yet.
* **Firing a trigger** needs the app-event delivery envelope and the automation
  service's webhook receiver to agree; today they do not.
