package workhorse

const schemaVersionStatement = "schema_version"

var internalStatementRegistry = map[string]string{
	schemaVersionStatement: `SELECT version FROM workhorse.schema_version ORDER BY version`,
}

var protocolStatementRegistry = map[string]string{
	"enqueue_many_v2":              `SELECT ordinal, job_id, outcome, reason FROM workhorse.enqueue_many_v2($1::jsonb) ORDER BY ordinal`,
	"claim_v3":                     `SELECT * FROM workhorse.claim_v3($1::text, $2::text, $3::integer)`,
	"record_batch_dispatch_v1":     `SELECT workhorse.record_batch_dispatch_v1($1::uuid, $2::uuid[], $3::integer[], $4::bigint[], $5::text) AS recorded`,
	"record_batch_failure_v1":      `SELECT workhorse.record_batch_failure_v1($1::uuid, $2::uuid[], $3::integer[], $4::bigint[], $5::text) AS recorded`,
	"heartbeat_v2":                 `SELECT workhorse.heartbeat_v2($1::uuid, $2::text, $3::bigint, $4::integer) AS status`,
	"expire_owned_telemetry_v1":    `SELECT * FROM workhorse.expire_owned_telemetry_v1($1::uuid, $2::text, $3::bigint)`,
	"recover_expired_telemetry_v1": `SELECT * FROM workhorse.recover_expired_telemetry_v1($1::integer, $2::integer)`,
	"complete_v1":                  `SELECT workhorse.complete_v1($1::uuid, $2::text, $3::bigint, $4::jsonb) AS accepted`,
	"fail_v1":                      `SELECT workhorse.fail_v1($1::uuid, $2::text, $3::bigint, $4::jsonb, $5::integer) AS state`,
	"cancel_v1":                    `SELECT status, state, current_attempt, requested_at, requested_by, reason, finished_at FROM workhorse.cancel_v1($1::uuid, $2::text, $3::text)`,
	"acknowledge_cancel_v1":        `SELECT workhorse.acknowledge_cancel_v1($1::uuid, $2::text, $3::bigint) AS accepted`,
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
