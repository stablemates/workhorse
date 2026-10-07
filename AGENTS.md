# Working in this repository

Instructions for coding agents and contributors.

## Work from Linear

All repository work lives in Linear's `stablemates` workspace, under the `SM` team identifier
and the `Workhorse Development` project. Linear is authoritative for priorities, blockers, and
completion.
Use the connected Linear tools or the hosted workspace at `https://linear.app/stablemates`.
Scope every issue search and creation to this workspace, team, and `Workhorse Development` project;
the `SM` team can contain other projects.

If a request names an exact `SM-*` issue, that issue is the target. If a request names an outcome,
search open issues in `Workhorse Development` for one that owns it. If none matches, create an issue with
checkable acceptance criteria. When asked for the next piece of work, select the highest-priority,
oldest, unblocked Todo issue without an active owner.

Before changing tracked files:

1. Read the target issue, its comments, and linked dependencies. Verify that it belongs to
   `stablemates`, the `SM` team, and the `Workhorse Development` project.
2. Establish ownership through the issue's assignee and move it to In Progress. Re-read the issue
   before starting; if another contributor owns the work, choose another eligible issue or report
   the conflict. Assignment is coordination, not an atomic lease.
3. Read `CONTEXT.md` and relevant decision records when the work changes domain behavior.

For iterative work, especially UI, design, copy, or exploratory changes, keep one review loop on
the original issue. After implementation and verification, keep the issue In Progress until the
requester accepts the result or explicitly asks to finish. Apply refinements toward the same outcome
to that issue; if it was closed prematurely, reopen it. Create a separate issue only when feedback
defines an independently deliverable outcome.

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

## Keep an agent pull request to one commit

A squash merge puts every commit message on the branch into the body of the commit on `main`. One
commit keeps that body a single current message with correct trailers.

An agent's pull request branch holds exactly one commit on top of its base. Review, CI, and
follow-up changes amend that commit. When the base moves, rebase onto it and keep one commit.

On each amend, rewrite the message to describe the whole change, not the first iteration. Keep the
`SM-*` identifier in the subject and one trailer per model that produced any part of the change.

After an amend or rebase, the agent may push with `git push --force-with-lease` to its own pull
request branch. Never force-push `main` or another contributor's branch. If someone else pushed to
the branch, ask a maintainer before rewriting it.

Amending discards the intermediate commits. Record verification evidence in Linear and in pull
request comments instead.

## Write commit messages and pull request descriptions as documentation

Commit messages and pull request descriptions follow the sentence rules under "For either
documentation layer". They use the terms `CONTEXT.md` defines and follow "Keep benchmark comparisons
private".

A commit message has no Markdown headings, because the squash merge copies it into `git log` on
`main`. The subject is the `SM-*` identifier and an imperative summary, about 72 characters long.
The body wraps at 72 columns and states why first, as a short scenario when behavior changes. Then
it states what changes. Verification and review stay out of the message, in Linear and in pull
request comments. The trailers follow the body.

A pull request description uses these headings in order, as `.github/pull_request_template.md`
lays out:

1. `Why`: the problem, as a short scenario in time order when behavior changes.
2. `What changes`: the change as a whole.
3. `Verification`: the exact commands and results, and what was not run and why.
4. `Review`: each review round and its outcome.
5. `Follow-ups`: the work this change leaves for later issues.

An agent's attribution line comes last. When a follow-up change amends the commit, update the
description so it describes the whole change.

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

Measuring the demo container is the exception. When an issue asks for its resident set or its CPU
cost, build the image and run it under the limits the deployment gives it. Point it at the
databases of the checkout you work in. Publish it on a port the proxy does not serve, and remove
the container when the measurement ends. Nothing visual comes from that run, so it needs no browser.

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

## Keep benchmark comparisons private

Until a maintainer decides to publish benchmarks, never name a benchmark competitor in this
repository. That covers code, documentation, decision records, commit messages, and pull request
titles and bodies. Say "the baseline" instead. Comparative results live only in the private
operations repository and in Linear.

Perf-lab and other research branches carry those names in their history. Never push them. Rebuild
the finished change on a fresh branch from `main` before opening a pull request.

## Run commands from the checkout they belong to

`pnpm worktree:setup` provisions a dedicated set of five databases for each linked worktree:
two development roles plus `test`, `bench`, and `test_packed`. It writes their URLs into that
worktree's `.env`, and it refuses to finish if that file still names another checkout's
databases. Run it once in every new linked worktree. Creating a worktree with `git worktree add`
or with a workspace tool that copies `.env` from the primary checkout does not run it.

Repository commands run through `scripts/with-env.ts`. The script resolves `.env` relative to its
own checkout and lets the five repository-owned `DATABASE_URL_*` values from that file win over the
ambient environment. In a linked worktree it refuses to run any command until those five values
name databases generated for that worktree, so an unconfigured worktree cannot reset another
checkout's test database. Keep repository scripts behind that wrapper, and do not reintroduce
`--env-file-if-exists=.env` in `package.json`. The `worktree:*` commands are the one exception:
they run bare because they have to work before a worktree is configured.

Anything spawned outside those scripts still inherits the ambient environment. If an integration
test fails on an unexpected row count, confirm which database the process resolved before treating
the result as a product failure.

A database-scope test file never uses the checkout's `test` database directly. It creates a scratch
database named after that database plus a per-process digest, and drops it in teardown. A teardown
that times out leaves the scratch database behind, and each schema change retires a schema template.
`pnpm db:sweep` lists those leftovers and `pnpm db:sweep --yes` drops them. The sweep skips every
database a checkout owns and every database a session still holds open.

## Never substitute a pinned tool

