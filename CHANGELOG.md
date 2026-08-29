# Changelog

## [0.9.0] — 2026-08-29

### An app that has not registered yet can register itself

The four GitHub settings are no longer required at boot. An app cannot be asked
to hold the credentials for a registration nobody has made yet, and requiring
them meant the only way to get one was the form.

So a deployment with none of them starts, refuses every GitHub-shaped route with
a sentence naming the one that fixes it, and serves that one:
`/setup/register`, behind `INITIATIVE_APP_SETUP_TOKEN` and nothing else. Open
it, press **Create GitHub App** at GitHub, and the client id, client secret,
webhook secret and private key are on the page. Put them in the deployment's
settings, restart, and remove the token.

The token's name belongs to the kit rather than to GitHub, so an operator learns
one name however many integrations they run — and it is genuinely a door: while
it is set, whoever holds it can create a GitHub App in the account they are
signed into. The route answers `404` without it rather than `403`, so it does
not advertise itself, and the state carried through GitHub is signed with the
token rather than stored, so a restart mid-registration costs nothing and a
state nobody signed cannot be presented.

`env-contract.json` publishes a third class, `registration`, for exactly this:
settings a vendor issues once the app is registered there. A deployment check
can now tell *"will not start"* from *"will not work until somebody registers
it"*, which are different sentences with different remedies.

### Registering it is one command and one button

`npm run register`. It sends this app's registration to GitHub as the document
GitHub asks for, you press **Create GitHub App**, and the client id, client
secret, webhook secret and private key come back to your terminal ready to
paste. Nothing is copied off a web page and no `.pem` is downloaded and
re-encoded.

The registration was always generated — `githubAppManifest` builds it from the
same constants the code runs on — and the operator was then told to retype it
into a form. Every field on that form is one that can silently stop matching the
code, which is the entire premise of `test/github-app.test.ts`, and the two that
catch people out are invisible until somebody tries to use them: a callback URL
typed one character wrong is a redirect mismatch at the moment a member
connects, and *Request user authorization during installation* left ticked sends
an install down the sign-in route.

`npm run github-app` still prints the same registration as a form, for anyone
who would rather see what is being asked for. It had gone stale — it named one
callback URL and told you to tick the box that must now be off.

### Installing is not signing in, and no longer travels as though it were

0.8.0 brought an install back through `/connect/github/callback` — the route a
member returns to after authorizing — because GitHub's *Request user
authorization during installation* was on and that is where it sends them. Two
different trips arriving at one address, told apart by a column in
`oauth_states` recording which one this app had started.

That setting is off now. GitHub keeps them apart itself: an installation returns
to the setup URL, a person authorizing returns to a callback, and the route that
receives a trip already knows what it is looking at. The column is gone with it.

### An installation id is a claim, and it was being believed

GitHub is explicit about the parameter it puts on the setup URL: *"Bad actors
can hit this URL with a spoofed `installation_id` … you should not rely on the
validity of the `installation_id` parameter. Instead, you should generate a user
access token for the user who installed the GitHub App and then check that the
installation is associated with that user."*

This app was relying on it. A guild admin with a legitimate state of their own
could have come back naming an installation belonging to an organization they
had nothing to do with, and this would have written it down as their guild's —
and then minted a credential for it, because the credential behind an
installation comes from this app's key and would have been minted just the same.
That is another organization's private repositories on somebody else's
dashboard.

So the id is carried as a claim and the person is sent to authorize, and *that*
answer is what settles it: `GET /user/installations` has to agree the
installation is one they hold. The account comes out of the same answer, so
nothing else has to be asked. The token is spent on that one question and
dropped — it is theirs, and this connection is the guild's.

The authorization lands on a **second registered callback**, `/install/github/verify`,
rather than the member's. GitHub App registrations take a list, and one route
per question means neither ever sees the other's traffic. **Existing
registrations need it added by hand.**

### The app acts as itself for what an organization granted

The private key used only to ask which account had installed the app. It mints
an installation token now, from the key alone — no authorization step, no code,
no secret shared with anybody. An owner granted the app access at GitHub, and
that grant is the whole of the authority.

That is what let the repository list leave the connection. It was a
comma-separated string an admin typed and then had to keep correct by hand; it
is read from the installation on every sync now — `GET /installation/repositories`
answers whether the organization picked repositories or granted all of them — so
a repository ticked at GitHub arrives on its own. `installation_repositories`,
which GitHub sends to every app whether or not it subscribes, brings it in
seconds rather than minutes.

The rule that replaced *"this app never mints an installation token"* is the one
that always mattered, and it is enforced from the manifest now: **no write ever
runs as the installation.** A write attributed to the app is a write nobody can
be held to.

### A dashboard that works when the guild installs it

Every read resolved one credential — the credential of whoever was looking — so
a guild could be fully set up at GitHub and every tile still said *connect your
account* to everybody, forever, until each person signed in individually.

