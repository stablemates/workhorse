# Rust conformance evidence

Generated from `protocol/v1` at protocol version 4. The harness currently proves fixture loading, manifest coverage, and fixture shape. Runtime execution awaits the SDK seams owned by SM-16A, SM-16B, and SM-16C.

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

The manifest declares 19 runtime capabilities and 5 language fixture identifiers. Once the client, worker, and durable context crates land, their adapters must execute these same files without copying them.

Regenerate with `pnpm rust:conformance:generate`; CI uses `pnpm rust:conformance:check`.
