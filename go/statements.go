package workhorse

const schemaVersionStatement = "schema_version"

const (
	emptyString                          = ""
	enqueueManyStatementName             = "enqueue_many_v2"
	syncScheduleDefinitionsStatementName = "sync_schedule_definitions_v1"
	promoteStatementName                 = "promote_v1"
	claimStatementName                   = "claim_v3"
	heartbeatStatementName               = "heartbeat_v2"
	expireOwnedStatementName             = "expire_owned_telemetry_v1"
	recoverExpiredStatementName          = "recover_expired_telemetry_v1"
	completeStatementName                = "complete_v1"
	failStatementName                    = "fail_v1"
	acknowledgeCancelStatementName       = "acknowledge_cancel_v1"
	rowOrdinalField                      = "ordinal"
	rowJobIDField                        = "job_id"
	rowOutcomeField                      = "outcome"
	rowReasonField                       = "reason"
	rowAcceptedField                     = "accepted"
	rowStateField                        = "state"
	rowStatusField                       = "status"
	rowJobTypeField                      = "job_type"
	rowPriorityField                     = "priority"
	rowPayloadField                      = "payload"
	rowContractVersionField              = "contract_version"
	rowResultMaxBytesField               = "result_max_bytes"
	rowRedactErrorDetailsField           = "redact_error_details"
	rowTraceContextField                 = "trace_context"
	rowAttemptField                      = "attempt"
	rowMaxAttemptsField                  = "max_attempts"
	rowRetryPolicyField                  = "retry_policy"
	rowDeadlineAtField                   = "deadline_at"
	rowExecutionTimeoutMSField           = "execution_timeout_ms"
	rowAttemptTimeoutAtField             = "attempt_timeout_at"
	rowFenceTokenField                   = "fence_token"
	rowLeaseExpiresAtField               = "lease_expires_at"
	errorNameField                       = "name"
	errorMessageField                    = "message"

	enqueueAcceptedValue       = "accepted"
	enqueueReplayedValue       = "replayed"
	enqueueReplacedValue       = "replaced"
	enqueueNonReplaceableValue = "non_replaceable"
	enqueueCoalescedValue      = "coalesced"

	reasonIncompatibleKeyModeValue                 = "incompatible_key_mode"
	reasonNotPendingValue                          = "not_pending"
	reasonWindowElapsedValue                       = "window_elapsed_pending"
	debounceResetValue                             = "reset"
	debouncePreserveValue                          = "preserve"
	dependencyReleaseValue                         = "release"
	dependencyCancelValue                          = "cancel"
	dependencyFailValue                            = "fail"
	defaultScopeValue                              = "default"
	workerFailureReady                             = "ready"
	workerFailureScheduled                         = "scheduled"
	workerFailureFailed                            = "failed"
	workerFailureStale                             = "stale"
	workerFailureCancelRequested                   = "cancel_requested"
	workerFailureDeadline                          = "deadline_exceeded"
	workerFailureTimeout                           = "timeout_exceeded"
	workerOwnershipAccepted        ownershipStatus = "accepted"
	workerOwnershipCancelRequested ownershipStatus = "cancel_requested"
	workerOwnershipDeadline        ownershipStatus = "deadline_exceeded"
	workerOwnershipTimeout         ownershipStatus = "timeout_exceeded"
	workerOwnershipStale           ownershipStatus = "stale"
	workerOwnershipNotDue          ownershipStatus = "not_due"
	timestampLayout                                = "2006-01-02T15:04:05.000Z"
	defaultWorkerQueueValue                        = "default"
	defaultWorkerName                              = "go-worker"
	redactedHandlerErrorNameValue                  = "RedactedJobError"
	redactedHandlerErrorTextValue                  = "Job handler failed; details redacted"
	genericHandlerErrorName                        = "Error"

	enqueueBatchTooLargeMessage        = "enqueue batch exceeds the shared limit"
	invalidEnqueueResultMessage        = "PostgreSQL returned an invalid enqueue result"
	invalidEnqueueOptionsMessage       = "invalid enqueue options"
	tooManyEnqueueOptionsMessage       = "%w: enqueue accepts at most one EnqueueOptions value"
	tooManySyncSchedulesOptionsMessage = "%w: sync schedules accepts at most one SyncSchedulesOptions value"
	invalidScheduleDefinitionMessage   = "invalid schedule definition"
	scheduleDefinitionErrorFormat      = "schedule definition %d: %w"
	enqueueRequestErrorFormat          = "enqueue request %d: %w"
	keyedModesCombinedMessage          = "%w: cannot combine idempotency, debounce, or throttle"
	priorityRangeMessage               = "%w: priority must be between 0 and 100"
	maxAttemptsMessage                 = "%w: max attempts must be positive"
	debounceRunAtMessage               = "%w: debounced enqueue uses its PostgreSQL-owned window instead of run at"
	keyedDependenciesMessage           = "%w: cannot combine debounce or throttle with dependencies"
	uniqueDependenciesMessage          = "%w: dependencies must contain unique prerequisite job IDs"
	dependencyCountMessage             = "%w: dependencies accepts at most %d prerequisite job IDs"
	idempotencyConflictMessage         = "PostgreSQL rejected a materially different idempotent enqueue"
	dependencyCycleMessage             = "PostgreSQL rejected a cyclic job dependency"
	dependencyLimitExceededMessage     = "PostgreSQL rejected a job dependency limit"
	idempotencyConflictSQLState        = "P1001"
	dependencyCycleSQLState            = "P1003"
	dependencyLimitExceededSQLState    = "P1005"
	dependencyLimitPrerequisites       = "prerequisites"
	dependencyLimitDependents          = "dependents"
	dependencyLimitUnresolved          = "unresolved_dependents"
	staleLeaseMessage                  = "PostgreSQL rejected settlement under a stale lease"
	staleLeaseErrorFormat              = "%s for job %s"
	nilWorkerPoolMessage               = "worker pool must not be nil"
	workerQueueOptionsMessage          = "worker queue and queues cannot be configured together"
	workerQueuesMessage                = "worker queues must contain at least one non-empty queue name"
	workerConcurrencyRangeMessage      = "worker concurrency must be between 1 and %d"
	workerLeaseRangeMessage            = "worker lease duration must be a whole number of milliseconds between %s and %s"
	negativeWorkerPollMessage          = "worker poll interval must not be negative"
	workerHeartbeatRangeMessage        = "worker heartbeat interval must be a whole number of milliseconds greater than zero and shorter than the lease duration"
	workerMaintenanceRangeMessage      = "worker maintenance interval must be a positive whole number of milliseconds"
	workerShutdownGraceRangeMessage    = "worker shutdown grace period must be a positive whole number of milliseconds"
	leaseLostMessage                   = "job lease was lost"
	cancellationRequestedMessage       = "job cancellation was requested"
	deadlineExceededMessage            = "job deadline was exceeded"
	executionTimeoutMessage            = "job execution timeout was exceeded"
	jobLifecycleErrorFormat            = "%s for job %s"
	attemptLifecycleErrorFormat        = "%s for job %s attempt %d"
	invalidOwnershipResultMessage      = "PostgreSQL returned an invalid ownership result"
	unknownOwnershipStatusFormat       = "PostgreSQL returned unknown ownership status %s"
	invalidCancelAcknowledgeMessage    = "PostgreSQL returned an invalid cancellation acknowledgement"
	expirationNotDueMessage            = "PostgreSQL did not accept ownership expiration before the retry budget elapsed"
	emptyWorkerJobTypeMessage          = "worker job type must not be empty"
	nilWorkerHandlerMessage            = "worker handler must not be nil"
	invalidClaimResultMessage          = "PostgreSQL returned an invalid claim result"
	missingWorkerHandlerFormat         = "no handler registered for %s"
	invalidCompletionResultMessage     = "PostgreSQL returned an invalid completion result"
	invalidFailureResultMessage        = "PostgreSQL returned an invalid failure result"
	rejectedFailureStateFormat         = "PostgreSQL rejected failure settlement with state %s"
	workerIDFallbackFormat             = "%s-%d"
	workerIDFormat                     = "%s-%d-%s"
)

