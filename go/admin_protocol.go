package workhorse

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"
	"unicode/utf8"
)

const (
	MaxAdminPageSize     = 1000
	MaxAdminRequestBytes = 512
)

// AdminAudit attributes an administrative mutation and makes retries idempotent.
// PostgreSQL records this identity; it does not authorize it.
type AdminAudit struct {
	Actor     string
	Reason    string
	RequestID string
}

// Admin exposes operator reads and controls through a caller-owned executor.
type Admin struct{ executor Executor }

// NewAdmin constructs an operator client without taking ownership of the executor.
func NewAdmin(executor Executor) *Admin { return &Admin{executor: executor} }

// Health reads PostgreSQL's database-authoritative queue health snapshot.
func (admin *Admin) Health(ctx context.Context) (QueueHealth, error) {
	return NewQueue(admin.executor, "default").Health(ctx)
}

type AdminCursor struct {
	OccurredAt time.Time
	TaskID     string
	Kind       string
	RecordID   string
	Signature  string
}

type TaskListQuery struct {
	Queue             string
	Type              string
	States            []TaskState
	CreatedAfter      *time.Time
	CreatedBefore     *time.Time
	IncludePayload    bool
	PayloadMaxBytes   int
	PayloadRedactKeys []string
	Limit             int
	Cursor            *AdminCursor
}

type TaskListItem struct {
	ID                  string
	Queue               string
	Type                string
	ConcurrencyKey      *string
	Priority            int
	Tags                []string
	State               TaskState
	PrerequisiteTaskID  *string
	PrerequisiteTaskIDs []string
	BlockedReason       *string
	ParentTaskID        *string
	ChildTaskIDs        []string
	CurrentAttempt      int
	MaxAttempts         int
	RetryPolicy         map[string]any
	DeadlineAt          *time.Time
	ExecutionTimeoutMS  *int64
	RunAt               time.Time
	CancelRequestedAt   *time.Time
	CancelRequestedBy   *string
	CancelReason        *string
	CreatedAt           time.Time
	UpdatedAt           time.Time
	Payload             any
	PayloadStatus       string
	PayloadBytes        *int64
}

type TaskListPage struct {
	Items      []TaskListItem
	NextCursor *AdminCursor
}

type TaskSnapshot struct {
	TaskListItem
	ContractVersion *string
	FenceToken      int64
	Result          any
	Error           any
	Progress        *TaskProgress
}

type TaskTimelineQuery struct {
	Limit  int
	Cursor *AdminCursor
}

type TaskTimelineEntry struct {
	Kind       string
	RecordID   string
	Priority   int
	Attempt    *int
	EventType  *string
	Details    any
	FenceToken *int64
	WorkerID   *string
	Outcome    *string
	StartedAt  *time.Time
	ClaimedAt  *time.Time
	FinishedAt *time.Time
	Error      any
	OccurredAt time.Time
}

type TaskTimelinePage struct {
	Items      []TaskTimelineEntry
	NextCursor *AdminCursor
}

type DeadLetterFilter struct {
	Queue          string
	Type           string
	Tags           []string
	ErrorName      string
	FinishedAfter  *time.Time
	FinishedBefore *time.Time
}

type DeadLetterQuery struct {
	DeadLetterFilter
	Limit  int
	Cursor *AdminCursor
}

type DeadLetter struct {
	TaskID             string
	Queue              string
	Type               string
	ConcurrencyKey     *string
	Priority           int
	Payload            any
	Tags               []string
	CurrentAttempt     int
	MaxAttempts        int
	RetryPolicy        map[string]any
	DeadlineAt         *time.Time
	ExecutionTimeoutMS *int64
	Error              any
	FinishedAt         time.Time
	RedriveCount       int64
}

type DeadLetterPage struct {
	Items      []DeadLetter
	NextCursor *AdminCursor
}