Reads declare `["member", "installation"]` now, and are answered in that order.
Somebody who has connected is still answered as themselves and still sees
exactly what they can see at GitHub; somebody who has not gets the
installation's answer, which is a fact about the repository and true either way.
Which one ran is reported back rather than assumed — it decides what the numbers
mean.

Two things are deliberately outside it. **Writes stay `["member"]`**: a write
attributed to the app reaches whatever the organization granted rather than what
the person whose automation fired it may touch. And a call carrying **`@me`** is
narrowed back to the member for that call, because `@me` is GitHub's word for
whoever the token belongs to and an installation token belongs to nobody. That
is read off the values rather than a parameter name, since it is a convention of
GitHub's search syntax.

### Bound to an installation, and to nothing else

The lookup by account name is gone, along with the rows that waited to be
matched by one. A login is a name pointing at an installation today: an
organization that renames itself keeps its installation and loses its name, and
a freed-up name taken by somebody else reads as this guild's install having
moved to an account it never agreed to.

### A member's GitHub account stays here

Finishing a member's connection used to mean asking GitHub `GET /user` for their
login and writing it into Initiative, in plaintext, as the value that marks the
connection satisfied. Nothing read it back — not this app, which already knew
it, and not the platform, which only ever needed to know whether *something* was
present. A username crossed a boundary and sat there for no reason, alongside
`@alice` as a display label.

The connection declares `authorized`, a bool, and what crosses is a yes. The
lookup that produced the name is gone with it, and so is the ending that existed
for it failing: there is one call in that flow now, and one way for it to end.
The credential is sealed here, under a handle that says nothing about anybody.

The cost is real and worth stating: a guild admin can see that a member
connected and can end it, and can no longer see which GitHub account they
connected as.

### Needs kit 0.12.0, and a database that has not been used

`ConnectOutcome` gained `awaiting_approval` there, so a member of an
organization who cannot install apps — GitHub raises a request for an owner
instead — is handed back to Initiative with a word for it rather than to a page
this app wrote in one language. Nothing failed, and there is nothing to retry
until somebody else acts. The kit also owns `INITIATIVE_APP_SETUP_TOKEN`, the
switch above, because it belongs to no one vendor.

`oauth_states` and `connections` both changed shape, so the schema fingerprint
moved. There is no migration path here: drop this app's database and let it be
recreated.


## [0.8.0] — 2026-08-28

### The organization is installed, not typed

An admin used to set this app up by typing an owner into a text box and a
comma-separated list of repositories beside it. Neither was checked against
anything. Somebody else, somewhere else, had to open GitHub's install page and
grant the app access to that account, and the only thing joining the two halves
was that the string matched — so a typo, a rename, or a repository nobody
actually granted produced an install that looked configured and answered
nothing.

That is not how a GitHub App is installed. Somebody who owns the account opens
GitHub's own page, chooses the account, ticks which repositories the app may
see, and what exists afterwards is an *installation* with an id.

So the workspace connection now declares a `connect_path`, and a guild admin
presses **Connect** on it. They land on GitHub's install page, choose what to
grant, and come back; this app writes down the account, the installation's id
and the repositories it covers, and the settings page stops asking to be set up.
All three fields are `managed` — there is nothing left to type, and nothing to
keep matching by hand.

### Bound to an installation rather than to a name

The sync asked GitHub "does an account called this have an installation?" and
wrote down the answer. It now asks "is *this installation* still there", by the
id an admin's flow recorded, and only falls back to the account when there is no
id — an install configured before the flow existed, or one removed and made
again at GitHub, which is a new installation on the same account.

A login is a name pointing at an installation today. An organization that
renames itself keeps its installation and loses its name, and by name that reads
as an uninstall; worse, a freed-up name taken by somebody else reads as this
guild's install now living on an account it never agreed to.

Silence is still not "gone": a lookup GitHub would not answer changes nothing and
does not send a second question after the first went unanswered.

### The private key still cannot act as the installation

The repositories an installation covers are read with the **token of the admin
who just authorized**, spent on that one question and then dropped — never
stored, because that credential is theirs and this connection is the guild's.
What gets written down is therefore what a person could see rather than
everything the installation could reach, which is the same rule every read in
this app already follows.

`test/installation.test.ts` still greps `src/` for the route that mints a
credential acting as the installation, and still finds nothing.

### One callback, two endings, told apart by intent

Both flows come back to the same address, and GitHub adds an `installation_id`
to a member's return whenever they installed and authorized in one trip. Reading
the ending off that parameter would be guessing at our own intent, so
`oauth_states` records which flow was started when the state is minted. A
member's flow stores a member's credential whatever GitHub sends back; an
admin's records an installation and stores no credential at all.

`beginInstall` no longer falls back to the ordinary authorize step when GitHub
will not name this app's registration. That step ends by storing whoever
completed it against the connection it was started for, which for an install
flow is the wrong credential in the right slot. It answers "nothing to start"
instead, and the route says so.

### Needs a Postgres that has not been used

