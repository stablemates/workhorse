# Rust durable runtime parity evidence

The Rust adapter uses the same PostgreSQL protocol functions as the established runtimes. The
adapter method names are interim. [ADR 0074](../docs/decisions/0074-shape-the-rust-sdk-as-one-python-shaped-crate.md)
renames them to the `HandlerContext` methods that Python and Go expose.

| Handler operation          | PostgreSQL authority                    | Rust adapter                             |
| -------------------------- | --------------------------------------- | ---------------------------------------- |
| Checkpoint replay and save | `task_checkpoint`, `save_checkpoint_v1` | `PostgresDurableContext::replay_or_save` |
| Durable timer              | `schedule_wait_v1`                      | `schedule_timer`                         |
| Signal wait                | `wait_for_signal_v1`                    | `wait_for_signal`                        |
| Human decision wait        | `wait_for_human_v1`                     | `wait_for_human`                         |
| Child fan-out and join     | `create_children_v1`                    | `fan_out`                                |
| Latest progress            | `task_progress`, `update_progress_v1`   | `progress`, `publish_progress`           |

The shared SQL fixture lane remains the authority for cross-language behavior. Rust tests exercise the
adapter's result mapping and are intended to run beside that lane once a provisioned database is
available. The worker passes the claimed task UUID, worker ID, and fence to every mutating call.