type RedriveResult struct {
	Status       string
	SourceTaskID string
	TargetTaskID *string
	SourceState  *TaskState
	TargetState  *TaskState
	RequestedAt  *time.Time
}

type BulkRedriveOptions struct {
	Limit  int
	DryRun bool
	Cursor *AdminCursor
}

type BulkRedrivePage struct {
	Results    []RedriveResult
	NextCursor *AdminCursor
}

type TaskCheckpoint struct {
	TaskID     string
	Name       string
	Value      any
	Attempt    int
	FenceToken int64
	WorkerID   string
	CreatedAt  time.Time
}

type TaskWait struct {
	TaskID          string
	Name            string
	Mode            string
	DurationMS      *int64
	RequestedWakeAt *time.Time
	WakeAt          time.Time
	Attempt         int
	FenceToken      int64
	WorkerID        string
	CreatedAt       time.Time
}

type ExternalWaitQuery struct {
	Limit  int
	Cursor *AdminCursor
}

type ExternalWait struct {
	TaskID     string
	Queue      string
	TaskType   string
	Name       string
	Context    any
	Attempt    int
	CreatedAt  time.Time
	DeadlineAt *time.Time
}

type ExternalWaitPage struct {
	Items      []ExternalWait
	NextCursor *AdminCursor
}

type WorkerRegistryEntry struct {
	WorkerID        string
	InstanceID      string
	Hostname        string
	PID             int
	QueueNames      []string
	Queue           string
	Concurrency     int
	ActiveSlots     int
	Draining        bool
	Paused          bool
	PausedBy        *string
	Reason          *string
	PausedAt        *time.Time
	StartedAt       time.Time
	LastHeartbeatAt time.Time
}

type WorkerPauseResult struct {
	WorkerID    string
	Paused      bool
	RequestedAt time.Time
	RequestedBy string
	Reason      string
}

func validateAdminAudit(audit AdminAudit) error {
	actorLength := utf8.RuneCountInString(audit.Actor)
	if !utf8.ValidString(audit.Actor) || actorLength < 1 || actorLength > 200 {
		return errors.New("actor must contain between 1 and 200 characters")
	}
	reasonLength := utf8.RuneCountInString(audit.Reason)
	if !utf8.ValidString(audit.Reason) || reasonLength < 1 || reasonLength > 2000 {
		return errors.New("reason must contain between 1 and 2000 characters")
	}
	if len(audit.RequestID) < 1 || len(audit.RequestID) > MaxAdminRequestBytes || !utf8.ValidString(audit.RequestID) {
		return fmt.Errorf("request ID must contain between 1 and %d UTF-8 bytes", MaxAdminRequestBytes)
	}
	return nil
}

func (admin *Admin) query(ctx context.Context, statement string, arguments ...any) ([]Row, error) {
	if err := AssertSchemaCompatible(ctx, admin.executor); err != nil {
		return nil, err
	}
	return admin.executor.Query(ctx, statement, arguments...)
}

func adminLimit(value int) (int, error) {
	if value == 0 {
		return 100, nil
	}
	if value < 1 || value > MaxAdminPageSize {
		return 0, fmt.Errorf("limit must be between 1 and %d", MaxAdminPageSize)
	}
	return value, nil
}

func adminFilter(value any) ([]byte, error) { return json.Marshal(value) }

func deadLetterFilterValue(filter DeadLetterFilter) map[string]any {
	value := make(map[string]any)
	if filter.Queue != "" {
		value["queue"] = filter.Queue
	}
	if filter.Type != "" {
		value["type"] = filter.Type
	}
	if len(filter.Tags) > 0 {
		value["tags"] = filter.Tags
	}
	if filter.ErrorName != "" {
		value["errorName"] = filter.ErrorName
	}
	if filter.FinishedAfter != nil {
		value["finishedAfter"] = filter.FinishedAfter
	}
	if filter.FinishedBefore != nil {
		value["finishedBefore"] = filter.FinishedBefore
	}
	return value
}

