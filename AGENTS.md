# Working in this repository

Instructions for coding agents and contributors.

## Work from production Ontrack

All repository work lives in the production Ontrack `Workhorse` Project (`WH`). Connect over
pgwire with `ONTRACK_AGENT_DSN` from this checkout's ignored `.env`; the Board is hosted at
`https://ontrack.sh` and is never a local process. If the hosted Board is unreachable, stop and tell
the Human. A local Ontrack database contains no authoritative Workhorse Issues.

The machine's Private Token lives once in `~/.pgpass`, whose mode must be `0600`. The DSN carries no
password, requires `sslmode=require`, and uses its username only as this checkout's Agent Session
name. The secret resolves the host Agent; the Session separates simultaneous checkouts. Never put a
secret in `.env`, a command, a Comment, or Git.

This checkout's `.env` must contain `ONTRACK_AGENT_DSN` explicitly. Never inherit another
checkout's ambient value. A linked worktree gets the host DSN from its primary checkout, strips any
password, and rewrites the username to its worktree ID. If the key is absent, configure it in the
primary checkout and rerun that repository's worktree setup; do not copy another worktree's DSN or
mint another Agent.

If a request names an exact `WH-*` Issue, that Issue is the target. If a request asks for the next
piece of work, claim it with `app.claim_next(project_key => 'WH')`: one atomic statement that
takes the highest-priority, oldest, unblocked Todo Issue in `WH` and skips rows other Sessions hold.
Do not query the Board, pick a key, and then call `app.claim_issue`; on a shared Board the gap
between the query and the claim is a race. If a request names an outcome but no key, search open
Workhorse Issues for one that owns that outcome. If none matches, file an Issue with
`app.file_issue`, `project_key => 'WH'`, and checkable acceptance criteria.

Before changing tracked files:

1. Load this checkout's `.env` and connect with a PostgreSQL client. Require the DSN to be
   passwordless, TLS-required, and named for this checkout.
2. Claim the target: `app.claim_next(project_key => 'WH')` for the next Issue, or
   `app.claim_issue('WH-123')` when the request names that exact Issue. Work only Issues this
   Session holds.
3. Read the claimed `WH-*` Issue, its Comments, and both ends of its Relations. Read the
   repository's `CONTEXT.md` and relevant decision records when the work changes domain behavior.
   If the Issue turns out not to be workable by this Session, Comment why and release it with
   `app.release_issue`.

The host Agent may see other Ontrack Projects, so every Board read must filter
`project_key = 'WH'`, every new Issue must pass `project_key => 'WH'`, and every mutation must name
an exact `WH-*` key. Never call the bare `app.claim_next()` without `project_key`: that form spans
every Project the Agent is a Member of and can claim another repository's work.

An imported Issue's Ontrack `WH-*` key is its current working identity. Its `Plane provenance`
section and source UUID preserve the historical Plane key. In Git history, `WH-*` subjects before
the tracker cutover commit mean Plane keys; later subjects mean native Ontrack keys. Use
`docs/tracker-history.md` and imported provenance to cross that boundary.

Keep the Board current while working. Renew the Lease at least every two minutes with
`app.renew_lease('WH-123')`, and add Comments for material decisions, scope changes, and verification
evidence with `app.add_comment`. A live Lease means In Progress; do not set that Status directly.

Finish only after every acceptance item is verified and the relevant repository checks pass. Add a
Comment with the exact evidence, update the Issue checklist, and set it to Done in the same task.
When another Agent can continue the current work as-is, Comment the handoff and move it to Todo.
When a Human decision or action is required, Comment the boundary and move it to Backlog at that
moment. Do not leave a live Lease behind while waiting.

## Do not run the demo server

Do not start the demo. Not `pnpm demo`, not `pnpm demo:app`, and not a variant in the background.
The dashboard is a data-driven single-page app, so a person with a browser should start it and
assess changes that need visual verification.

A long-lived proxy serves the local demo hostname. If the demo stops, the proxy returns `504
Gateway Timeout` rather than a connection error. Stopping Vite during dependency pre-bundling can
also corrupt `typescript/dashboard/app/node_modules/.vite`; remove that cache and restart the demo
if a running server returns a `504` for a `.vite/deps` chunk.

The demo writes continuously to its database. Run repository commands from the checkout that owns
their data so one checkout cannot change another checkout's test state.

## Maintainers own public deployment

Do not run a production setup, deploy, rollback, or container lifecycle command unless a maintainer
explicitly asks for that operation. The files under `config/` are parameterized examples; they are
not the source of truth for any live installation.

If a change affects the public deployment contract, runtime configuration, image publishing, host
prerequisites, or deployment procedure, update `typescript/demo/DEPLOYMENT.md` in the same commit.

## Run commands from the checkout they belong to

`scripts/setup-worktree.ts` provisions a dedicated set of five databases for each linked worktree:
two development roles plus `test`, `bench`, and `test_packed`. It writes their URLs into that
worktree's `.env`.

Repository commands run through `scripts/with-env.ts`. The script resolves `.env` relative to its
own checkout and lets the five repository-owned `DATABASE_URL_*` values from that file win over the
ambient environment. Keep repository scripts behind that wrapper, and do not reintroduce
`--env-file-if-exists=.env` in `package.json`.

Anything spawned outside those scripts still inherits the ambient environment. If an integration
test fails on an unexpected row count, confirm which database the process resolved before treating
the result as a product failure.

## Building before testing

`pnpm test` does not build the dashboard browser bundle. Anything that serves
`typescript/dashboard-server/dist/app`, including `test:demo-smoke` and `test:packed`, needs a full
`pnpm build` first. `pnpm build:runtime:dev` compiles only the library half.

## Writing documentation

The product documentation has two source layers for different readers. Keep both.

- `docs/architecture.md` is the precise reference. Name every function, column, and limit so it can
  answer whether observed behavior is a bug.
- `docs/guides/` explains one concept per file for a reader new to the system. Explain the problem
  before naming the mechanism, keep every identifier, and match the register of
  `020-leases-and-fences.md`.

Rules that keep the two layers from drifting:

- A guide states no numbers. Describe bounded behavior in the guide and keep the exact value in
  `architecture.md`.
- Link to `architecture.md` once per guide, in the footer, and never inline.
- Give each concept one guide owner. Other guides should use one clause and a link.
- Never renumber a guide because its number appears in links. Insert new guides into existing gaps.
- Verify examples against the source before writing them. `HandlerContext` is in
  `typescript/core/src/worker.ts`; `EnqueueOptions` and the `Queue` methods are in
  `typescript/core/src/types.ts` and `typescript/core/src/queue.ts`.

The published site in `site/content/docs/` consumes those source layers. `site/guide-coverage.json`
maps each guide to its site page or a tracked exclusion. If you add a guide, add its mapping. If you
change behavior described by a mapped guide, update its site page in the same commit.

Every guide uses the same shape: a title phrased as the reader's question, a short statement of what
and why, the explanation, a verified example when useful, a `## Next` block with two or three sibling
links, and the single reference link.

For either documentation layer:

- Keep one idea per sentence and stay under 25 words where practical.
- Avoid noun clusters longer than three words.
- Put the condition first.
- Name the actor.
- Explain what a mechanism is for before explaining how it works.
- Give each term one meaning and one part of speech.
