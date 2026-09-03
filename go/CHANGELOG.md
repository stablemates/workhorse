# Go changelog

`github.com/stablemates/workhorse/go` versions and release notes live here because the Go module
builds and publishes from its own tag. It carries the version the TypeScript packages and the Python
distribution carry, because all three tags name one commit.

Workhorse is a public beta. Any 0.x minor release may change behaviour. From `0.1.0` the schema
upgrades in place: every release ships ordered migrations, and inside a major line a migration only
adds.

## 0.1.0 — 2026-09-14

Published through the Go module proxy from one source commit shared with the npm packages and the
Python distribution, tagged `go/v0.1.0`. This is the first version without a prerelease suffix
([ADR 0050](../docs/decisions/0050-release-0-1-0-without-a-prerelease-suffix.md)). The module stays
a public beta on the `0.x` line.

Requires **schema v1** and Go **1.25** or newer.

### Removed

- `AdminJobProgress` is gone. It was field-identical to `JobProgress`, which the worker's
  `HandlerContext` already returns, so `Admin.GetProgress` and `JobSnapshot.Progress` now return
  `*JobProgress`. A caller that named the type replaces the name; the fields are unchanged.
- `dashboard.HandlerOptions.SkipCompatibilityCheck` is gone. It existed for this repository's
  transport tests, whose executor cannot reach PostgreSQL, and those tests now use an unexported
  constructor. Every `dashboard.NewHandler` caller runs the schema compatibility check.
- `dashboard.DashboardJSON`, which this release had already renamed from `dashboard.JSON`, is gone
  entirely. `type DashboardJSON any` named nothing that `any` does not, so the generated bindings
  now spell an arbitrary JSON value `any` in `DashboardCompleteHumanWaitResult.Result`,
  `DashboardSignalTaskResult.Payload`, `SignalTaskInput.Payload`, and
  `CompleteHumanWaitInput.Result`. The field types are identical; only the spelling changed.
  Python keeps its `DashboardJSON`, which is a recursive union Go does not need.
- `dashboard.NormalizePath` is unexported. It had one caller, inside the package.

### Changed

- **`CheckCompatibility` takes the protocol versions the schema declares it serves.** Its signature
  is now `func(*int, int, []int) error`. The check refused any schema newer than the version this
  build was compiled against, which would have turned the first in-place migration into an outage
  for the length of a rolling deployment. A build cannot know which later release stops serving it,
  so the ceiling comes from the database: `workhorse.protocol_version` records the SQL protocol
  versions the installed schema still serves, and a client whose protocol is absent from that list
  refuses with `SchemaTooNew` below the oldest served version and `SchemaTooOld` above the newest.
  An empty declaration enforces nothing. `AssertSchemaCompatible` reads both facts in one statement,
  so its per-call check stays one round trip.
- **Shared names for three parts of the public API.** Go was the odd language out on each one, so
  each moved to the spelling TypeScript and Python already share. `AssertCompatible` is now
  `AssertSchemaCompatible`. `HandlerContext.CreateChild`, `CreateChildren`, and `CreateChildrenAll`
  are now `RunChild`, `RunChildren`, and `RunChildrenAll`. The three `EnqueueNonReplaceableReason`
  constants now carry the enum prefix every other constant group in the package carries:
  `IncompatibleKeyMode`, `NotPending`, and `WindowElapsedPending` are now
  `NonReplaceableIncompatibleKeyMode`, `NonReplaceableNotPending`, and
  `NonReplaceableWindowElapsed`. Every old name stays in the module as a deprecated alias with the
  same behaviour and the same value, so no caller changes on this release. The aliases are removed
  in `1.0.0`.
- **`dashboard` package type names.** Every type generated from a shared `dashboard/v1` wire type
  now carries the `Dashboard` prefix, so the package no longer declares a second `CancelStatus`,
  `SignalDeliveryStatus`, and `HumanWaitCompletionStatus` beside the ones the root package already
  exports. `CancelStatus`, `SendSignalStatus`, `CompleteHumanWaitStatus`, `JSON`,
  `QueueHealthReason`, `QueueHealthReasonCode`, `RetentionPolicyImpact`, and
  `MaintenanceLoopCadences` become `DashboardCancelStatus`, `DashboardSignalDeliveryStatus`,
  `DashboardHumanWaitCompletionStatus`, `DashboardJSON`, `DashboardQueueHealthReason`,
  `DashboardQueueHealthReasonCode`, `DashboardRetentionPolicyImpact`, and
  `DashboardMaintenanceLoopCadences`. The file is generated, so it carries no aliases: a caller
  that names one of the eight updates the name. No request or response payload changes.