`oauth_states` gained a column, so the schema fingerprint changed. There is no
migration path here, as before: drop this app's database and let it be recreated.
Members reconnect, and admins press **Connect** once.

### Needs kit 0.11.0, and a deployment that allows it

The contract used to say only an interactive connection may carry a
`connect_path`. A guild-wide credential obtained through a vendor's own flow had
nowhere to be declared, which is why this was two text boxes. Both halves —
`initiative-app-kit` and the deployment that validates against it — have to be
new enough to accept one on a `static` connection.

## [0.7.0] — 2026-08-27

### A vendor flow that ends on a page, not in a 500

The token exchange and the account lookup after it called `fetch` and read
`.json()` off the answer with nothing around either. A reset connection, a
proxy's HTML where the tokens should be, GitHub having a bad afternoon — each of
them threw, reached the server's last resort, and answered a member with
`{"error":"internal error"}` in a browser tab. The page for this was already
written: *"GitHub did not complete the sign-in. Nothing changed — start again
from the app's settings in Initiative."* Every one of those 500s was that page,
routed around by an unguarded call.

Both go through the kit now — `exchangeCode` and `fetchJson`, which answer
instead of throwing — and so does `appIdentity`, which is awaited on the same
redirect and took out `/connect/github` and `/install/github` the same way.

A refusal that arrives as a `200` with `{"error": ...}`, which is how GitHub
answers a spent code, is a refusal here too. So is a body that is not JSON.

### A refusal and an outage are not the same thing

Renewing a credential now reads *why* the exchange failed before acting on it.
GitHub saying the grant is finished still drops the row and tells Initiative, so
the member is asked to connect again. GitHub saying nothing at all — unreachable,
`503`, rate limited — no longer does: nothing was learned about the grant, the
credential is kept, and the call it is spent on fails as a vendor error, which
is the honest answer. The old code could not tell the two apart, and one bad
afternoon at GitHub would have disconnected every member whose token happened to
be inside the two-minute refresh skew.

### The verifier is sent only for a challenge GitHub recorded

PKCE on the member's connect flow is real and stays: GitHub has supported it on
the authorization code flow since July 2025, `S256` only, and that flow sends a
challenge and answers with the verifier.

The install flow was a different story. `/apps/<slug>/installations/new` is not
an authorization request — GitHub preserves the `state` it documents, drops what
it does not, and begins the authorization itself. The challenge never reached
the step that would record it, and a verifier was stored anyway and sent at
exchange time for a binding GitHub never made. That is the case GitHub has
called out as using PKCE incorrectly, and it is invisible from here: an exchange
refused for it is indistinguishable from a member who declined.

The kit mints the state, the pair and the parameters together now, so what is
stored and what is sent cannot disagree. The install link carries `state` and
nothing else, and the verifier stored beside it is `null` — there is nothing to
send back and nothing to claim. With no registration to name, the flow falls
back to the authorize step, which does carry a challenge.

### An answer GitHub did not give is not written down as one

The same shape again, one layer up. `installationForOwner` returned `null` both
for *GitHub says there is no installation* and for *the lookup failed*, and the
sync wrote that straight into the workspace row — so a `500` from GitHub cleared
the installation id, and every guild-scoped source, the Dependabot widget
included, went quiet until a later sync happened to succeed. A thrown network
fault was worse: reaching `/v1/lifecycle`, it was caught by a handler that
forgot the install outright and dropped the workspace.

It returns the two separately now. "There is none" is still recorded, because an
app that was uninstalled has to stop routing deliveries. "GitHub would not say"
is not: `rememberWorkspace` leaves the id it already had, and the next sync asks
again. A 404 on `/orgs/…` still falls through to `/users/…` — that is an answer,
just not the one being asked for.

`/v1/lifecycle` now forgets an install only when Initiative says there is no
install to sync, which is the one party that can say it. A channel refusing for
a minute, a database error, GitHub — none of them is a reason to take a guild's
dashboard down to fix nothing. Repairing a stale workspace is what the poll is
for; the lifecycle route only has to avoid destroying a good one.

### A credential held under a name nothing knows says so

The account lookup produces `account_login`, which is the one field the
connection is satisfied by. When it does not answer, the token is still real and
still stored — but Initiative has nothing that counts, so the ending is
`not_recorded` rather than `connected`. Same situation as a write that did not
land, same word for it, and the same remedy: connect again, nothing was lost.
Telling them "Connected" sent them back to a dashboard that refused them with no
way to understand why.

### Needs kit 0.10.0

`beginAuthorization`, `exchangeCode`, `refreshGrant` and `fetchJson` are new
there. Everything above is the app spending them rather than restating them —
there is no `fetch` left in this app that can throw a member into a 500.

## [0.6.1] — 2026-08-26

### The manifest describes this app's API and nothing about how to draw it

