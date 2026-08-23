package workhorse

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// MaxEnqueueBatchSize is PostgreSQL's atomic enqueue batch limit.
const MaxEnqueueBatchSize = 1000

// MaxJobDependencies is PostgreSQL's prerequisite fan-in limit for one job.
const MaxJobDependencies = 100

const (
	defaultJobValueMaxBytes = 1_048_576
	defaultMaxAttempts      = 25
	defaultIdempotencyTTLMS = 86_400_000
)

// ErrEnqueueBatchTooLarge reports a batch that exceeds MaxEnqueueBatchSize.
var ErrEnqueueBatchTooLarge = errors.New(enqueueBatchTooLargeMessage)

// ErrInvalidEnqueueResult reports a result set that violates the SQL protocol contract.
var ErrInvalidEnqueueResult = errors.New(invalidEnqueueResultMessage)

// ErrInvalidEnqueueOptions reports an option combination rejected before PostgreSQL is queried.
var ErrInvalidEnqueueOptions = errors.New(invalidEnqueueOptionsMessage)

// ErrInvalidScheduleDefinition reports a recurring definition rejected before PostgreSQL is queried.
var ErrInvalidScheduleDefinition = errors.New(invalidScheduleDefinitionMessage)

// EnqueueOutcome is PostgreSQL's durable disposition for one request.
type EnqueueOutcome string

const (
	EnqueueAccepted       EnqueueOutcome = enqueueAcceptedValue
	EnqueueReplayed       EnqueueOutcome = enqueueReplayedValue
	EnqueueReplaced       EnqueueOutcome = enqueueReplacedValue
	EnqueueNonReplaceable EnqueueOutcome = enqueueNonReplaceableValue
	EnqueueCoalesced      EnqueueOutcome = enqueueCoalescedValue
)

// EnqueueNonReplaceableReason explains why PostgreSQL retained a debounced job.
type EnqueueNonReplaceableReason string

const (
	IncompatibleKeyMode  EnqueueNonReplaceableReason = reasonIncompatibleKeyModeValue
	NotPending           EnqueueNonReplaceableReason = reasonNotPendingValue
	WindowElapsedPending EnqueueNonReplaceableReason = reasonWindowElapsedValue
)

// DebounceSchedule controls whether a replacement resets or preserves the original window.
type DebounceSchedule string

const (
	DebounceReset    DebounceSchedule = debounceResetValue
	DebouncePreserve DebounceSchedule = debouncePreserveValue
)

// DependencyTerminalPolicy controls what a dependent does after a prerequisite settles.
type DependencyTerminalPolicy string

const (
	DependencyRelease DependencyTerminalPolicy = dependencyReleaseValue
	DependencyCancel  DependencyTerminalPolicy = dependencyCancelValue
	DependencyFail    DependencyTerminalPolicy = dependencyFailValue
)

// Idempotency retains one canonical request under a scoped key.
type Idempotency struct {
	Key   string `json:"key"`
	Scope string `json:"scope"`
	TTLMS int    `json:"ttlMs"`
}

// Debounce replaces a pending keyed job during a PostgreSQL-owned window.
type Debounce struct {
	Key      string           `json:"key"`
	Scope    string           `json:"scope"`
	WindowMS int              `json:"windowMs"`
	Schedule DebounceSchedule `json:"schedule"`
}

// Throttle accepts at most one equivalent keyed job during a PostgreSQL-owned window.
type Throttle struct {
	Key      string `json:"key"`
	Scope    string `json:"scope"`
	WindowMS int    `json:"windowMs"`
}

// Dependencies declares prerequisite jobs and the terminal outcomes accepted from each.
type Dependencies struct {
	PrerequisiteJobIDs []string                 `json:"prerequisiteJobIds"`
	OnSuccess          DependencyTerminalPolicy `json:"onSuccess"`
	OnFailure          DependencyTerminalPolicy `json:"onFailure"`
	OnCancellation     DependencyTerminalPolicy `json:"onCancellation"`
}

