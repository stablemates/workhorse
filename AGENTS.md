# Working in this repository

Instructions for coding agents and contributors. If the work changes domain behavior, read `GLOSSARY.md`
and the relevant decision records. Finish only after every acceptance item is verified and the
relevant repository checks pass. For historical issue references, read
[tracker history](docs/tracker-history.md).

## Never do these things

- Do not start the demo: not `pnpm demo`, not `pnpm demo:app`, and not a variant in the background.
- Do not run a production setup, deploy, rollback, or container lifecycle command unless a maintainer explicitly asks for that operation.
- Never put benchmark numbers or performance claims about another product in this repository. This includes commit messages and pull requests. Never push a perf-lab or research branch.
- Never write a stand-in for a pinned tool. If a command reports that `pnpm`, `uv`, `go`, or `gofmt` is not found, put the `mise` shims on the PATH or use `mise exec --`.

## Every change

- In each new linked worktree, run `pnpm worktree:setup` one time.
- `pnpm test` does not build the dashboard browser bundle or the TypeScript declarations. Run `pnpm build:runtime` or `pnpm build` first.
- Before you push, run the whole `pnpm lint`.
- An agent commit ends with one `Co-Authored-By:` trailer for each model that produced the change, with the exact model ID. An agent pull request has one commit.
- Write all text in Simplified Technical English, and use the terms in `GLOSSARY.md`.

## Read before the task

| Before you                                                                                                                                                       | Read                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| commit, rebase or push a branch, open or update a pull request, or write a review brief                                                                          | [`commits-and-pull-requests.md`](docs/agents/commits-and-pull-requests.md)           |
| merge, cancel a CI run, investigate a CI failure, tag a release candidate, or see which CI lanes a change selects                                                | [`ci-and-releases.md`](docs/agents/ci-and-releases.md)                               |
| set up a worktree, write a database test, investigate an unexpected row count, clean up leftover test databases, or change a repository script or `package.json` | [`checkouts-and-databases.md`](docs/agents/checkouts-and-databases.md)               |
| run tests, benchmarks, or the API snapshot check                                                                                                                 | [`testing.md`](docs/agents/testing.md)                                               |
| change the dashboard user interface or its Content Security Policy                                                                                               | [`dashboard-browser-check.md`](docs/agents/dashboard-browser-check.md)               |
| work near the demo, a deployment, a benchmark, or a comparison page                                                                                              | [`demo-deployment-and-benchmarks.md`](docs/agents/demo-deployment-and-benchmarks.md) |
| change a file in `docs/` or `site/`                                                                                                                              | [`writing-documentation.md`](docs/agents/writing-documentation.md)                   |
| write a document, commit message, pull request, Linear issue, or Linear comment                                                                                  | [`simplified-technical-english.md`](docs/agents/simplified-technical-english.md)     |
