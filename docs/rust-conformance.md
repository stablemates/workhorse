# Rust conformance evidence

Generated from `protocol/v1` at protocol version 4. The harness executes request, schedule, and contract fixtures through the `workhorse-client` PostgreSQL adapter when `DATABASE_URL_TEST` is set. Interpreter and failure execution remains Planned until public adapter operations exist; runtime execution remains Planned until the worker and durable context fixture seams land.

## Generated fixture inventory

| Fixture                 | Entries |
| ----------------------- | ------: |
| `compatibility.json`    |      10 |
| `contracts.json`        |       7 |
| `cron-occurrences.json` |      19 |
| `failures.json`         |       4 |
| `interpreter.json`      |       1 |
| `requests.json`         |       2 |
| `runtime.json`          |      16 |
| `scenarios.json`        |      15 |
| `schedules.json`        |       2 |

The manifest declares 19 runtime capabilities and 5 language fixture identifiers. The client adapter is exercised by the PostgreSQL test. SM-16B and SM-16C still need to expose runtime fixture execution before runtime evidence can become Supported.

Regenerate with `pnpm rust:conformance:generate`; CI uses `pnpm rust:conformance:check`.