func (admin *Admin) ListTasks(ctx context.Context, query TaskListQuery) (TaskListPage, error) {
	limit, err := adminLimit(query.Limit)
	if err != nil {
		return TaskListPage{}, err
	}
	filterValue := make(map[string]any)
	if query.Queue != "" {
		filterValue["queue"] = query.Queue
	}
	if query.Type != "" {
		filterValue["type"] = query.Type
	}
	if len(query.States) > 0 {
		filterValue["states"] = query.States
	}
	if query.CreatedAfter != nil {
		filterValue["createdAfter"] = query.CreatedAfter
	}
	if query.CreatedBefore != nil {
		filterValue["createdBefore"] = query.CreatedBefore
	}
	filter, err := adminFilter(filterValue)
	if err != nil {
		return TaskListPage{}, err
	}
	payloadMaxBytes := query.PayloadMaxBytes
	if payloadMaxBytes == 0 {
		payloadMaxBytes = 16_384
	}
	redactKeys := query.PayloadRedactKeys
	if redactKeys == nil {
		redactKeys = []string{}
	}
	projection, err := adminFilter(map[string]any{"include": query.IncludePayload, "maxBytes": payloadMaxBytes, "redactKeys": redactKeys})
	if err != nil {
		return TaskListPage{}, err
	}
	var created any
	var taskID, signature any
	if query.Cursor != nil {
		created, taskID, signature = query.Cursor.OccurredAt, query.Cursor.TaskID, query.Cursor.Signature
	}
	rows, err := admin.query(ctx, adminStatementRegistry["list_tasks"], filter, limit, created, taskID, signature, projection)
	if err != nil {
		return TaskListPage{}, err
	}
	page := TaskListPage{Items: make([]TaskListItem, 0, len(rows))}
	for _, row := range rows {
		item, mapErr := mapTaskListItem(row)
		if mapErr != nil {
			return TaskListPage{}, mapErr
		}
		page.Items = append(page.Items, item)
	}
	if len(rows) > 0 && boolValue(rows[len(rows)-1]["has_more"]) {
		row := rows[len(rows)-1]
		page.NextCursor = &AdminCursor{OccurredAt: timeValue(row["cursor_created_at"]), TaskID: stringValue(row["task_id"]), Signature: stringValue(row["cursor_signature"])}
	}
	return page, nil
}

func (admin *Admin) GetTask(ctx context.Context, id string) (*TaskSnapshot, error) {
	rows, err := admin.query(ctx, adminStatementRegistry["get_task"], id)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	if len(rows) != 1 {
		return nil, fmt.Errorf("get task returned %d rows", len(rows))
	}
	item, err := mapTaskListItem(rows[0])
	if err != nil {
		return nil, err
	}
	row := rows[0]
	result := &TaskSnapshot{TaskListItem: item, ContractVersion: optionalStringValue(row["contract_version"]), FenceToken: adminInt64Value(row["version"]), Result: jsonValue(row["result"]), Error: jsonValue(row["error"])}
	if row["progress_revision"] != nil {
		result.Progress = &TaskProgress{TaskID: id, Value: jsonValue(row["progress_value"]), Revision: adminInt64Value(row["progress_revision"]), Attempt: intValue(row["progress_attempt"]), FenceToken: adminInt64Value(row["progress_fence_token"]), WorkerID: stringValue(row["progress_worker_id"]), CreatedAt: timeValue(row["progress_created_at"]), UpdatedAt: timeValue(row["progress_updated_at"])}
	}
	return result, nil
}