- The three entries above and the removals are the exported API changes since `0.1.0-beta.1`. The
  README states the unpinned install command and the schema install step, which the TypeScript CLI
  owns.
- The dashboard backend's run-now action calls the audited `workhorse.run_task_now_v1` instead of
  `workhorse.dashboard_run_task_now_v1`, which is removed from the schema. The action now records
  the authenticated actor, the reason, and the request identity in its `promoted` event, matching
  the TypeScript dashboard server.
- **Dashboard timestamps.** Every timestamp a dashboard mutation returns is now UTC with exactly
  three fractional digits, matching the TypeScript and Python backends. It was `time.RFC3339Nano`,
  which dropped a trailing zero and passed through PostgreSQL's microseconds, so this module
  answered `2026-09-02T14:30:00Z` and `...:00.123456Z` where the other two answer
  `2026-09-02T14:30:00.000Z` and `...:00.123Z`. A client that compares or displays the string sees
  a different value; one that parses it does not.

### Added

- The `dashboard` package serves `redriveTask` and `redriveDeadLetters`, which the shared
  `dashboard/v1` contract added this release. Both reach `Admin.Redrive` and `Admin.RedriveMany`: a
  source the queue does not hold answers 404, and a bulk page reports every result plus the
  continuation cursor the next page resumes from. The host lists both as mutations, so a
  cross-origin or read-only request is refused before dispatch.

### Upgrade notes

- **`CheckCompatibility` callers.** The function takes a third argument, the protocol versions the
  installed schema declares it serves. `AssertSchemaCompatible` reads them for you; a caller that
  invokes `CheckCompatibility` directly passes the list it read, or `nil` to enforce no ceiling,
  which is what an empty declaration means.
- **Schema version.** `0.1.0` stays at schema version 1, but its baseline is not the one the last
  beta installed: `workhorse.valid_tags` was renamed `workhorse.valid_tags_v1` and
  `workhorse.dashboard_run_task_now_v1` was removed. A database installed by any beta reports
  version 1 and passes the compatibility check, yet holds the old function names. You must recreate the database and
  install the new baseline with
  `npx --package @stablemates/workhorse@0.1.0 workhorse schema install`.
  This is the last release that asks for a recreation: from `0.1.0` the schema is frozen as the
  migration baseline, and later releases upgrade a database in place.

## 0.1.0-beta.1 — 2026-09-01

Published through the Go module proxy from commit `dbd5437362930f712157ffcc72c3296e971e4f5a`,
tagged `go/v0.1.0-beta.1`.

### Changed

- The module uses the Apache License, Version 2.0 from the repository root.
  Contributions require the repository `CLA.md`.

### Added

- **The Go worker records what it is.** The schema baseline carries `client_protocol_version`,
  `sdk_language`, and `sdk_version` to `workhorse.worker_registry`, and every registration refresh
  reports `go` with the new exported `workhorse.Version` and the SQL protocol version it speaks.
  The dashboard shows them per worker, and `workhorse schema status --json` counts the live workers
  by protocol so an operator can see whether a protocol is still in use before retiring it. The
  columns are nullable and the older call is retained, so a worker running an earlier release keeps
  registering during a rolling deploy.
- `workhorse.Version` names this module's published version, which the module could not report
  before because it carries no manifest of its own.
- Queue, worker, and administrative APIs implement the Workhorse SQL protocol through pgx,
  `database/sql`, caller-owned transactions, and connection pools.
- The worker supports durable batches, timers, signals, human decisions, child jobs, progress,
  checkpoints, graceful drain, and recovery after a process crash.
- Individual handler panics become recorded attempt failures without stopping the worker. Compiled
  process and external-module coverage verifies graceful signal drain, crash recovery, and the
  public worker API under the race detector.
