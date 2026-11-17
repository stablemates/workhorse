# Testing

This page tells an agent how to build and test Workhorse. Read it before you run tests, benchmarks, or the API snapshot check.

## Never substitute a pinned tool

When a command reports that `pnpm`, `uv`, `go` or `gofmt` is not found, the toolchain is missing
from the PATH. Put the `mise` shims on the PATH or run the command through `mise exec --`. Never
write a stand-in for a pinned tool. A stand-in that exits 0 turns a check into a false pass, and a
false pass is worse than a failure because a failure stops the work.

Repository commands refuse a tool that does not answer as itself, and `pnpm check` and the
`pre-push` hook also refuse a version that disagrees with its `mise.toml` pin. No environment
variable turns either refusal off. `pnpm toolchain:verify` reports the state of the current PATH.

## Building before testing

`pnpm test` does not build the dashboard browser bundle or the TypeScript declarations. Some test
files skip their cases when a build output is missing. Thus `pnpm test` starts with
`pnpm test:build-check`. If an output in `requiredTestBuildOutputs` of
`scripts/test-build-outputs.ts` is missing, the command names the output and exits non-zero before
a test runs. It does not build the outputs. Run `pnpm build:runtime` or `pnpm build` first. If you
add a test that skips when a build output is missing, add that output to the list.

Anything that serves `typescript/dashboard-server/dist/app`, including `test:demo-smoke` and
`test:packed`, needs a full `pnpm build` first. `pnpm build:runtime:dev` compiles only the library
half, so `pnpm test:build-check` refuses its output.

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

## Run the npm release test scope

The CI job `npm release test scope` runs the npm unit suite. The suite includes the checks of the
documentation, the changelogs, the workflows, and the support matrix. In November 2026 it had about
4,450 tests and took about 3 minutes. Run it with a maximum of four workers. CI passes no worker flag, and `vitest.config.ts` sets the
count there:

1. `mise exec -- pnpm build:runtime:check-dashboard-bundle`
2. `mise exec -- pnpm npm:test:unit --maxWorkers=4`

## Test the Ruby Active Job adapter

1. Run `pnpm ruby:test:active-job`.
2. Run it again on the Rails floor:
   `BUNDLE_GEMFILE=$PWD/ruby/gemfiles/rails_8_1.gemfile pnpm ruby:test:active-job`. The floor is
   `activejob.minimum` in `support.json`; in November 2026 it was 8.1. The weekly `ruby-rails` CI
   job uses that gemfile. `rails_main.gemfile` belongs to the `ruby-rails-main` CI job.
3. After a change to a Gemfile, run `pnpm ruby:lockfile-check`.

## Run a benchmark smoke test

1. Reset the benchmark database: `pnpm db:reset:bench`.
2. Run all suites: `pnpm benchmark -- --suite all --profile smoke --output <file>`.
3. To run one scenario, use `--suite lifecycle --scenario worker-concurrency`.

The output JSON holds the metrics, for example `concurrency1MaxConcurrentQueries`. The benchmark
invariants are sensitive to timing. Do one scenario many times to reproduce a failure, not the full
run one time. Benchmark results stay private, as `demo-deployment-and-benchmarks.md` states.

## Check the dashboard in a browser

No CI lane loads the standalone dashboard in a browser. After a change to the dashboard user
interface or its Content Security Policy, follow
[`dashboard-browser-check.md`](dashboard-browser-check.md).