func (admin *Admin) GetTaskTimeline(ctx context.Context, taskID string, query TaskTimelineQuery) (TaskTimelinePage, error) {
	limit, err := adminLimit(query.Limit)
	if err != nil {
		return TaskTimelinePage{}, err
	}
	var occurred, kind, record any
	if query.Cursor != nil {
		occurred, kind, record = query.Cursor.OccurredAt, query.Cursor.Kind, query.Cursor.RecordID
	}
	rows, err := admin.query(ctx, adminStatementRegistry["list_task_timeline"], taskID, limit, occurred, kind, record)
	if err != nil {
		return TaskTimelinePage{}, err
	}
	page := TaskTimelinePage{Items: make([]TaskTimelineEntry, 0, len(rows))}
	for _, row := range rows {
		page.Items = append(page.Items, TaskTimelineEntry{Kind: stringValue(row["kind"]), RecordID: stringValue(row["record_id"]), Priority: intValue(row["priority"]), Attempt: optionalIntValue(row["attempt"]), EventType: optionalStringValue(row["event_type"]), Details: jsonValue(row["details"]), FenceToken: optionalInt64Value(row["fence_token"]), WorkerID: optionalStringValue(row["worker_id"]), Outcome: optionalStringValue(row["outcome"]), StartedAt: optionalTimeValue(row["started_at"]), ClaimedAt: optionalTimeValue(row["claimed_at"]), FinishedAt: optionalTimeValue(row["finished_at"]), Error: jsonValue(row["error"]), OccurredAt: timeValue(row["occurred_at"])})
	}
	if len(rows) > 0 && boolValue(rows[len(rows)-1]["has_more"]) {
		row := rows[len(rows)-1]
		page.NextCursor = &AdminCursor{TaskID: taskID, OccurredAt: timeValue(row["cursor_occurred_at"]), Kind: stringValue(row["kind"]), RecordID: stringValue(row["record_id"])}
	}
	return page, nil
}

func (admin *Admin) ListDeadLetters(ctx context.Context, query DeadLetterQuery) (DeadLetterPage, error) {
	limit, err := adminLimit(query.Limit)
	if err != nil {
		return DeadLetterPage{}, err
	}
	filter, err := adminFilter(deadLetterFilterValue(query.DeadLetterFilter))
	if err != nil {
		return DeadLetterPage{}, err
	}
	var finished, taskID any
	if query.Cursor != nil {
		finished, taskID = query.Cursor.OccurredAt, query.Cursor.TaskID
	}
	rows, err := admin.query(ctx, adminStatementRegistry["list_dead_letters"], filter, limit, finished, taskID)
	if err != nil {
		return DeadLetterPage{}, err
	}
	page := DeadLetterPage{Items: make([]DeadLetter, 0, len(rows))}
	for _, row := range rows {
		page.Items = append(page.Items, DeadLetter{TaskID: stringValue(row["task_id"]), Queue: stringValue(row["queue_name"]), Type: stringValue(row["task_type"]), ConcurrencyKey: optionalStringValue(row["concurrency_key"]), Priority: intValue(row["priority"]), Payload: jsonValue(row["payload"]), Tags: stringValues(row["tags"]), CurrentAttempt: intValue(row["current_attempt"]), MaxAttempts: intValue(row["max_attempts"]), RetryPolicy: mapValue(row["retry_policy"]), DeadlineAt: optionalTimeValue(row["deadline_at"]), ExecutionTimeoutMS: optionalInt64Value(row["execution_timeout_ms"]), Error: jsonValue(row["error"]), FinishedAt: timeValue(row["finished_at"]), RedriveCount: adminInt64Value(row["redrive_count"])})
	}
	if len(rows) > 0 && boolValue(rows[len(rows)-1]["has_more"]) {
		row := rows[len(rows)-1]
		page.NextCursor = &AdminCursor{OccurredAt: timeValue(row["cursor_finished_at"]), TaskID: stringValue(row["task_id"])}
	}
	return page, nil
}

func (admin *Admin) Redrive(ctx context.Context, sourceTaskID string, audit AdminAudit) (RedriveResult, error) {
	if err := validateAdminAudit(audit); err != nil {
		return RedriveResult{}, err
	}
	rows, err := admin.query(ctx, adminStatementRegistry["redrive"], sourceTaskID, audit.Actor, audit.Reason, audit.RequestID)
	if err != nil {
		return RedriveResult{}, err
	}
	if len(rows) != 1 {
		return RedriveResult{}, fmt.Errorf("redrive returned %d rows", len(rows))
	}
	return mapRedrive(rows[0]), nil
}

