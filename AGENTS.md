# Working in this repository

Always talk in ASD-STE100 Simplified Technical English. Always read CONTEXT.md files, and use their ubiquitous language.

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
