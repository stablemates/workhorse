# Working in this repository

Instructions for coding agents. Everything here is a rule an agent has broken before.

## Use the Linear MCP server for issue tracking

Use the configured Linear MCP server for every issue-tracking operation instead of another
tracker or an interactive client.

If no Linear issue exists for the work, create one before starting implementation.

When asked to pick up the next issue, select only an issue that has not started. Never pick up an
issue in an in-progress state unless the person you are working with explicitly names that issue.

Begin every commit subject for tracked work with the Linear issue identifier in square brackets.
After the subject, add a blank line, the issue URL, another blank line, and a concise description
of the change and why it was made:

```text
[WOR-123] Add lease recovery

https://linear.app/workhorse-run/issue/WOR-123/add-lease-recovery

Recover work after an expired lease so another worker can safely resume it.
```

## Do not run GitHub Actions

GitHub Actions are intentionally disabled at the repository level while this repository is
private. Do not dispatch, re-enable, or try to repair any workflow. Leave the definitions in
`.github/workflows/` intact until the repository becomes public and the CI work is scheduled
explicitly.

## Never run the demo server

Do not start the demo. Not `pnpm demo`, not `pnpm demo:app`, not a variant, not in the
background, not wrapped in a timeout. If a change needs to be seen running, or the demo appears
to be down, ask the person you are working with to start it and report what they see.

An agent starting the demo has no way to judge the result — the dashboard is a data-driven
single-page app whose layout can only be assessed by a human with a browser open — and several
failure modes follow from it:

- A long-lived proxy serves `workhorse.localhost`. It outlives the demo process, so a demo that
  was stopped shows up as `504 Gateway Timeout` on every URL rather than a connection error.
- Stopping Vite abruptly during dependency pre-bundling corrupts
  `dashboard/app/node_modules/.vite`. The signature is a `504` on a
  `/@fs/**/.vite/deps/*.js` chunk while a server is running; the fix is to delete that directory
  and restart.
- A running demo writes continuously to its database. Point it at the wrong one and it will
  corrupt another checkout's test data (see below).

## Run commands from the checkout they belong to

`scripts/setup-worktree.ts` provisions a dedicated set of databases for each linked worktree —
`dev`, `test`, `bench`, and `demo` alike — and writes their URLs into that worktree's `.env`.

Repository commands run through `scripts/with-env.ts`, which resolves `.env` relative to its own
file rather than the working directory, and lets the four `WORKHORSE_*_DATABASE_URL` values and
`DATABASE_URL` from that file win over anything already exported. So a command belongs to the
checkout whose `package.json` defines it, no matter which directory or shell invoked it.

This matters because plain `node --env-file` loses to variables already in the environment. An
interactive shell hides that when a directory-aware loader such as mise or direnv re-exports on
every `cd`; a shell that changed directory without such a hook keeps the previous checkout's
values, and before `with-env.ts` those values silently won. Do not reintroduce
`--env-file-if-exists=.env` in a `package.json` script.

Anything spawned outside those scripts still inherits the ambient environment. If an integration
test fails on a row count that looks slightly off, confirm which database the process actually
resolved before concluding anything about the test.

## One worktree, one branch, one commit

A branch checked out anywhere is locked everywhere: `git checkout main` inside a linked worktree
makes `main` unavailable in the primary clone until you switch away. Treat each worktree's branch
as fixed for the life of that worktree.

Keep all changes for a worktree task in one commit. If verification or review requires more edits,
amend that commit instead of adding follow-up commits.

Integrate from the primary clone, not by checking out `main` inside a worktree. Rebase the worktree
branch onto `origin/main`, then merge it into `main` with `git merge --ff-only <branch>`. The
`origin/main` ref is remote-tracking and is never checked out by anyone.

## Building before testing

`pnpm test` does not build the dashboard browser bundle. Anything that serves
`typescript/dashboard-server/dist/app` — `test:demo-smoke`, `test:packed` — needs a full `pnpm build`
first. `pnpm build:runtime:dev` only compiles the library half.

## Writing documentation

The docs have two layers, for two different readers. Keep both.

- `docs/architecture.md` is the precise reference. Name every function, column, and limit.
  Do not simplify it, and do not soften it into plain language — its job is to answer
  "is this behaviour a bug?" exactly.
- `docs/guides/` explains one concept per file, for someone who has never seen this system.
  Explain it as you would to a smart 16-year-old who codes, but keep every identifier. Say
  what problem a thing solves before you name it. Expect roughly three times the length of
  the equivalent reference text; that is the cost of the on-ramp. Match the register of
  `020-leases-and-fences.md`, which is the reference example.

Rules that keep the two layers from drifting into each other:

- **A guide states no numbers.** No byte limits, no timeouts, no batch sizes, no function
  signatures. Say "size-capped and rate-limited"; the reference says how much. Exact values
  then live in exactly one place and can change freely.
- **One link to `architecture.md` per guide**, in the footer, never inline. Guides link to
  each other freely.
- **One owner per concept.** Fence tokens are explained in `020-leases-and-fences.md` and
  nowhere else; other guides get one clause and a link. Without this you get thirteen
  partial explanations that disagree.
- **Never renumber a guide.** Numbers appear in links. Insert into the gaps — bands of one
  hundred, gaps of ten — and let the reading order absorb it.
- **Verify examples against the source** before writing them. `HandlerContext` is in
  `typescript/core/src/worker.ts`; `EnqueueOptions` and the `Queue` methods are in `typescript/core/src/types.ts` and
  `typescript/core/src/queue.ts`. Do not write an example from memory.

Both layers name real identifiers, so a rename stays greppable across both. If you change
behaviour a guide describes, update it in the same commit.

Every guide follows the same shape: title as the reader's question, one or two sentences of
what and why, the explanation, a small verified example where one helps, a `## Next` block
of two to three sibling links, then the single reference link.

Prose rules for either layer:

- One idea per sentence, under 25 words where you can manage it.
- No noun cluster longer than three words. Write "recovery of an expired lease", not
  "bounded expired-lease recovery".
- Put the condition first: "If the rollup stalls, history accumulates."
- Name the actor. "PostgreSQL validates the policy", not "the policy is validated".
- Say what a thing is for before you say how it works.
- One meaning per term. `claim`, `fence`, `wait`, `pause`, and `redrive` are each currently
  used as both noun and verb — pick one part of speech per term and stay with it.