func (admin *Admin) RedriveMany(ctx context.Context, filter DeadLetterFilter, audit AdminAudit, options BulkRedriveOptions) (BulkRedrivePage, error) {
	if err := validateAdminAudit(audit); err != nil {
		return BulkRedrivePage{}, err
	}
	limit, err := adminLimit(options.Limit)
	if err != nil {
		return BulkRedrivePage{}, err
	}
	encoded, err := adminFilter(deadLetterFilterValue(filter))
	if err != nil {
		return BulkRedrivePage{}, err
	}
	var finished, taskID any
	if options.Cursor != nil {
		finished, taskID = options.Cursor.OccurredAt, options.Cursor.TaskID
	}
	rows, err := admin.query(ctx, adminStatementRegistry["redrive_many"], encoded, limit, options.DryRun, audit.Actor, audit.Reason, audit.RequestID, finished, taskID)
	if err != nil {
		return BulkRedrivePage{}, err
	}
	page := BulkRedrivePage{Results: make([]RedriveResult, 0, len(rows))}
	for _, row := range rows {
		page.Results = append(page.Results, mapRedrive(row))
	}
	if len(rows) > 0 && boolValue(rows[len(rows)-1]["has_more"]) {
		row := rows[len(rows)-1]
		page.NextCursor = &AdminCursor{OccurredAt: timeValue(row["source_finished_at_cursor"]), TaskID: stringValue(row["source_task_id"])}
	}
	return page, nil
}

func (admin *Admin) GetCheckpoint(ctx context.Context, taskID, name string) (*TaskCheckpoint, error) {
	rows, err := admin.query(ctx, adminStatementRegistry["get_checkpoint"], taskID, name)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	value := mapCheckpoint(rows[0])
	return &value, nil
}
func (admin *Admin) ListCheckpoints(ctx context.Context, taskID string) ([]TaskCheckpoint, error) {
	rows, err := admin.query(ctx, adminStatementRegistry["list_checkpoints"], taskID)
	if err != nil {
		return nil, err
	}
	result := make([]TaskCheckpoint, 0, len(rows))
	for _, row := range rows {
		result = append(result, mapCheckpoint(row))
	}
	return result, nil
}
func (admin *Admin) GetProgress(ctx context.Context, taskID string) (*TaskProgress, error) {
	rows, err := admin.query(ctx, adminStatementRegistry["get_progress"], taskID)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	row := rows[0]
	return &TaskProgress{TaskID: stringValue(row["task_id"]), Value: jsonValue(row["progress_value"]), Revision: adminInt64Value(row["revision"]), Attempt: intValue(row["attempt"]), FenceToken: adminInt64Value(row["fence_token"]), WorkerID: stringValue(row["worker_id"]), CreatedAt: timeValue(row["created_at"]), UpdatedAt: timeValue(row["updated_at"])}, nil
}
func (admin *Admin) GetWait(ctx context.Context, taskID, name string) (*TaskWait, error) {
	rows, err := admin.query(ctx, adminStatementRegistry["get_wait"], taskID, name)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	value := mapWait(rows[0])
	return &value, nil
}
func (admin *Admin) ListWaits(ctx context.Context, taskID string) ([]TaskWait, error) {
	rows, err := admin.query(ctx, adminStatementRegistry["list_waits"], taskID)
	if err != nil {
		return nil, err
	}
	result := make([]TaskWait, 0, len(rows))
	for _, row := range rows {
		result = append(result, mapWait(row))
	}
	return result, nil
}

