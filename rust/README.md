# Rust workspace

The canonical Cargo workspace is rooted at `Cargo.toml` and contains the client crate in `rust/`,
the worker lifecycle crate in `rust/workhorse-worker/`, and durable context crate in
`rust/workhorse/`. The integration tests in `rust/tests/` load the shared `protocol/v1` fixtures.

The request, schedule, and contract test exercises the real `workhorse-client` PostgreSQL adapter
when `DATABASE_URL_TEST` is set. Interpreter and failure fixture execution remains Planned in the
parity registry until the corresponding public adapter operations are exposed. Runtime fixtures
remain Planned until the worker lifecycle and durable context adapters expose a fixture runner.

Run the scoped checks from the repository root:

```sh
pnpm rust:format:check
pnpm rust:clippy
pnpm rust:test
pnpm rust:release-check
```
