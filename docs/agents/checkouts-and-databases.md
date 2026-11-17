# Checkouts and databases

Each checkout of Workhorse owns its own databases. This page tells an agent how to set up a worktree and how database tests keep their data apart. Read it before you set up a worktree, write a database test, or investigate an unexpected row count.

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
database a checkout owns and every database a session still holds open. It also keeps the schema
template of each worktree's current schema. It skips a template that a test harness copies at that
time, and each scratch database or template of a test process that still runs. Each SDK harness
holds a shared advisory lock on the name of its scratch database from creation to drop, on a session
of the `postgres` database. The release package checks and the PydanticAI example hold the same
lock on their scratch databases. That session ends with the process, so the sweep can drop the
databases that a stopped process left. A .NET class database is the exception: its lease ends with
its class, because no test uses it after that. The run drops it at its end, or the sweep drops it
earlier.

A database test must not read rows or state that another test wrote. Each SDK harness keeps the
tests apart:

- TypeScript gives each test file a database of its own. `createIntegrationTestContext` resets it
  before each test.
- Ruby and the JVM reset the database of the process before each test.
- .NET `Workhorse.Tests` and `Workhorse.AspNetCore.Tests` give each test class a database of its
  own, and they reset that database after each test. A test class there that uses PostgreSQL
  declares `IClassFixture<ScratchDatabase>`.
- The two .NET examples projects share one database for each process, with no reset. Each
  `DROP DATABASE` forces a checkpoint of the shared server, so a database for each class made them
  much slower. A snippet test that runs a worker on a fixed queue uses
  `ExampleDatabase.CreateIsolatedAsync`.
- Python, Go, and Rust create a database for each test.