func (admin *Admin) ListSignalWaits(ctx context.Context, query ExternalWaitQuery) (ExternalWaitPage, error) {
	return admin.listExternalWaits(ctx, query, false)
}
func (admin *Admin) ListHumanWaits(ctx context.Context, query ExternalWaitQuery) (ExternalWaitPage, error) {
	return admin.listExternalWaits(ctx, query, true)
}
func (admin *Admin) listExternalWaits(ctx context.Context, query ExternalWaitQuery, human bool) (ExternalWaitPage, error) {
	limit, err := adminLimit(query.Limit)
	if err != nil {
		return ExternalWaitPage{}, err
	}
	statement := adminStatementRegistry["list_signal_waits"]
	if human {
		statement = adminStatementRegistry["list_human_waits"]
	}
	var created, taskID, name any
	if query.Cursor != nil {
		created, taskID, name = query.Cursor.OccurredAt, query.Cursor.TaskID, query.Cursor.RecordID
	}
	rows, err := admin.query(ctx, statement, limit+1, created, taskID, name)
	if err != nil {
		return ExternalWaitPage{}, err
	}
	page := ExternalWaitPage{Items: make([]ExternalWait, 0, min(len(rows), limit))}
	for _, row := range rows[:min(len(rows), limit)] {
		page.Items = append(page.Items, ExternalWait{TaskID: stringValue(row["task_id"]), Queue: stringValue(row["queue_name"]), TaskType: stringValue(row["task_type"]), Name: stringValue(row["wait_name"]), Context: jsonValue(row["context"]), Attempt: intValue(row["attempt"]), CreatedAt: timeValue(row["created_at"]), DeadlineAt: optionalTimeValue(row["deadline_at"])})
	}
	if len(rows) > limit {
		row := rows[limit-1]
		page.NextCursor = &AdminCursor{OccurredAt: timeValue(row["cursor_created_at"]), TaskID: stringValue(row["task_id"]), RecordID: stringValue(row["wait_name"])}
	}
	return page, nil
}

func (admin *Admin) PauseQueue(ctx context.Context, queue string, audit AdminAudit) error {
	return admin.queuePause(ctx, queue, true, audit)
}
func (admin *Admin) ResumeQueue(ctx context.Context, queue string, audit AdminAudit) error {
	return admin.queuePause(ctx, queue, false, audit)
}
func (admin *Admin) queuePause(ctx context.Context, queue string, paused bool, audit AdminAudit) error {
	if err := validateAdminAudit(audit); err != nil {
		return err
	}
	rows, err := admin.query(ctx, adminStatementRegistry["set_queue_paused"], queue, paused, audit.Actor, audit.Reason, audit.RequestID)
	if err != nil {
		return err
	}
	if len(rows) != 1 {
		return fmt.Errorf("set_queue_paused_v1 returned %d rows", len(rows))
	}
	return nil
}
func (admin *Admin) PurgeQueue(ctx context.Context, queue string, audit AdminAudit) (int, error) {
	if err := validateAdminAudit(audit); err != nil {
		return 0, err
	}
	rows, err := admin.query(ctx, adminStatementRegistry["purge_queue"], queue, audit.Actor, audit.Reason, audit.RequestID)
	if err != nil {
		return 0, err
	}
	if len(rows) != 1 {
		return 0, fmt.Errorf("purge_queue_v1 returned %d rows", len(rows))
	}
	return intValue(rows[0]["deleted_count"]), nil
}