A parameter could carry a `picker` naming one of an automation editor's own
controls, and briefly a whole vocabulary of them — resources, value sources,
defaults, bounds, written labels on a choice, a filter flag on an emission.
All of it is gone. Two things were wrong with it at once: it let this app
define somebody else's product surface, and it could still only ever express
what that consumer had already thought of, which is why `repo` was a text box
however carefully it was declared.

A consumer that wants a repository picker writes the step itself and calls
`list-repositories` to fill it. What this app owes is that the read exists and
answers honestly — and the five that back the obvious controls all do: a
repository, a repository's labels, a board, a board's fields, and one field's
values.

**`list-project-fields` is new** and stays, because it is a real gap in the API
rather than a convenience for anybody's form: `list-project-options` answered a
field's values, but only once you knew which field, which meant knowing a field
name to discover what the fields were called.

### Six parameters hold a list, because they always did

`labels`, `assignees`, `add`, `remove`, `reviewers` and `team_reviewers` were
comma-separated strings by convention, and a convention is not something a
caller can build a request from. Cardinality is a fact about the value, so it
stayed when presentation went. The value on the wire is unchanged —
`paramList` accepted both already.

### Every write says what it touched, in the words its emission uses

An automation service keeps a change an app made from firing that same
automation again, and for an app there was no key at all: nothing said which
returns identify the thing. `open-issue` and `issue-opened` now describe an
issue the same way — a repository name and a number, written once in
`vocabulary.ts` — so the two ends meet because one declaration produced both.
The `subject` on each delivery is built from it.

Five write endpoints now return `repository` alongside their identifiers,
because an address cannot be built from values that never come back.

### A return carries a label only where its key does not say it

Eighty-eight of a hundred and thirty-nine were the key, title-cased and
translated four ways — `title` as "Title", "Titel", "Título", "Titre". A
return's key IS the word a caller reads it by, so those said nothing `key` had
not, and the fifth language nobody wrote made the set incomplete rather than
the value unreadable.

Twenty survive, each carrying a fact the key does not: `head_ref` is a branch
but not which end, `created_at` on an issue is when it was *opened*, a Projects
v2 `item_id` is a card, and `count` beside `total` is which of the two.

### Smaller

- `since` is a `datetime`: an RFC 3339 instant is what the endpoint accepts.

## [0.6.0] — 2026-08-26

### The callable surface is GitHub's API, not a set of tiles

**Ten read endpoints**, where there were four. The four were tile-shaped — they
aggregated, and an automation cannot get an issue number out of "42 open". These
are the repository's own vocabulary, narrowed by what GitHub narrows it by:

- `list-repositories` · `list-labels`
- `get-issue` · `find-issues`
- `get-pull-request` · `find-pull-requests` (review requests included)
- `list-alerts`
- `list-projects` · `list-project-options` · `find-project-item`

The last three make `move-project-item` usable. It takes four node ids and there
was previously nowhere to obtain a single one of them, so the one write this app
offered on Projects v2 was declared and could not be wired up.

`list-repositories` is the other one worth naming: it answers the guild's list
narrowed to what the caller can actually see, which is what makes every `repo`
parameter fillable — and it was the stated reason no parameter here carried a
`picker`.

**The tile reads are gone.** The four widgets draw from the general endpoints and
narrow inside their own modules, each whole in one file under `src/widgets/`.
Counting alerts by severity or bucketing a fortnight into days is a decision
about how to draw something, so it lives with the drawing.

**Reading speaks GraphQL.** It asks for exactly the fields the manifest declares
rather than fetching an issue and dropping nine tenths of it; it takes one round
trip for an issue with its labels, assignees and milestone; it reaches the node
ids REST will not say; and its filters arrive as typed variables against a
repository already resolved from the guild's list, where a search query string
would let a crafted `assignee` add a second `repo:` qualifier. The one value that
does reach a query as words is checked against GitHub's own rule for a login
first. Writing still speaks REST, which says plainly what it does.

This also fixes the open-issue count, which was read off a pagination header that
is not sent unless the response paginates.

### An endpoint is one object

It used to live in three places: declared in the manifest, dispatched from a map,
and implemented under `github/`. Renaming one meant finding all three, and a
handler with no declaration was unreachable rather than loudly broken.

Now it is one object — what it says about itself, and what it does — grouped by
resource under `src/endpoints/`, the same shape a widget has. The manifest reads
its declarations off that list and the dispatcher reads its handlers off the same
one.

### The companion dashboard ships in the manifest

`manifest.dashboards`, rather than a hand-written second catalog file. Publishing
the app publishes it either way, but declared there it is checked against the
widgets and endpoints beside it — a standalone file naming a widget the app
renamed installs cleanly and draws nothing.

### Fewer files, and less to read

`src/github/` went from eight files to four: one client for both directions, the
app's identity merged with the registration that mints it, the guild's repository
setting moved out of `github/` (it is a setting, not a GitHub concern), and the
emissions moved in with the other endpoints. The loose fragments in `src/` —
settings, secrets, routes, page — folded into the files they belong to.

Comments were cut back to the handful that explain something the code cannot.

### Also

