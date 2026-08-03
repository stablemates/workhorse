# ADR 0016: Fenced latest-value job progress

## Status

Accepted for schema version 16.

## Decision

Store mutable progress in one `job_progress` row per job, separate from immutable payload, checkpoints, and
outcomes. `update_progress_v1` locks and verifies the exact active runtime generation before replacing the
value. Each accepted change increments a revision and retains attempt, fence, worker, and timestamps.

Progress values are limited to 65,536 bytes of canonical JSONB text. Changed writes from one fence are
limited to one every 100 milliseconds. Identical writes are no-ops. New ownership generations may report
immediately so recovery is not delayed by the previous worker's update.

Accepted changes append a `progress_updated` event containing revision, byte size, and fence, but not the
possibly sensitive progress value. The latest row remains available through retry and terminal state and is
removed with the job identity.

## Consequences

- Progress is inexpensive to read and does not grow one mutable row per update.
- Lifecycle telemetry still grows per accepted change, bounded by the update interval and retention policy.
- Progress cannot be used for replay or exactly-once effects. Checkpoints remain the restart-boundary API.
- Callers must handle `ProgressRateLimitError` when reporting changed values too frequently.