func (admin *Admin) ListWorkers(ctx context.Context) ([]WorkerRegistryEntry, error) {
	rows, err := admin.query(ctx, adminStatementRegistry["list_workers"])
	if err != nil {
		return nil, err
	}
	result := make([]WorkerRegistryEntry, 0, len(rows))
	for _, row := range rows {
		result = append(result, WorkerRegistryEntry{WorkerID: stringValue(row["worker_id"]), InstanceID: stringValue(row["instance_id"]), Hostname: stringValue(row["hostname"]), PID: intValue(row["pid"]), QueueNames: stringValues(row["queue_names"]), Queue: stringValue(row["queue_name"]), Concurrency: intValue(row["concurrency"]), ActiveSlots: intValue(row["active_slots"]), Draining: boolValue(row["draining"]), Paused: boolValue(row["paused"]), PausedBy: optionalStringValue(row["paused_by"]), Reason: optionalStringValue(row["paused_reason"]), PausedAt: optionalTimeValue(row["paused_at"]), StartedAt: timeValue(row["started_at"]), LastHeartbeatAt: timeValue(row["last_heartbeat_at"])})
	}
	return result, nil
}
func (admin *Admin) SetWorkerPaused(ctx context.Context, workerID string, paused bool, audit AdminAudit) (*WorkerPauseResult, error) {
	if err := validateAdminAudit(audit); err != nil {
		return nil, err
	}
	rows, err := admin.query(ctx, adminStatementRegistry["set_worker_paused"], workerID, paused, audit.Actor, audit.Reason, audit.RequestID)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	row := rows[0]
	return &WorkerPauseResult{WorkerID: stringValue(row["worker_id"]), Paused: boolValue(row["paused"]), RequestedAt: timeValue(row["paused_at"]), RequestedBy: stringValue(row["paused_by"]), Reason: stringValue(row["paused_reason"])}, nil
}