// EnqueueOptions controls a job's initial dispatch and durable acceptance behavior.
// Zero values select PostgreSQL-compatible client defaults or omit optional values.
type EnqueueOptions struct {
	Queue              string
	Priority           int
	ConcurrencyKey     string
	RunAt              *time.Time
	Deadline           *time.Time
	ExecutionTimeoutMS int
	MaxAttempts        int
	RetryPolicy        map[string]any
	Tags               []string
	Idempotency        *Idempotency
	Debounce           *Debounce
	Throttle           *Throttle
	Dependencies       *Dependencies
}

// EnqueueRequest is one job submitted through an atomic enqueue batch.
type EnqueueRequest struct {
	Type    string
	Payload any
	Options EnqueueOptions
}

// ScheduledJob describes the job created for each recurring occurrence.
type ScheduledJob struct {
	Type           string
	Payload        any
	Queue          string
	Priority       int
	ConcurrencyKey string
	MaxAttempts    int
	RetryPolicy    map[string]any
}

// ScheduleDefinition is one desired recurring schedule.
// A nil Enabled value enables the definition by default.
type ScheduleDefinition struct {
	Name     string
	Schedule string
	Job      ScheduledJob
	Enabled  *bool
}

// SyncSchedulesOptions controls desired-state reconciliation.
type SyncSchedulesOptions struct {
	Prune bool
}

// EnqueueResult contains a job's stable identity and durable enqueue disposition.
type EnqueueResult struct {
	JobID   string
	Outcome EnqueueOutcome
	Reason  *EnqueueNonReplaceableReason
}

// Queue enqueues jobs through a caller-owned executor.
type Queue struct {
	executor     Executor
	defaultQueue string
}

// QueueHealth is PostgreSQL's versioned health document. Stable fields and reason codes are
// defined by queue_health_v1, so every language receives the same evaluation.
type QueueHealth map[string]any

// CancellationRequest supplies optional audit attribution.
// PostgreSQL does not treat it as authorization.
type CancellationRequest struct {
	RequestedBy *string
	Reason      *string
}

// CancelStatus is PostgreSQL's disposition for a cancellation request.
type CancelStatus string

const (
	CancelCanceled        CancelStatus = canceledValue
	CancelRequested       CancelStatus = cancelRequestedValue
	CancelAlreadyTerminal CancelStatus = alreadyTerminalValue
	CancelNotFound        CancelStatus = notFoundValue
)

// JobState is PostgreSQL's durable lifecycle state for a job.
type JobState string

const (
	JobBlocked   JobState = jobBlockedValue
	JobScheduled JobState = jobScheduledValue
	JobReady     JobState = jobReadyValue
	JobActive    JobState = jobActiveValue
	JobSucceeded JobState = jobSucceededValue
	JobFailed    JobState = jobFailedValue
	JobCanceled  JobState = jobCanceledValue
)

// CancelResult contains safe lifecycle metadata and omits payload and worker ownership.
type CancelResult struct {
	Status         CancelStatus
	JobID          string
	State          *JobState
	CurrentAttempt *int
	RequestedAt    *time.Time
	RequestedBy    *string
	Reason         *string
	FinishedAt     *time.Time
}

// NewQueue constructs an enqueue client without taking ownership of the executor.
func NewQueue(executor Executor, defaultQueue string) *Queue {
	return &Queue{executor: executor, defaultQueue: defaultQueue}
}

// Health reads PostgreSQL's database-authoritative queue health snapshot.
func (queue *Queue) Health(ctx context.Context) (QueueHealth, error) {
	if err := AssertCompatible(ctx, queue.executor); err != nil {
		return nil, err
	}
	rows, err := queue.executor.Query(
		ctx,
		protocolStatementRegistry[queueHealthStatementName],
		time.Now().UTC().Add(-24*time.Hour),
	)
	if err != nil {
		return nil, err
	}
	if len(rows) != 1 {
		return nil, fmt.Errorf(invalidHealthRowCountMessage, len(rows))
	}
	return decodeQueueHealth(rows[0][rowSnapshotField])
}

