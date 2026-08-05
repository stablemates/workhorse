# Working in this repository

Instructions for coding agents. Everything here is a rule an agent has broken before.

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
  `packages/dashboard/node_modules/.vite`. The signature is a `504` on a
  `/@fs/**/.vite/deps/*.js` chunk while a server is running; the fix is to delete that directory
  and restart.
- A running demo writes continuously to its database. Point it at the wrong one and it will
  corrupt another checkout's test data (see below).

## Run commands from the checkout they belong to

`scripts/setup-worktree.ts` provisions a dedicated set of databases for each linked worktree and
writes their URLs into that worktree's `.env`. Repository commands read that file through
`node --env-file-if-exists=.env`, which keeps checkouts isolated.

`--env-file` does not override variables already present in the environment. A shell configured
for one worktree therefore carries its `WORKHORSE_*_DATABASE_URL` values into any command it
runs — including commands run in a different checkout, which will then quietly read and write
the first worktree's databases. Run a checkout's commands from that checkout's own environment.

If an integration test fails on a row count that looks slightly off, confirm which database the
process actually resolved before concluding anything about the test.

## One worktree, one branch

A branch checked out anywhere is locked everywhere: `git checkout main` inside a linked worktree
makes `main` unavailable in the primary clone until you switch away. Treat each worktree's branch
as fixed for the life of that worktree.

Integrate from the primary clone or through a pull request — not by checking out `main` inside a
worktree. To bring a worktree up to date, rebase or merge `origin/main`, which is a
remote-tracking ref and is never checked out by anyone.

## Building before testing

`pnpm test` does not build the dashboard browser bundle. Anything that serves
`packages/dashboard/dist/app` — `test:demo-smoke`, `test:packed` — needs a full `pnpm build`
first. `pnpm build:runtime:dev` only compiles the library half.