- `initiative-app-kit` updated; the manifest contract now lives in the kit.
- Configuration, the connection pool, the vault and the Initiative channel are
  built on first use, so `npm run manifest` renders a JSON file without demanding
  a database URL. The server still fails at boot: it reads config before it
  listens.
- Node 24, TypeScript 7, Vitest 4.
- `package.json`'s version is stamped from the release tag rather than carried on
  `main`, for the same reason the catalog files are.

It is a GitHub App now, rather than an OAuth app calling itself one. That is a
second registration with its own audience — an organization owner rather than a
guild admin — and everything below follows from having one.

### Added

- **Writes at GitHub** (`src/operations.ts`, `src/github/operations.ts`). Seven
  operations — open an issue, comment, close, reopen, label, request a review,
  move a card on a Projects v2 board — exposed at `/v1/operations` and run for a
  delegate that proves itself the same way a subscriber does.

  The app does the writing because the app holds the credential. An automation
  service holding GitHub tokens would be a second place they can leak from and
  a second thing to reason about when revoking; keeping them here means an
  organization's own installation grant is the whole of what any automation can
  do at GitHub.

  **The set is closed.** A caller picks from operations written in this repo and
  never describes a request the app performs — the difference between an
  integration and a proxy.

  **The write runs as the member wherever there is one.** A delegation token
  names its member by a pairwise subject that means nothing in this app's
  namespace; Initiative resolves it to one of the app's *own* connection refs —
  the same handle a context token hands over on the read path — so the write
  runs on that member's credential and the app learns no more about them than it
  ever did. Where there is no such member an operation may act as the app
  instead, and the response always says which happened. `request-review` refuses
  rather than substituting: a review request from the app is not a request from
  a colleague.
- **A producer surface** (`src/events.ts`, `src/github/events.ts`), and with it
  the `events` feature. This app publishes three types — an issue opened, an
  issue closed, a review requested — **directly** to whoever subscribed, on the
  shapes `initiative-app-kit` fixes rather than shapes this app invented.
  Nothing about the dashboard depends on any of it: a guild with no automation
  service gets exactly the same widgets.

  Producing directly is the whole design and not an optimization. Posting the
  event to Initiative to fan out cannot work — the vocabulary a webhook
  subscription may name is derived from Initiative's own content tables, so
  nothing can name `app.<id>.<event>` and the dispatcher matches nothing. An
  app already holds its vendor's webhook connection and has already verified its
  vendor's signature; routing the result through a third party adds a hop and a
  place to be dropped.
- Three routes for a subscriber: `GET /v1/events` for what this app produces,
  and `POST`/`GET`/`DELETE` under `/v1/events/subscriptions`. Authorized by a
  delegation token — an app the operator granted `delegation` to, proving
  itself against a key the deployment publishes — which names one guild, so a
  subscription cannot be made for a guild nobody authorized. The token is spent
  once, in the database rather than in a process, so the rule survives a second
  replica.
- Two tables behind that: `event_subscriptions`, whose secret is sealed at rest
  like a member's credential, and `delegation_tokens`, whose primary key *is*
  the one-shot check.
- `issues` and `pull_request` on the GitHub App registration, derived from the
  translator so an event handled in code cannot go missing from the form.
  Neither costs a permission: a webhook event is not one, and both are covered
  by the reads the widgets already need.
- A GitHub App registration, generated from the code that uses it
  (`src/github/registration.ts`, `npm run github-app`). The permissions and the
  webhook events on it are the ones this app actually asks for and actually
  handles, and `test/github-app.test.ts` is what keeps that true. A registration
  typed into a form drifts in two directions that both look like nothing
  happening: an event nobody subscribed to never arrives, and a permission
  nobody uses is granted by every organization forever.
- The app's own identity at GitHub (`src/github/app.ts`): a JWT signed with the
  private key, exchanged for an installation token that lasts an hour and is
  held in memory only.
- `/install/github`, which redirects to this registration's install page —
  derived from the slug GitHub reports for the private key, so it cannot name a
  different app from the one running. And `/setup/github`, where GitHub returns
  somebody afterwards. It deliberately reports nothing about the installation it
  was handed: the redirect carries an `installation_id` and no proof of
  anything.
- PKCE on the member's flow, so an authorization code caught in a redirect
  cannot be exchanged by whoever caught it.
- One-click registration of the GitHub App itself, at `/setup/github/register`
  (`src/github/setup.ts`). It posts the generated manifest to GitHub and shows
  the four credentials once; nothing is stored, so `config.ts` keeps its promise
  that credentials are read at boot and a running deployment's identity cannot
  be changed by reaching a URL. Off unless `INITIATIVE_APP_SETUP_TOKEN` is set, and
  `404` rather than `403` when it is not — a route that answers differently once
  a feature is configured tells an unauthenticated caller which deployments to
  return to. The return leg cannot be guarded by the token, since GitHub sends
  only a code and a `state`, so the state is signed with the token: rotating it
  ends every flow it authorized.