// Cancel requests cooperative cancellation with optional audit attribution.
func (queue *Queue) Cancel(
	ctx context.Context,
	jobID string,
	request CancellationRequest,
) (CancelResult, error) {
	if err := AssertCompatible(ctx, queue.executor); err != nil {
		return CancelResult{}, err
	}
	rows, err := queue.executor.Query(
		ctx,
		protocolStatementRegistry[cancelStatementName],
		jobID,
		optionalStringArgument(request.RequestedBy),
		optionalStringArgument(request.Reason),
	)
	if err != nil {
		return CancelResult{}, err
	}
	if len(rows) != 1 {
		return CancelResult{}, fmt.Errorf(invalidCancelRowCountMessage, len(rows))
	}
	return cancelResult(rows[0], jobID)
}

func cancelResult(row Row, jobID string) (CancelResult, error) {
	status, ok := row[rowStatusField].(string)
	if !ok {
		return CancelResult{}, errors.New(invalidCancelStatusMessage)
	}
	result := CancelResult{Status: CancelStatus(status), JobID: jobID}
	switch result.Status {
	case CancelCanceled, CancelRequested, CancelAlreadyTerminal, CancelNotFound:
	default:
		return CancelResult{}, fmt.Errorf(unknownCancelStatusFormat, status)
	}
	var valid bool
	if result.State, valid = optionalJobState(row[rowStateField]); !valid {
		return CancelResult{}, errors.New(invalidCancelStateMessage)
	}
	if result.CurrentAttempt, valid = optionalInteger(row[rowCurrentAttemptField]); !valid {
		return CancelResult{}, errors.New(invalidCancelAttemptMessage)
	}
	if result.RequestedAt, valid = optionalTime(row[rowRequestedAtField]); !valid {
		return CancelResult{}, errors.New(invalidCancelRequestedAtMessage)
	}
	if result.RequestedBy, valid = optionalString(row[rowRequestedByField]); !valid {
		return CancelResult{}, errors.New(invalidCancelAttributionMessage)
	}
	if result.Reason, valid = optionalString(row[rowReasonField]); !valid {
		return CancelResult{}, errors.New(invalidCancelReasonMessage)
	}
	if result.FinishedAt, valid = optionalTime(row[rowFinishedAtField]); !valid {
		return CancelResult{}, errors.New(invalidCancelFinishedAtMessage)
	}
	return result, nil
}

func optionalString(value any) (*string, bool) {
	if value == nil {
		return nil, true
	}
	result, ok := value.(string)
	return &result, ok
}