var internalStatementRegistry = map[string]string{
	schemaVersionStatement:               `SELECT version FROM workhorse.schema_version ORDER BY version`,
	syncScheduleDefinitionsStatementName: `SELECT workhorse.sync_schedule_definitions_v1($1::text, $2::jsonb, $3::boolean)`,
	promoteStatementName:                 `SELECT workhorse.promote_v1($1::integer) AS promoted`,
}

var protocolStatementRegistry = map[string]string{
	enqueueManyStatementName:       `SELECT ordinal, job_id, outcome, reason FROM workhorse.enqueue_many_v2($1::jsonb) ORDER BY ordinal`,
	claimStatementName:             `SELECT * FROM workhorse.claim_v3($1::text, $2::text, $3::integer)`,
	"record_batch_dispatch_v1":     `SELECT workhorse.record_batch_dispatch_v1($1::uuid, $2::uuid[], $3::integer[], $4::bigint[], $5::text) AS recorded`,
	"record_batch_failure_v1":      `SELECT workhorse.record_batch_failure_v1($1::uuid, $2::uuid[], $3::integer[], $4::bigint[], $5::text) AS recorded`,
	heartbeatStatementName:         `SELECT workhorse.heartbeat_v2($1::uuid, $2::text, $3::bigint, $4::integer) AS status`,
	expireOwnedStatementName:       `SELECT * FROM workhorse.expire_owned_telemetry_v1($1::uuid, $2::text, $3::bigint)`,
	recoverExpiredStatementName:    `SELECT * FROM workhorse.recover_expired_telemetry_v1($1::integer, $2::integer)`,
	completeStatementName:          `SELECT workhorse.complete_v1($1::uuid, $2::text, $3::bigint, $4::jsonb) AS accepted`,
	failStatementName:              `SELECT workhorse.fail_v1($1::uuid, $2::text, $3::bigint, $4::jsonb, $5::integer) AS state`,
	"cancel_v1":                    `SELECT status, state, current_attempt, requested_at, requested_by, reason, finished_at FROM workhorse.cancel_v1($1::uuid, $2::text, $3::text)`,
	acknowledgeCancelStatementName: `SELECT workhorse.acknowledge_cancel_v1($1::uuid, $2::text, $3::bigint) AS accepted`,
	"save_checkpoint_v1":           `SELECT status, checkpoint_value, attempt, fence_token::text, worker_id, created_at FROM workhorse.save_checkpoint_v1($1::uuid, $2::text, $3::bigint, $4::text, $5::jsonb)`,
	"update_progress_v1":           `SELECT status, progress_value, revision::text, attempt, fence_token::text, worker_id, created_at, updated_at, retry_after_ms::text FROM workhorse.update_progress_v1($1::uuid, $2::text, $3::bigint, $4::jsonb)`,
	"schedule_wait_v1":             `SELECT status, wait_name, mode, duration_ms::text, requested_wake_at, wake_at, attempt, fence_token::text, worker_id, created_at FROM workhorse.schedule_wait_v1($1::uuid, $2::text, $3::bigint, $4::text, $5::bigint, $6::timestamptz)`,
	"create_children_v1":           `SELECT status, children, results, result_bytes, result_limit_bytes FROM workhorse.create_children_v1($1::uuid, $2::text, $3::bigint, $4::jsonb)`,
	"create_child_v1":              `SELECT status, child_job_id, child_type, created_at, joined_at, result FROM workhorse.create_child_v1($1::uuid, $2::text, $3::bigint, $4::text, $5::jsonb)`,
	"wait_for_signal_v1":           `SELECT status, payload FROM workhorse.wait_for_signal_v1($1::uuid, $2::text, $3::bigint, $4::text, $5::bigint)`,
	"send_signal_v1":               `SELECT status, payload, delivered_at, delivered_by FROM workhorse.send_signal_v1($1::uuid, $2::text, $3::jsonb, $4::text, $5::text)`,
	"wait_for_human_v1":            `SELECT status, result FROM workhorse.wait_for_human_v1($1::uuid, $2::text, $3::bigint, $4::text, $5::jsonb, $6::bigint)`,
	"complete_human_wait_v1":       `SELECT status, result, completed_at, completed_by FROM workhorse.complete_human_wait_v1($1::uuid, $2::text, $3::jsonb, $4::text, $5::text)`,
	"dashboard_signal_wait_v1":     `SELECT job_id, queue_name, job_type, signal_name AS wait_name, attempt, created_at, deadline_at, created_at::text AS cursor_created_at FROM workhorse.dashboard_signal_wait_v1 WHERE ($2::timestamptz IS NULL OR (created_at, job_id, signal_name) > ($2::timestamptz, $3::uuid, $4::text)) ORDER BY created_at, job_id, signal_name LIMIT $1::integer`,
	"dashboard_human_wait_v1":      `SELECT job_id, queue_name, job_type, token_name AS wait_name, context, attempt, created_at, deadline_at, created_at::text AS cursor_created_at FROM workhorse.dashboard_human_wait_v1 WHERE ($2::timestamptz IS NULL OR (created_at, job_id, token_name) > ($2::timestamptz, $3::uuid, $4::text)) ORDER BY created_at, job_id, token_name LIMIT $1::integer`,
}