- `installation` and `installation_repositories` deliveries re-sync the installs
  they affect, so an organization installing or removing the app is reflected in
  Initiative within seconds rather than at the next poll. They are published to
  nobody: no consumer asked to hear that somebody clicked a button.
- **Dependabot alerts**, as a guild-scoped source and a fourth widget: open
  alerts by severity, worst first, answered from the installation. The tier
  matters more here than anywhere else — the people who most need to see how
  exposed a repository is are the ones least likely to have connected a personal
  GitHub account. It arrives with the `vulnerability_alerts: read` permission
  that reads it, which is the rule the permission list follows: a permission
  with no feature behind it is one an organization grants for nothing, and a
  reviewer cannot tell "not used yet" from "used for something not described".
  Note the key — the permission is called *Dependabot alerts* everywhere a
  person reads it and `vulnerability_alerts` everywhere a machine does, and
  GitHub does not complain about the wrong one; it grants nothing.
- `GITHUB_WEB_BASE`, beside the API base it always had. On GitHub Enterprise the
  API and the pages a person visits are different hosts, so configuring one and
  hardcoding the other worked everywhere except there.
- Two catalog listings, built from the manifest by `npm run catalog` and
  attached to each release: the app itself, and **GitHub overview**, a companion
  dashboard shipping a ready-made arrangement of this app's three widgets. An
  operator publishes both by dropping them into their catalog directory. The app
  was registered, live, healthy — and could not be installed by anybody, because
  nothing derives a listing from a served manifest.
- A catalog `uid`, carried by the served document as well as by the listings.
  Without one a registration verifies and names nothing, and a mandatory install
  is skipped as "has not verified yet".
- **What each endpoint is, in words, and what it hands back.** All fourteen now
  carry a `label`, a `description`, a `group` and their `returns`, in the same
  four languages the rest of the manifest is written in — the vocabulary the app
  kit added for exactly this, and the pin moves with it.

  It is the difference between an endpoint and a step somebody can use. A
  consumer with no label scrapes a title off the id, which cannot be translated
  and cannot say anything the id does not. A consumer with no `returns` has
  nothing to offer the step below, so "the issue this just opened" is not
  something an automation can express. Declared rather than discovered, because
  an automation is arranged long before this app has ever run for it: a step
  bound to a value this app does not send has to be refusable when somebody
  wires it up, not the first time it fires.

  Two of that vocabulary's fields are deliberately left off everything.
  `needs_subject` says what a run must already be *about*, and nothing here
  needs one — every endpoint names what it acts on, which is exactly what makes
  them usable from a nightly schedule that is about nothing at all, and
  claiming a need would warn people off arrangements that work. `picker` names
  one of the consumer's own richer controls, and a consumer only offers what it
  can populate — the automation editor fills its six from Initiative's own data
  and holds no GitHub credential to list anything this app asks for.
  `project_id` is the one that would look right and be wrong: it names a board
  at GitHub, not an Initiative project. A repository picker is not ruled out by
  the design; it would need this app to declare a read that lists them, which is
  a bigger decision than a hint on a param.

  What a read cannot say is worth knowing too: the return vocabulary is four
  scalar types and a list flag, so the review queue's rows and the throughput
  series have no expression in it. Those declare the scalars beside them and
  say so, rather than describing a shape this app does not send.

  Held to the code in both directions rather than merely written down: a test
  fires one of each delivery and asserts an emission sends exactly the payload
  it declared, and another runs every write against a generous GitHub and
  asserts it hands back neither more nor less than its `returns`.

### Removed

- **The automation surface.** Two trigger nodes, a `create-issue` action, and
  AUTOMATION.md. A node an app contributes is a thing that executes inside
  somebody's deployment, and that stays first-party — an app declares what its
  vendor did and stops there. `automations` is not a feature this app declares.

### Fixed

- **A member who connected their GitHub account was still told to connect, by
  every tile, forever.** The app stored the credential and never told Initiative
  it had one.

  The platform decides whether a per-member connection may be used from its own
  record — `is_satisfied` reads what is stored *against the connection*, and a
  connection declaring no fields is never satisfied by anything. `account`
  declared `fields: []`, so there was nothing to store and nothing to satisfy
  it, and the write-back that would have stored it was never called.

  Three things close it: `account` declares one `managed` field carrying the
  GitHub login — not the token, which stays sealed here — the callback writes
  it back, and the guild id needed to address that write is carried from the
  handoff through `oauth_states` rather than read off a callback GitHub
  controls. A credential that later lapses is now reported too, so the platform
  stops showing somebody as connected while every call fails.

  It predates this release and only broke `review-queue`, which is why it was
  not noticed; moving every source onto the same gate made it total.

### Changed