func optionalStringArgument(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func optionalJobState(value any) (*JobState, bool) {
	if value == nil {
		return nil, true
	}
	state, ok := value.(string)
	if !ok {
		return nil, false
	}
	result := JobState(state)
	switch result {
	case JobBlocked, JobScheduled, JobReady, JobActive, JobSucceeded, JobFailed, JobCanceled:
		return &result, true
	default:
		return nil, false
	}
}

func optionalInteger(value any) (*int, bool) {
	if value == nil {
		return nil, true
	}
	result, ok := integer(value)
	return &result, ok
}

func optionalTime(value any) (*time.Time, bool) {
	if value == nil {
		return nil, true
	}
	result, ok := value.(time.Time)
	return &result, ok
}

func decodeQueueHealth(value any) (QueueHealth, error) {
	if document, ok := value.(map[string]any); ok {
		return QueueHealth(document), nil
	}
	var encoded []byte
	switch value := value.(type) {
	case []byte:
		encoded = value
	case string:
		encoded = []byte(value)
	default:
		return nil, fmt.Errorf(invalidHealthJSONMessage, value)
	}
	var document QueueHealth
	if err := json.Unmarshal(encoded, &document); err != nil {
		return nil, fmt.Errorf(decodeHealthJSONMessage, err)
	}
	return document, nil
}

// Enqueue submits one job and returns its stable identifier.
func (queue *Queue) Enqueue(
	ctx context.Context,
	jobType string,
	payload any,
	options ...EnqueueOptions,
) (string, error) {
	result, err := queue.EnqueueWithResult(ctx, jobType, payload, options...)
	if err != nil {
		return emptyString, err
	}
	return result.JobID, nil
}

// EnqueueWithResult submits one job and returns PostgreSQL's canonical result.
func (queue *Queue) EnqueueWithResult(
	ctx context.Context,
	jobType string,
	payload any,
	options ...EnqueueOptions,
) (EnqueueResult, error) {
	if len(options) > 1 {
		return EnqueueResult{}, fmt.Errorf(tooManyEnqueueOptionsMessage, ErrInvalidEnqueueOptions)
	}
	request := EnqueueRequest{Type: jobType, Payload: payload}
	if len(options) == 1 {
		request.Options = options[0]
	}
	results, err := queue.EnqueueManyWithResults(ctx, []EnqueueRequest{request})
	if err != nil {
		return EnqueueResult{}, err
	}
	return results[0], nil
}

// EnqueueMany submits one atomic batch and returns the stable job identifiers in request order.
func (queue *Queue) EnqueueMany(ctx context.Context, requests []EnqueueRequest) ([]string, error) {
	results, err := queue.EnqueueManyWithResults(ctx, requests)
	if err != nil {
		return nil, err
	}
	jobIDs := make([]string, len(results))
	for index, result := range results {
		jobIDs[index] = result.JobID
	}
	return jobIDs, nil
}

// EnqueueManyWithResults submits one atomic batch and returns canonical results in request order.
func (queue *Queue) EnqueueManyWithResults(
	ctx context.Context,
	requests []EnqueueRequest,
) ([]EnqueueResult, error) {
	if len(requests) == 0 {
		return []EnqueueResult{}, nil
	}
	if len(requests) > MaxEnqueueBatchSize {
		return nil, ErrEnqueueBatchTooLarge
	}
	payload, err := serializeEnqueueRequests(requests, queue.defaultQueue, time.Now().UTC())
	if err != nil {
		return nil, err
	}
	if err := AssertCompatible(ctx, queue.executor); err != nil {
		return nil, err
	}
	rows, err := queue.executor.Query(ctx, protocolStatementRegistry[enqueueManyStatementName], payload)
	if err != nil {
		return nil, translateEnqueueError(err)
	}

	if len(rows) != len(requests) {
		return nil, ErrInvalidEnqueueResult
	}
	results := make([]EnqueueResult, len(requests))
	seen := make([]bool, len(requests))
	for _, row := range rows {
		ordinal, ok := integer(row[rowOrdinalField])
		if !ok || ordinal < 1 || ordinal > len(requests) || seen[ordinal-1] {
			return nil, ErrInvalidEnqueueResult
		}
		result, err := enqueueResult(row)
		if err != nil {
			return nil, err
		}
		results[ordinal-1] = result
		seen[ordinal-1] = true
	}
	return results, nil
}

// SyncSchedules atomically reconciles one namespace of recurring definitions.
// Omitted definitions are disabled unless options explicitly set Prune to false.
func (queue *Queue) SyncSchedules(
	ctx context.Context,
	namespace string,
	definitions []ScheduleDefinition,
	options ...SyncSchedulesOptions,
) error {
	if len(options) > 1 {
		return fmt.Errorf(tooManySyncSchedulesOptionsMessage, ErrInvalidScheduleDefinition)
	}
	prune := true
	if len(options) == 1 {
		prune = options[0].Prune
	}
	payload, err := serializeScheduleDefinitions(definitions, queue.defaultQueue)
	if err != nil {
		return err
	}
	if err := AssertCompatible(ctx, queue.executor); err != nil {
		return err
	}
	_, err = queue.executor.Query(
		ctx,
		internalStatementRegistry[syncScheduleDefinitionsStatementName],
		namespace,
		payload,
		prune,
	)
	return err
}

type scheduleInput struct {
	Name                 string   `json:"name"`
	Schedule             string   `json:"schedule"`
	Enabled              bool     `json:"enabled"`
	Queue                string   `json:"queue"`
	Priority             int      `json:"priority"`
	ConcurrencyKey       any      `json:"concurrencyKey"`
	Type                 string   `json:"type"`
	Payload              any      `json:"payload"`
	MaxAttempts          int      `json:"maxAttempts"`
	RetryPolicy          any      `json:"retryPolicy"`
	ContractVersion      any      `json:"contractVersion"`
	PayloadMaxBytes      int      `json:"payloadMaxBytes"`
	ResultMaxBytes       int      `json:"resultMaxBytes"`
	SensitivePayloadKeys []string `json:"sensitivePayloadKeys"`
	SensitiveResultKeys  []string `json:"sensitiveResultKeys"`
}

func serializeScheduleDefinitions(definitions []ScheduleDefinition, defaultQueue string) ([]byte, error) {
	input := make([]scheduleInput, len(definitions))
	for index, definition := range definitions {
		if definition.Job.Priority < 0 || definition.Job.Priority > 100 {
			return nil, fmt.Errorf(
				scheduleDefinitionErrorFormat,
				index+1,
				fmt.Errorf(priorityRangeMessage, ErrInvalidScheduleDefinition),
			)
		}
		queueName := definition.Job.Queue
		if queueName == emptyString {
			queueName = defaultQueue
		}
		maxAttempts := definition.Job.MaxAttempts
		if maxAttempts == 0 {
			maxAttempts = defaultMaxAttempts
		}
		enabled := true
		if definition.Enabled != nil {
			enabled = *definition.Enabled
		}
		input[index] = scheduleInput{
			Name: definition.Name, Schedule: definition.Schedule, Enabled: enabled,
			Queue: queueName, Priority: definition.Job.Priority,
			ConcurrencyKey: nilIfEmpty(definition.Job.ConcurrencyKey), Type: definition.Job.Type,
			Payload: definition.Job.Payload, MaxAttempts: maxAttempts,
			RetryPolicy: definition.Job.RetryPolicy, PayloadMaxBytes: defaultJobValueMaxBytes,
			ResultMaxBytes: defaultJobValueMaxBytes, SensitivePayloadKeys: []string{},
			SensitiveResultKeys: []string{},
		}
	}
	return json.Marshal(input)
}

type enqueueInput struct {
	Queue                string        `json:"queue"`
	Type                 string        `json:"type"`
	Payload              any           `json:"payload"`
	Priority             int           `json:"priority"`
	ContractVersion      any           `json:"contractVersion"`
	PayloadMaxBytes      int           `json:"payloadMaxBytes"`
	ResultMaxBytes       int           `json:"resultMaxBytes"`
	SensitivePayloadKeys []string      `json:"sensitivePayloadKeys"`
	SensitiveResultKeys  []string      `json:"sensitiveResultKeys"`
	RunAt                *string       `json:"runAt,omitempty"`
	Deadline             *string       `json:"deadline"`
	ConcurrencyKey       any           `json:"concurrencyKey"`
	ExecutionTimeoutMS   any           `json:"executionTimeoutMs"`
	MaxAttempts          int           `json:"maxAttempts"`
	RetryPolicy          any           `json:"retryPolicy"`
	PrerequisiteJobID    any           `json:"prerequisiteJobId"`
	Dependencies         *Dependencies `json:"dependencies"`
	Tags                 []string      `json:"tags"`
	Idempotency          *Idempotency  `json:"idempotency,omitempty"`
	Debounce             *Debounce     `json:"debounce,omitempty"`
	Throttle             *Throttle     `json:"throttle,omitempty"`
}

func serializeEnqueueRequests(requests []EnqueueRequest, defaultQueue string, now time.Time) ([]byte, error) {
	input := make([]enqueueInput, len(requests))
	for index, request := range requests {
		value, err := serializeEnqueueRequest(request, defaultQueue, now)
		if err != nil {
			return nil, fmt.Errorf(enqueueRequestErrorFormat, index+1, err)
		}
		input[index] = value
	}
	return json.Marshal(input)
}

func serializeEnqueueRequest(request EnqueueRequest, defaultQueue string, now time.Time) (enqueueInput, error) {
	options := request.Options
	if err := validateEnqueueOptions(options); err != nil {
		return enqueueInput{}, err
	}
	queueName := options.Queue
	if queueName == emptyString {
		queueName = defaultQueue
	}
	maxAttempts := options.MaxAttempts
	if maxAttempts == 0 {
		maxAttempts = defaultMaxAttempts
	}
	tags := append([]string{}, options.Tags...)
	value := enqueueInput{
		Queue:                queueName,
		Type:                 request.Type,
		Payload:              request.Payload,
		Priority:             options.Priority,
		PayloadMaxBytes:      defaultJobValueMaxBytes,
		ResultMaxBytes:       defaultJobValueMaxBytes,
		SensitivePayloadKeys: []string{},
		SensitiveResultKeys:  []string{},
		ConcurrencyKey:       nilIfEmpty(options.ConcurrencyKey),
		ExecutionTimeoutMS:   nilIfZero(options.ExecutionTimeoutMS),
		MaxAttempts:          maxAttempts,
		RetryPolicy:          options.RetryPolicy,
		Tags:                 tags,
	}
	if options.Deadline != nil {
		formatted := formatTimestamp(*options.Deadline)
		value.Deadline = &formatted
	}
	if options.Dependencies != nil {
		jobIDs := append([]string{}, options.Dependencies.PrerequisiteJobIDs...)
		slices.Sort(jobIDs)
		dependencies := *options.Dependencies
		dependencies.PrerequisiteJobIDs = jobIDs
		value.Dependencies = &dependencies
	}
	keyed := options.Idempotency != nil || options.Debounce != nil || options.Throttle != nil
	if options.RunAt != nil || !keyed {
		runAt := now
		if options.RunAt != nil {
			runAt = *options.RunAt
		}
		formatted := formatTimestamp(runAt)
		value.RunAt = &formatted
	}
	if options.Idempotency != nil {
		ttlMS := options.Idempotency.TTLMS
		if ttlMS == 0 {
			ttlMS = defaultIdempotencyTTLMS
		}
		idempotency := *options.Idempotency
		idempotency.Scope = defaultScope(idempotency.Scope)
		idempotency.TTLMS = ttlMS
		value.Idempotency = &idempotency
	}
	if options.Debounce != nil {
		debounce := *options.Debounce
		debounce.Scope = defaultScope(debounce.Scope)
		value.Debounce = &debounce
	}
	if options.Throttle != nil {
		throttle := *options.Throttle
		throttle.Scope = defaultScope(throttle.Scope)
		value.Throttle = &throttle
	}
	return value, nil
}

func validateEnqueueOptions(options EnqueueOptions) error {
	modes := 0
	for _, present := range []bool{options.Idempotency != nil, options.Debounce != nil, options.Throttle != nil} {
		if present {
			modes++
		}
	}
	if modes > 1 {
		return fmt.Errorf(keyedModesCombinedMessage, ErrInvalidEnqueueOptions)
	}
	if options.Priority < 0 || options.Priority > 100 {
		return fmt.Errorf(priorityRangeMessage, ErrInvalidEnqueueOptions)
	}
	if options.MaxAttempts < 0 {
		return fmt.Errorf(maxAttemptsMessage, ErrInvalidEnqueueOptions)
	}
	if options.Debounce != nil && options.RunAt != nil {
		return fmt.Errorf(debounceRunAtMessage, ErrInvalidEnqueueOptions)
	}
	if (options.Debounce != nil || options.Throttle != nil) && options.Dependencies != nil {
		return fmt.Errorf(keyedDependenciesMessage, ErrInvalidEnqueueOptions)
	}
	if options.Dependencies != nil {
		seen := make(map[string]struct{}, len(options.Dependencies.PrerequisiteJobIDs))
		for _, jobID := range options.Dependencies.PrerequisiteJobIDs {
			seen[jobID] = struct{}{}
		}
		if len(seen) == 0 || len(seen) != len(options.Dependencies.PrerequisiteJobIDs) {
			return fmt.Errorf(uniqueDependenciesMessage, ErrInvalidEnqueueOptions)
		}
		if len(seen) > MaxJobDependencies {
			return fmt.Errorf(dependencyCountMessage, ErrInvalidEnqueueOptions, MaxJobDependencies)
		}
	}
	return nil
}

func defaultScope(scope string) string {
	if scope == emptyString {
		return defaultScopeValue
	}
	return scope
}

func nilIfEmpty(value string) any {
	if value == emptyString {
		return nil
	}
	return value
}

func nilIfZero(value int) any {
	if value == 0 {
		return nil
	}
	return value
}

func formatTimestamp(value time.Time) string {
	return value.UTC().Truncate(time.Millisecond).Format(timestampLayout)
}

func enqueueResult(row Row) (EnqueueResult, error) {
	jobID, ok := uuidString(row[rowJobIDField])
	if !ok {
		return EnqueueResult{}, ErrInvalidEnqueueResult
	}
	outcome, ok := row[rowOutcomeField].(string)
	if !ok {
		return EnqueueResult{}, ErrInvalidEnqueueResult
	}
	result := EnqueueResult{JobID: jobID, Outcome: EnqueueOutcome(outcome)}
	switch result.Outcome {
	case EnqueueAccepted, EnqueueReplayed, EnqueueReplaced, EnqueueCoalesced:
		if row[rowReasonField] != nil {
			return EnqueueResult{}, ErrInvalidEnqueueResult
		}
	case EnqueueNonReplaceable:
		reason, ok := row[rowReasonField].(string)
		if !ok {
			return EnqueueResult{}, ErrInvalidEnqueueResult
		}
		value := EnqueueNonReplaceableReason(reason)
		if value != IncompatibleKeyMode && value != NotPending && value != WindowElapsedPending {
			return EnqueueResult{}, ErrInvalidEnqueueResult
		}
		result.Reason = &value
	default:
		return EnqueueResult{}, ErrInvalidEnqueueResult
	}
	return result, nil
}

func uuidString(value any) (string, bool) {
	switch value := value.(type) {
	case string:
		return value, value != emptyString
	case []byte:
		return string(value), len(value) > 0
	case [16]byte:
		encoded := make([]byte, 36)
		hex.Encode(encoded[0:8], value[0:4])
		encoded[8] = '-'
		hex.Encode(encoded[9:13], value[4:6])
		encoded[13] = '-'
		hex.Encode(encoded[14:18], value[6:8])
		encoded[18] = '-'
		hex.Encode(encoded[19:23], value[8:10])
		encoded[23] = '-'
		hex.Encode(encoded[24:36], value[10:16])
		return string(encoded), true
	case fmt.Stringer:
		result := value.String()
		return result, result != emptyString
	default:
		return emptyString, false
	}
}

// ErrEnqueueIdempotencyConflict matches materially different requests under one retained key.
var ErrEnqueueIdempotencyConflict = errors.New(idempotencyConflictMessage)

// ErrDependencyCycle matches a dependency graph rejected because it would become cyclic.
var ErrDependencyCycle = errors.New(dependencyCycleMessage)

// ErrDependencyLimitExceeded matches a dependency graph that exceeds a PostgreSQL limit.
var ErrDependencyLimitExceeded = errors.New(dependencyLimitExceededMessage)

type protocolError struct {
	message  string
	sentinel error
}

func (err protocolError) Error() string { return err.message }
func (err protocolError) Unwrap() error { return err.sentinel }

// EnqueueIdempotencyConflictDetails is PostgreSQL's retained-key conflict diagnosis.
type EnqueueIdempotencyConflictDetails struct {
	Scope                 string   `json:"scope"`
	KeyPreview            string   `json:"keyPreview"`
	KeyDigest             string   `json:"keyDigest"`
	KeyLength             int      `json:"keyLength"`
	ExistingJobID         string   `json:"existingJobId"`
	Ordinal               int      `json:"ordinal"`
	ConflictingFields     []string `json:"conflictingFields"`
	StoredRequestDigest   string   `json:"storedRequestDigest"`
	RejectedRequestDigest string   `json:"rejectedRequestDigest"`
}

// EnqueueIdempotencyConflictError contains PostgreSQL's structured conflict details.
type EnqueueIdempotencyConflictError struct {
	protocolError
	Details EnqueueIdempotencyConflictDetails
}

// DependencyCycleDetails is PostgreSQL's bounded description of a rejected cycle.
type DependencyCycleDetails struct {
	DependentJobID    string   `json:"dependentJobId"`
	PrerequisiteJobID string   `json:"prerequisiteJobId"`
	CycleJobIDs       []string `json:"cycleJobIds"`
	Truncated         bool     `json:"truncated"`
}

// DependencyCycleError contains PostgreSQL's structured cycle details.
type DependencyCycleError struct {
	protocolError
	Details DependencyCycleDetails
}

// DependencyLimit identifies the bounded graph dimension PostgreSQL rejected.
type DependencyLimit string

const (
	DependencyPrerequisites        DependencyLimit = dependencyLimitPrerequisites
	DependencyDependents           DependencyLimit = dependencyLimitDependents
	DependencyUnresolvedDependents DependencyLimit = dependencyLimitUnresolved
)

// DependencyLimitDetails is PostgreSQL's dependency limit diagnosis.
type DependencyLimitDetails struct {
	JobID string          `json:"jobId"`
	Limit DependencyLimit `json:"limit"`
	Max   int             `json:"max"`
}

// DependencyLimitExceededError contains PostgreSQL's structured limit details.
type DependencyLimitExceededError struct {
	protocolError
	Details DependencyLimitDetails
}

func translateEnqueueError(err error) error {
	var databaseError *pgconn.PgError
	if !errors.As(err, &databaseError) {
		return err
	}
	switch databaseError.Code {
	case idempotencyConflictSQLState:
		details := EnqueueIdempotencyConflictDetails{}
		_ = json.Unmarshal([]byte(databaseError.Detail), &details)
		return &EnqueueIdempotencyConflictError{
			protocolError: protocolError{idempotencyConflictMessage, ErrEnqueueIdempotencyConflict},
			Details:       details,
		}
	case dependencyCycleSQLState:
		details := DependencyCycleDetails{}
		_ = json.Unmarshal([]byte(databaseError.Detail), &details)
		return &DependencyCycleError{
			protocolError: protocolError{dependencyCycleMessage, ErrDependencyCycle},
			Details:       details,
		}
	case dependencyLimitExceededSQLState:
		details := DependencyLimitDetails{}
		_ = json.Unmarshal([]byte(databaseError.Detail), &details)
		return &DependencyLimitExceededError{
			protocolError: protocolError{dependencyLimitExceededMessage, ErrDependencyLimitExceeded},
			Details:       details,
		}
	default:
		return err
	}
}
