# Rust conformance evidence

Generated from `protocol/v1` at protocol version 5 and from
`rust/tests/conformance/expected-unsupported.json`.

`rust/tests/protocol_conformance.rs` executes every `protocol/v1` fixture through the Rust
adapters against a scratch PostgreSQL database. A fixture either passes or appears on the
expected-unsupported list with the Issue that owns the gap. The runner fails when an unlisted
fixture does not pass, and when a listed fixture passes. `pnpm rust:test` runs it in CI.

## Fixture inventory

| Fixture file            | Declared | Passing | Expected unsupported |
| ----------------------- | -------: | ------: | -------------------: |
| `compatibility.json`    |       12 |      12 |                    0 |
| `contracts.json`        |       19 |      19 |                    0 |
| `cron-occurrences.json` |       19 |      19 |                    0 |
| `failures.json`         |        4 |       4 |                    0 |
| `interpreter.json`      |        1 |       1 |                    0 |
| `requests.json`         |        2 |       2 |                    0 |
| `runtime.json`          |       17 |      17 |                    0 |
| `scenarios.json`        |       16 |      16 |                    0 |
| `schedules.json`        |        3 |       2 |                    1 |

## Expected unsupported fixtures

The list gives the reason for each entry. Remove an entry in the commit that makes it pass.

### SM-1063

- `schedules/contracted-schedule-definition`

Regenerate with `pnpm rust:conformance:generate`; CI uses `pnpm rust:conformance:check`.