- **Every source runs on the caller's own GitHub credential.** Not the
  organization's installation. A member sees exactly what they can see at
  GitHub, and every source and widget now names `account` in `requires`.

  Two of these were guild-scoped and it read as generous: nobody had to connect
  an account to see how many issues were open. It is the wrong shape. That
  number is the state of a private repository, and answering it from the
  organization's grant shows it to every member of a guild including the ones
  with no access to the repository at all. The app is not in a position to
  judge — a context token names a guild and an install and nothing about what
  this person may reach — so it stops judging and lets GitHub's own permissions
  decide.

  What it costs, stated rather than discovered: every member must connect before
  any tile answers; the platform caches per member rather than once per guild,
  so one upstream call becomes one per person; and Dependabot alerts show only
  to members with security access on the repository. All three are the principle
  working.
- **Resolving which repository no longer asks GitHub, where the guild said.**
  An install that named its repositories resolves from its own list — no
  installation token, no page walk, and a working dashboard before an
  organization owner has installed the app. Blank still means "everything the
  organization granted", which only the installation can enumerate. An install
  that named repositories is no longer reported `github_app_not_installed`,
  because its tiles answer; what still waits on the installation is the webhook.
- **`GITHUB_APP_SETUP_TOKEN` is now `INITIATIVE_APP_SETUP_TOKEN`**, and the gate
  behind it moved to `initiative-app-kit`. Nothing about "an operator needs a
  one-time, self-gated bootstrap page" is GitHub-shaped: any app with a
  per-deployment vendor registration needs the same switch and the same signed
  return leg, so an operator should learn one name rather than one per
  integration.

  It also holds **more than one** token now, comma or space separated. The state
  that carries authority across the vendor's redirect is signed by whichever
  token opened the flow, so letting a second operator in — or replacing a token
  — ends exactly the flows that token authorized and leaves the rest running.
- **Every regular expression is gone**, from this app and from the kit. Three of
  them were wrong, in the way patterns are: the public-id check accepted `a..b`
  because a character class cannot say a label is non-empty; the private-address
  check saw `127.0.0.1` but not `0177.0.0.1` or `2130706433`; and the IPv6 check
  matched text that `URL` had already normalized away, so `::ffff:127.0.0.1`
  read as public. Addresses now go through `node:net` and byte comparison, and
  identifier checks read a character at a time.

  `escapeHtml` was four chained passes over a string each had already changed —
  correct only because `&` happened to be first. It is one pass over a table.
- **The permission list widened, deliberately and once.** `issues` and
  `pull_requests` went to `write`, and `organization_projects: write` is new.
  Widening is the one direction GitHub charges for — every organization that has
  already installed the app keeps the old grant until somebody re-approves — so
  it is worth doing in one go rather than in pieces, and worth doing before
  anybody has installed it. `organization_projects` is the only permission here
  that reaches past a repository, because a Projects v2 board does; there is no
  repository-scoped equivalent to prefer instead, and `repository_projects` is
  the older classic board rather than a narrower version of the same thing.
- **An install covers repositories, not a repository.** The `workspace`
  connection now takes an account and an optional list, where blank means every
  repository the installation covers — the organization already chose when it
  installed the app, and asking an admin to restate that is two copies of one
  decision. Every source takes a `repo` parameter, so a dashboard says which one
  a tile is about; since dashboards are initiative-scoped, binding it there is
  what pins one team to one repository. The app enforces "inside what the
  organization granted" and cannot enforce "inside what this team may see" —
  a context token names a guild and an install and nothing finer, so what holds
  that boundary is who may edit the dashboard.
- Sources narrow further from the same place: `milestone` and `assignee` on
  `open-issues`, `label` on `issue-throughput`, a severity floor on
  `dependabot-alerts`. The platform caches per parameter set, so two teams' tiles
  are one source answered twice rather than one answer shared.
- Every published event carries `repository` and `owner`. An app event names no
  initiative — there is nothing in a GitHub delivery that could say which one —
  so a payload field is the only thing a consumer can narrow by, and these are
  part of the pinned definition a guild installed: widening them later is a
  version every guild has to take.
- An installation is discovered from the **account** rather than from one
  repository — one grant covers every repository the organization chose, so
  asking per repository was one call per repository to learn the same id.
- A delivery is matched to installs by the installation that produced it, then
  narrowed by the guild's list. An owner is a string an admin typed and a
  repository can be renamed or transferred under one; the installation is a
  fact GitHub asserts. An `installation.created` delivery names an installation
  nothing has recorded yet, so that one is matched by account instead — which is
  exactly the guild sitting at `github_app_not_installed` waiting for it.
- **The guild's access is the organization's installation, not a token an admin
  pasted.** The `shared_account` connection is gone. An admin fills in the
  repository — the thing they were always going to fill in — and the app asks
  GitHub which installation covers it. A personal access token was a *person's*
  credential wearing the guild's name: it carried everything that person could
  reach, outlived their interest in the guild, and revoking it meant finding
  whoever minted it. An installation is listed in the organization's own
  settings, scoped to the repositories it picked, and revoked by a button that
  belongs to it.
- An install whose repository nobody has installed the app on reports
  `github_app_not_installed` rather than looking unconfigured. It is a different
  problem with a different owner.