When a command reports that `pnpm`, `uv`, `go` or `gofmt` is not found, the toolchain is missing
from the PATH. Put the `mise` shims on the PATH or run the command through `mise exec --`. Never
write a stand-in for a pinned tool. A stand-in that exits 0 turns a check into a false pass, and a
false pass is worse than a failure because a failure stops the work.

Repository commands refuse a tool that does not answer as itself, and `pnpm check` and the
`pre-push` hook also refuse a version that disagrees with its `mise.toml` pin. No environment
variable turns either refusal off. `pnpm toolchain:verify` reports the state of the current PATH.

## Building before testing

`pnpm test` does not build the dashboard browser bundle. Anything that serves
`typescript/dashboard-server/dist/app`, including `test:demo-smoke` and `test:packed`, needs a full
`pnpm build` first. `pnpm build:runtime:dev` compiles only the library half.

`pnpm typescript-api:check` compares `api/typescript.txt` with the built declarations in
`typescript/core/dist`, not with the source. A stale `dist` lets the check pass locally and fail in
CI. After changing an exported signature, run `pnpm build:runtime:dev`, then
`pnpm typescript-api:generate`. The snapshot also records the value of every exported constant, so
changing one changes the public surface.

To reproduce the CI `format, generated files, lint, security, types` job locally, run its steps in
the order `.github/workflows/ci.yml` lists them, starting from the build.

Before pushing, run the whole `pnpm lint`. Running oxlint alone skips the knip dead-code check and
the Python, Go and Ruby linters. knip fails on any export that no module imports by name. A
test-support module exports only the names test files import; helpers that callers reach through a
factory's return value stay unexported.

## Writing documentation

The product documentation has two source layers for different readers. Keep both.

- `docs/architecture/` is the precise reference, one page per area. Name every function, column,
  and limit so it can answer whether observed behavior is a bug. `docs/architecture.md` is the index:
  it links every page and states what each one owns. A new page needs a row there.
- `docs/guides/` explains one concept per file for a reader new to the system. Explain the problem
  before naming the mechanism, keep every identifier, and match the register of
  `020-leases-and-fences.md`. A guide assumes general programming, PostgreSQL basics, and the three
  foundation guides (010 to 030). Define any other Workhorse term in one clause where it first
  appears, and link the guide that owns it.

An example keeps its precise documentation next to its code, as
`python/examples/langgraph_approval.md` does, not in `docs/architecture/`. A defect in an example is
not a Workhorse defect.

Rules that keep the two layers from drifting:

- A guide states exact values only inside its reference blocks. The main text describes bounded
  behavior. The architecture page stays the source of truth: when a value changes, update that page
  and every reference block that states the value.
- Each reference block ends with a `More detail:` line that links the architecture section that owns
  its facts. When the facts have several owners, link each one. When no architecture page covers
  them, link the decision record, `docs/compatibility.md`, or `docs/features.md` section that does.
  The main text links sibling guides, not architecture pages. The footer keeps one link to the
  architecture page that owns the concept.
- `scripts/guide-reference-values.test.ts` fails when a reference block states a number that no
  section on its `More detail:` line states. Fix a failure in the owning section first: add the value
  there after verifying it against the source, or link the section that already states it. [ADR
  0089](docs/decisions/0089-verify-guide-reference-values-against-their-owning-sections.md) records
  the rules.
- Site pages mirror a guide's explanation, not its reference blocks.
  `typescript/core/test/site-guide-coverage.test.ts` holds every identifier outside the blocks to
  the mapped site page. List the names a scenario invents, such as its queues, tenants, task types,
  and application functions, in a `<!-- scenario-names: … -->` comment under the title. The test
  exempts only those names and rejects a listed name the guide no longer uses.
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
links, and the single reference link. `000-start-here.md` is an index and keeps its own shape.

Write the explanation scenario-first:

- Open each section that explains behavior with one concrete case told in time order. Name the
  queue, key, or task, and walk through what happens step by step. State the general rule after the
  case.
- Use plain words and no analogies. An analogy gives a term a second meaning.
- Treat scenario numbers as illustration. Use relative times such as "at 2 s" when the gaps matter,
  and a clock time only when a fixed moment matters. When a scenario uses a real default, its
  reference block states that default.
- Check every general claim inside a scenario against the source. A scenario reads easily, so a
  loose sentence in it is easy to miss.
- Close a behavior section with a collapsed reference block. Its summary starts with `Reference:`.
  It holds exact identifiers, limits, defaults, outcomes, and events as tables or numbered
  conditions. It ends with a `More detail:` line that links each owning section.
- Leave a blank line after `</summary>` and before `</details>`, or GitHub renders the block's
  Markdown as plain text.
- The main text may not state a fact that its reference blocks or the architecture page lack.
- A section that only summarizes consequences or limits that earlier sections explain, such as
  "What this means for you" or "What this does not do", needs neither a scenario nor a reference
  block. It may state no behavior that the guide does not explain elsewhere.

For either documentation layer:

- Keep one idea per sentence and stay under 25 words where practical. A contrast between two
  things is one idea.
- Avoid noun clusters longer than three words.
- Put the condition first. An imperative may put its condition last.
- Name the actor. Workhorse performs a state transition and gives a product-wide guarantee; the
  worker performs process behavior. Say PostgreSQL only when the point is that the database, not the
  worker, holds the authority.
- Explain what a mechanism is for before explaining how it works. This holds per guide: state the
  purpose once, early, and a later section may be pure mechanism.
- Give each term one meaning and one part of speech.
- Use the terms `CONTEXT.md` defines; it is the vocabulary source.
  `scripts/glossary-avoid-words.test.ts` flags its avoided words under `docs/`, apart from the
  senses `scripts/glossary-allowlist.json` names.