func mapTaskListItem(row Row) (TaskListItem, error) {
	if row["id"] != nil && row["task_id"] == nil {
		row["task_id"] = row["id"]
	}
	return TaskListItem{ID: stringValue(row["task_id"]), Queue: stringValue(row["queue_name"]), Type: stringValue(row["task_type"]), ConcurrencyKey: optionalStringValue(row["concurrency_key"]), Priority: intValue(row["priority"]), Tags: stringValues(row["tags"]), State: TaskState(stringValue(row["state"])), PrerequisiteTaskID: optionalStringValue(row["prerequisite_task_id"]), PrerequisiteTaskIDs: stringValues(row["prerequisite_task_ids"]), BlockedReason: optionalStringValue(row["blocked_reason"]), ParentTaskID: optionalStringValue(row["parent_task_id"]), ChildTaskIDs: stringValues(row["child_task_ids"]), CurrentAttempt: intValue(row["current_attempt"]), MaxAttempts: intValue(row["max_attempts"]), RetryPolicy: mapValue(row["retry_policy"]), DeadlineAt: optionalTimeValue(row["deadline_at"]), ExecutionTimeoutMS: optionalInt64Value(row["execution_timeout_ms"]), RunAt: timeValue(row["run_at"]), CancelRequestedAt: optionalTimeValue(row["cancel_requested_at"]), CancelRequestedBy: optionalStringValue(row["cancel_requested_by"]), CancelReason: optionalStringValue(row["cancel_reason"]), CreatedAt: timeValue(row["created_at"]), UpdatedAt: timeValue(row["updated_at"]), Payload: jsonValue(row["payload"]), PayloadStatus: stringValue(row["payload_status"]), PayloadBytes: optionalInt64Value(row["payload_bytes"])}, nil
}
func mapRedrive(row Row) RedriveResult {
	source := optionalTaskStateValue(row["source_state"])
	target := optionalTaskStateValue(row["target_state"])
	return RedriveResult{Status: stringValue(row["status"]), SourceTaskID: stringValue(row["source_task_id"]), TargetTaskID: optionalStringValue(row["target_task_id"]), SourceState: source, TargetState: target, RequestedAt: optionalTimeValue(row["requested_at"])}
}
func mapCheckpoint(row Row) TaskCheckpoint {
	return TaskCheckpoint{TaskID: stringValue(row["task_id"]), Name: stringValue(row["checkpoint_name"]), Value: jsonValue(row["checkpoint_value"]), Attempt: intValue(row["attempt"]), FenceToken: adminInt64Value(row["fence_token"]), WorkerID: stringValue(row["worker_id"]), CreatedAt: timeValue(row["created_at"])}
}
func mapWait(row Row) TaskWait {
	return TaskWait{TaskID: stringValue(row["task_id"]), Name: stringValue(row["wait_name"]), Mode: stringValue(row["mode"]), DurationMS: optionalInt64Value(row["duration_ms"]), RequestedWakeAt: optionalTimeValue(row["requested_wake_at"]), WakeAt: timeValue(row["wake_at"]), Attempt: intValue(row["attempt"]), FenceToken: adminInt64Value(row["fence_token"]), WorkerID: stringValue(row["worker_id"]), CreatedAt: timeValue(row["created_at"])}
}
func stringValue(value any) string {
	if value == nil {
		return ""
	}
	switch v := value.(type) {
	case string:
		return v
	case []byte:
		return string(v)
	default:
		return fmt.Sprint(v)
	}
}
func optionalStringValue(value any) *string {
	if value == nil {
		return nil
	}
	v := stringValue(value)
	return &v
}
func intValue(value any) int { return int(adminInt64Value(value)) }
func adminInt64Value(value any) int64 {
	switch v := value.(type) {
	case int:
		return int64(v)
	case int16:
		return int64(v)
	case int32:
		return int64(v)
	case int64:
		return v
	case float64:
		return int64(v)
	case string:
		n, _ := strconv.ParseInt(v, 10, 64)
		return n
	case []byte:
		n, _ := strconv.ParseInt(string(v), 10, 64)
		return n
	}
	return 0
}
func optionalInt64Value(value any) *int64 {
	if value == nil {
		return nil
	}
	v := adminInt64Value(value)
	return &v
}
func optionalIntValue(value any) *int {
	if value == nil {
		return nil
	}
	v := intValue(value)
	return &v
}
func boolValue(value any) bool { v, _ := value.(bool); return v }
func timeValue(value any) time.Time {
	switch v := value.(type) {
	case time.Time:
		return v
	case string:
		t, _ := time.Parse(time.RFC3339Nano, v)
		return t
	case []byte:
		t, _ := time.Parse(time.RFC3339Nano, string(v))
		return t
	}
	return time.Time{}
}
func optionalTimeValue(value any) *time.Time {
	if value == nil {
		return nil
	}
	v := timeValue(value)
	return &v
}
func stringValues(value any) []string {
	switch v := value.(type) {
	case []string:
		return v
	case []any:
		r := make([]string, 0, len(v))
		for _, x := range v {
			r = append(r, stringValue(x))
		}
		return r
	case string:
		if len(v) > 1 && v[0] == '{' && v[len(v)-1] == '}' {
			if v == "{}" {
				return []string{}
			}
			return parsePostgresTextArray(v[1 : len(v)-1])
		}
	}
	return []string{}
}
func parsePostgresTextArray(value string) []string {
	result := make([]string, 0, 1)
	current := make([]byte, 0, len(value))
	quoted := false
	escaped := false
	for index := 0; index < len(value); index++ {
		character := value[index]
		if escaped {
			current = append(current, character)
			escaped = false
			continue
		}
		if character == '\\' {
			escaped = true
			continue
		}
		if character == '"' {
			quoted = !quoted
			continue
		}
		if character == ',' && !quoted {
			result = append(result, string(current))
			current = current[:0]
			continue
		}
		current = append(current, character)
	}
	if escaped {
		current = append(current, '\\')
	}
	return append(result, string(current))
}
func jsonValue(value any) any {
	switch v := value.(type) {
	case []byte:
		var out any
		if json.Unmarshal(v, &out) == nil {
			return out
		}
	case string:
		var out any
		if json.Unmarshal([]byte(v), &out) == nil {
			return out
		}
	}
	return value
}
func mapValue(value any) map[string]any { v, _ := jsonValue(value).(map[string]any); return v }
func optionalTaskStateValue(value any) *TaskState {
	if value == nil {
		return nil
	}
	v := TaskState(stringValue(value))
	return &v
}