- A member's credential is a rotating pair. A GitHub App's user token lasts
  eight hours; it is renewed on use, under a row lock, because refresh tokens
  are single-use and two replicas renewing at once would have one of them
  overwrite a good credential with nothing.
- No scopes on the member's flow. A GitHub App's user token carries the
  installation's permissions narrowed to what that member already reaches, so
  `read:user repo` had nowhere to land.
- One webhook, on the registration, covering every organization that installs
  the app — instead of one added by hand to every repository a guild configured,
  which silently received nothing from the one somebody forgot.
- Requires `initiative-app-kit` 0.5, for the producer surface and delegation
  verification.

### Fixed

- The served document carried no `uid`, so nothing tied the verified
  registration to a listing even once one existed.
- The GitHub registration's `redirect_url` pointed at the member's OAuth
  callback. It is not that URL: `redirect_url` is where GitHub returns the
  *operator* once, after a manifest creates the app — a different audience and a
  different moment from `callback_urls` and `setup_url`. All three are "where
  GitHub sends somebody afterwards", which is why they get conflated, and each
  one fails only when somebody happens to exercise that path.
- All three widgets required a member's personal account while only one of their
  sources did, so two tiles refused with `CONNECTION_REQUIRED` for every member
  who had not connected one — to draw numbers that never needed them. 0.3.0
  fixed this on the sources and left the widgets behind, which changed nothing
  anybody could see. `test/manifest.test.ts` now checks a widget against its own
  sources.

## [0.3.0]

Scoping. Every source now runs at the narrowest level that answers it, rather
than asking every member for a personal GitHub account to read a number that is
the same for the whole guild.

### Added

- A `shared_account` guild connection: one token an admin supplies, used for
  everything the whole guild sees the same answer to. A fine-grained token with
  `Issues: read` on the repository is enough.
- Held in memory rather than written down. It is Initiative's credential, lent
  on each configuration pull, so clearing the field, switching the app off or
  uninstalling stops it on the next pull — with tests for each of those.

### Changed

- `open-issues` and `issue-throughput` are answered from the guild's shared
  access. Neither has a per-person component, and naming no per-member
  connection also means the platform caches each **once per guild** instead of
  once per member — twenty people on a dashboard is now one upstream call.
- `review-queue` and the `create-issue` action stay per member, which is the
  only thing they can be: one is "waiting on my review", the other opens an
  issue under somebody's name.
- Connecting a personal GitHub account is now optional. A member who never does
  still sees the repository widgets.

### Fixed

- The well-known document now carries the envelope a registrar requires, so the
  app registers at all. Nothing it declares has changed. Released as 0.2.1.
- All three sources declared `requires: { all_of: ["workspace", "account"] }`,
  so every widget refused with `CONNECTION_REQUIRED` until each member had
  personally authorized — including the two that show identical numbers to
  everyone.

## [0.2.1]

The same fix as above, on top of 0.2.0, so an app that could not be registered
did not have to wait for the next feature.

### Fixed

- The well-known document now carries the envelope a registrar requires.

## [0.2.0]

The app talked about its installs without ever asking about them. It now holds
both halves of the conversation.

### Added

- A GitHub webhook receiver at `/webhooks/github`, verified against
  `GITHUB_WEBHOOK_SECRET`. An opened issue, a closed issue and a requested
  review become the events the manifest declares, in every guild whose install
  names that repository — the trigger nodes had nothing emitting to them.
- An install reconcile: which guilds have this app, and what each configured,
  read from Initiative at boot and on an interval as well as on the lifecycle
  signal. A signal that arrives during a restart is gone, so the poll is what
  makes it recoverable.
- The app's verdict on the configuration it was handed is reported back, so an
  admin who typed a repository this app cannot see sees that beside the install
  rather than three widgets saying "unavailable".

### Fixed

- Nothing ever pulled an install's configuration, so `workspaces` was never
  written and every data source and the create-issue action answered
  "not configured" indefinitely.
- The lifecycle signal was accepted and discarded.
- The README and package description still described an embedded page, which
  this app deliberately does not have.

### Changed

- Requires `initiative-app-kit` 0.2, for its signed channel client.

## [0.1.0]

First release: a deployable service rather than a sketch.

### Added

- Data sources, widgets, events and automation descriptors for GitHub issues
  and reviews, with per-member connections and one guild-scoped setting.
- Postgres for members' credentials, in-flight vendor handshakes and per-install
  configuration, so a restart keeps connections and more than one replica works.
- Credentials sealed at rest with AES-256-GCM under `APP_ENCRYPTION_KEY`.
- A container image published to `ghcr.io/morelitea/initiative-github` on tag,
  for `linux/amd64` and `linux/arm64`.
- `/healthz` and `/readyz`, and a graceful shutdown that finishes in-flight
  requests before the pool closes.

### Notes

- The automation block is a contract for the automation service to be built
  against; that service's half is not built yet. See `AUTOMATION.md`.
