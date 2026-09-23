# Rust durable runtime parity evidence

`HandlerContext` calls the same PostgreSQL protocol functions as the established runtimes. Its
method names follow the `HandlerContext` methods that Python and Go expose, as [ADR
0074](../docs/decisions/0074-shape-the-rust-sdk-as-one-python-shaped-crate.md) requires.

| Handler operation          | PostgreSQL authority                    | Rust `HandlerContext`              |
| -------------------------- | --------------------------------------- | ---------------------------------- |
| Checkpoint replay and save | `task_checkpoint`, `save_checkpoint_v1` | `checkpoint`                       |
| Durable timer              | `schedule_wait_v1`                      | `sleep`, `sleep_until`             |
| Signal wait                | `wait_for_signal_v1`                    | `wait_for_signal`                  |
| Human decision wait        | `wait_for_human_v1`                     | `wait_for_human`                   |
| Child task                 | `create_child_v1`                       | `run_child`                        |
| Child fan-out and join     | `create_children_v1`                    | `run_children`, `run_children_all` |
| Latest progress            | `task_progress`, `update_progress_v1`   | `get_progress`, `set_progress`     |

`BatchHandlerContext` offers `checkpoint`, `get_progress`, and `set_progress` for each batch member.

The shared SQL fixture lane remains the authority for cross-language behavior.
`rust/tests/protocol_conformance.rs` runs the suspension-replay and lease-loss fixtures through the
real worker. `rust/tests/durable_postgres.rs` covers each operation against a scratch database. The
worker passes the claimed task UUID, worker ID, and fence to every mutating call.
