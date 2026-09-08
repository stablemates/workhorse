# Working in this repository

Instructions for coding agents and contributors.

## Work from Linear

All repository work lives in Linear's `stablemates` workspace, under the `SM` team identifier
and the `workhorse` project. Linear is authoritative for priorities, blockers, and completion.
Use the connected Linear tools or the hosted workspace at `https://linear.app/stablemates`.
Scope every issue search and creation to this workspace, team, and project; the `SM` team can
contain other projects.

If a request names an exact `SM-*` issue, that issue is the target. If a request names an outcome,
search open issues in `workhorse` for one that owns it. If none matches, create an issue with
checkable acceptance criteria. When asked for the next piece of work, select the highest-priority,
oldest, unblocked Todo issue without an active owner.

Before changing tracked files:

1. Read the target issue, its comments, and linked dependencies. Verify that it belongs to
   `stablemates`, the `SM` team, and the `workhorse` project.
2. Establish ownership through the issue's assignee and move it to In Progress. Re-read the issue
   before starting; if another contributor owns the work, choose another eligible issue or report
   the conflict. Assignment is coordination, not an atomic lease.
3. Read `CONTEXT.md` and relevant decision records when the work changes domain behavior.

Keep the issue current with comments for material decisions, scope changes, and verification
evidence. Finish only after every acceptance item is verified and relevant repository checks pass.
Record the exact evidence, update the checklist, and move the issue to Done in the same task.
When another contributor can continue the work as-is, record the handoff and move it to Todo.
When a human decision or action is required, record the boundary and move it to Backlog.
Clear your assignment when handing off or waiting. Use the team's configured workflow states
corresponding to these stages.

Linear starts fresh: do not migrate old tickets or translate `WH-*` numbers into `SM-*` numbers.
When following historical issue references in commits or decision records, read
[tracker history](docs/tracker-history.md). Use `SM-*` identifiers for new work and commit subjects.

## Sign agent commits with the model

A commit an agent makes ends with one `Co-Authored-By:` trailer per model that produced the change,
naming the exact model ID. That trailer is the message's only agent attribution: it names no
harness, product, or session.

```
Co-Authored-By: claude-fable-5-1 <noreply@anthropic.com>
```

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
explicitly asks for that operation.

Nothing in this repository deploys anything. The live deployment runs from a private operations
repository, and it consumes only `Dockerfile`, `Dockerfile.site`, and what they copy. This
repository once carried parameterized copies of the deployment orchestration, which read as the real
thing and sent work to files that could not affect any deployment; [ADR
0060](docs/decisions/0060-describe-the-deployment-contract-instead-of-shipping-an-example.md)
deleted them. Do not reintroduce a deploy script, a Kamal configuration, or a `.kamal/` directory
here.

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
