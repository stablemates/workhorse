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
	jsonschema "github.com/santhosh-tekuri/jsonschema/v6"
)

// MaxTaskDependencies is PostgreSQL's prerequisite fan-in limit for one task.
const MaxTaskDependencies = 100

const (
	defaultMaxAttempts      = 25
	defaultIdempotencyTTLMS = 86_400_000
)

// ErrEnqueueBatchTooLarge reports a batch that exceeds MaxEnqueueBatchSize.
var ErrEnqueueBatchTooLarge = errors.New(enqueueBatchTooLargeMessage)

// ErrInvalidEnqueueResult reports a result set that violates the SQL protocol contract.
var ErrInvalidEnqueueResult = errors.New(invalidEnqueueResultMessage)

// ErrContractPolicyChanged reports a batch whose contract policy changed again after the queue
// refreshed its cached contracts and retried once.
var ErrContractPolicyChanged = errors.New(contractPolicyChangedMessage)

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

// EnqueueNonReplaceableReason explains why PostgreSQL retained a debounced task.
type EnqueueNonReplaceableReason string

const (
	NonReplaceableIncompatibleKeyMode EnqueueNonReplaceableReason = reasonIncompatibleKeyModeValue
	NonReplaceableNotPending          EnqueueNonReplaceableReason = reasonNotPendingValue
	NonReplaceableWindowElapsed       EnqueueNonReplaceableReason = reasonWindowElapsedValue
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

// Debounce replaces a pending keyed task during a PostgreSQL-owned window.
type Debounce struct {
	Key      string           `json:"key"`
	Scope    string           `json:"scope"`
	WindowMS int              `json:"windowMs"`
	Schedule DebounceSchedule `json:"schedule"`
}

// Throttle accepts at most one equivalent keyed task during a PostgreSQL-owned window.
type Throttle struct {
	Key      string `json:"key"`
	Scope    string `json:"scope"`
	WindowMS int    `json:"windowMs"`
}

// Dependencies declares prerequisite tasks and the terminal outcomes accepted from each.
type Dependencies struct {
	PrerequisiteTaskIDs []string                 `json:"prerequisiteTaskIds"`
	OnSuccess           DependencyTerminalPolicy `json:"onSuccess"`
	OnFailure           DependencyTerminalPolicy `json:"onFailure"`
	OnCancellation      DependencyTerminalPolicy `json:"onCancellation"`
}

// EnqueueOptions controls a task's initial dispatch and durable acceptance behavior.
// Zero values select PostgreSQL-compatible client defaults or omit optional values.
type EnqueueOptions struct {
	Queue          string
	Priority       int
	ConcurrencyKey string
	// Budget names a deployment-synchronized budget shared across queues. Empty means none.
	Budget             string
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

// EnqueueRequest is one task submitted through an atomic enqueue batch.
type EnqueueRequest struct {
	Type    string
	Payload any
	Options EnqueueOptions
}

// ScheduledTask describes the task created for each recurring occurrence.
type ScheduledTask struct {
	Type           string
	Payload        any
	Queue          string
	Priority       int
	ConcurrencyKey string
	MaxAttempts    int
	RetryPolicy    map[string]any
}

// ScheduleCatchupPolicy controls occurrences missed between worker evaluations.
type ScheduleCatchupPolicy string

const (
	ScheduleCatchupSkip   ScheduleCatchupPolicy = scheduleCatchupSkipValue
	ScheduleCatchupLatest ScheduleCatchupPolicy = scheduleCatchupLatestValue
	ScheduleCatchupAll    ScheduleCatchupPolicy = scheduleCatchupAllValue
)

// ScheduleDefinition is one desired recurring schedule.
// A nil Enabled value enables the definition by default.
type ScheduleDefinition struct {
	Name          string
	Schedule      string
	Timezone      string
	CatchupPolicy ScheduleCatchupPolicy
	Task          ScheduledTask
	Enabled       *bool
}

// SyncSchedulesOptions controls desired-state reconciliation.
type SyncSchedulesOptions struct {
	Prune bool
}

// EnqueueResult contains a task's stable identity and durable enqueue disposition.
type EnqueueResult struct {
	TaskID  string
	Outcome EnqueueOutcome
	Reason  *EnqueueNonReplaceableReason
}

// Queue enqueues tasks through a caller-owned executor.
type Queue struct {
	executor      Executor
	defaultQueue  string
	compatibility *CachedCompatibilityCheck
	contracts     contractCache
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

// TaskState is PostgreSQL's durable lifecycle state for a task.
type TaskState string

const (
	TaskBlocked   TaskState = taskBlockedValue
	TaskScheduled TaskState = taskScheduledValue
	TaskReady     TaskState = taskReadyValue
	TaskActive    TaskState = taskActiveValue
	TaskSucceeded TaskState = taskSucceededValue
	TaskFailed    TaskState = taskFailedValue
	TaskCanceled  TaskState = taskCanceledValue
)

// CancelResult contains safe lifecycle metadata and omits payload and worker ownership.
type CancelResult struct {
	Status         CancelStatus
	TaskID         string
	State          *TaskState
	CurrentAttempt *int
	RequestedAt    *time.Time
	RequestedBy    *string
	Reason         *string
	FinishedAt     *time.Time
}

// NewQueue constructs an enqueue client without taking ownership of the executor.
func NewQueue(executor Executor, defaultQueue string) *Queue {
	return &Queue{
		executor:      executor,
		defaultQueue:  defaultQueue,
		compatibility: NewCachedCompatibilityCheck(executor),
		contracts:     newContractCache(),
	}
}

// Health reads PostgreSQL's database-authoritative queue health snapshot.
func (queue *Queue) Health(ctx context.Context) (QueueHealth, error) {
	if err := AssertSchemaCompatible(ctx, queue.executor); err != nil {
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
	taskID string,
	request CancellationRequest,
) (CancelResult, error) {
	if err := AssertSchemaCompatible(ctx, queue.executor); err != nil {
		return CancelResult{}, err
	}
	rows, err := queue.executor.Query(
		ctx,
		protocolStatementRegistry[cancelStatementName],
		taskID,
		optionalStringArgument(request.RequestedBy),
		optionalStringArgument(request.Reason),
	)
	if err != nil {
		return CancelResult{}, err
	}
	if len(rows) != 1 {
		return CancelResult{}, fmt.Errorf(invalidCancelRowCountMessage, len(rows))
	}
	return cancelResult(rows[0], taskID)
}

func cancelResult(row Row, taskID string) (CancelResult, error) {
	status, ok := row[rowStatusField].(string)
	if !ok {
		return CancelResult{}, errors.New(invalidCancelStatusMessage)
	}
	result := CancelResult{Status: CancelStatus(status), TaskID: taskID}
	switch result.Status {
	case CancelCanceled, CancelRequested, CancelAlreadyTerminal, CancelNotFound:
	default:
		return CancelResult{}, fmt.Errorf(unknownCancelStatusFormat, status)
	}
	var valid bool
	if result.State, valid = optionalTaskState(row[rowStateField]); !valid {
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

func optionalTaskState(value any) (*TaskState, bool) {
	if value == nil {
		return nil, true
	}
	state, ok := value.(string)
	if !ok {
		return nil, false
	}
	result := TaskState(state)
	switch result {
	case TaskBlocked, TaskScheduled, TaskReady, TaskActive, TaskSucceeded, TaskFailed, TaskCanceled:
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

// Enqueue submits one task and returns its stable identifier.
func (queue *Queue) Enqueue(
	ctx context.Context,
	taskType string,
	payload any,
	options ...EnqueueOptions,
) (string, error) {
	result, err := queue.EnqueueWithResult(ctx, taskType, payload, options...)
	if err != nil {
		return emptyString, err
	}
	return result.TaskID, nil
}

// EnqueueWithResult submits one task and returns PostgreSQL's canonical result.
func (queue *Queue) EnqueueWithResult(
	ctx context.Context,
	taskType string,
	payload any,
	options ...EnqueueOptions,
) (EnqueueResult, error) {
	if len(options) > 1 {
		return EnqueueResult{}, fmt.Errorf(tooManyEnqueueOptionsMessage, ErrInvalidEnqueueOptions)
	}
	request := EnqueueRequest{Type: taskType, Payload: payload}
	if len(options) == 1 {
		request.Options = options[0]
	}
	results, err := queue.EnqueueManyWithResults(ctx, []EnqueueRequest{request})
	if err != nil {
		return EnqueueResult{}, err
	}
	return results[0], nil
}

// EnqueueMany submits one atomic batch and returns the stable task identifiers in request order.
func (queue *Queue) EnqueueMany(ctx context.Context, requests []EnqueueRequest) ([]string, error) {
	results, err := queue.EnqueueManyWithResults(ctx, requests)
	if err != nil {
		return nil, err
	}
	taskIDs := make([]string, len(results))
	for index, result := range results {
		taskIDs[index] = result.TaskID
	}
	return taskIDs, nil
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
	for attempt := 0; ; attempt++ {
		rows, err := queue.enqueueAttempt(ctx, requests)
		if err != nil {
			return nil, err
		}
		taskTypes, mismatched, err := contractMismatch(rows)
		if err != nil {
			return nil, err
		}
		if !mismatched {
			return enqueueResults(rows, len(requests))
		}
		if err := queue.refreshPayloadContracts(ctx, taskTypes); err != nil {
			return nil, err
		}
		if attempt > 0 {
			return nil, ErrContractPolicyChanged
		}
	}
}

// enqueueAttempt serializes the batch against the cached contracts and runs enqueue_many_v1.
func (queue *Queue) enqueueAttempt(ctx context.Context, requests []EnqueueRequest) ([]Row, error) {
	inputs, err := serializeEnqueueRequests(
		requests,
		queue.defaultQueue,
		time.Now().UTC(),
		injectTraceContext(ctx),
	)
	if err != nil {
		return nil, err
	}
	if err := queue.compatibility.Assert(ctx); err != nil {
		return nil, err
	}
	if err := queue.applyPayloadContracts(ctx, inputs); err != nil {
		return nil, err
	}
	payload, err := json.Marshal(inputs)
	if err != nil {
		return nil, err
	}
	rows, err := queue.executor.Query(ctx, protocolStatementRegistry[enqueueManyStatementName], payload)
	if err != nil {
		return nil, translateEnqueueError(err)
	}
	return rows, nil
}

// contractMismatch reports the task types PostgreSQL names when a batch carried a stale contract.
func contractMismatch(rows []Row) ([]string, bool, error) {
	for _, row := range rows {
		if row[rowOutcomeField] != contractMismatchOutcome {
			continue
		}
		reason, _ := row[rowReasonField].(string)
		var detail struct {
			TaskTypes []string `json:"taskTypes"`
		}
		if err := json.Unmarshal([]byte(reason), &detail); err != nil || detail.TaskTypes == nil {
			return nil, true, ErrInvalidEnqueueResult
		}
		return detail.TaskTypes, true, nil
	}
	return nil, false, nil
}

// enqueueResults places canonical results in request order.
func enqueueResults(rows []Row, requestCount int) ([]EnqueueResult, error) {
	if len(rows) != requestCount {
		return nil, ErrInvalidEnqueueResult
	}
	results := make([]EnqueueResult, requestCount)
	seen := make([]bool, requestCount)
	for _, row := range rows {
		ordinal, ok := integer(row[rowOrdinalField])
		if !ok || ordinal < 1 || ordinal > requestCount || seen[ordinal-1] {
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

// applyPayloadContracts validates each contracted payload and stamps the batch with the
// contract fields PostgreSQL enforces. Each task type is looked up once for the queue's lifetime;
// refreshPayloadContracts replaces an entry PostgreSQL reports as stale. Before SyncContracts,
// only types PostgreSQL has reported are stamped.
func (queue *Queue) applyPayloadContracts(ctx context.Context, inputs []enqueueInput) error {
	for index := range inputs {
		input := &inputs[index]
		queue.contracts.mu.RLock()
		contract, known := queue.contracts.definitions[input.Type]
		contractsEnabled := queue.contracts.enabled
		queue.contracts.mu.RUnlock()
		if !known {
			if !contractsEnabled {
				continue
			}
			loaded, err := queue.loadPayloadContract(ctx, input.Type)
			if err != nil {
				return err
			}
			contract = loaded
			queue.contracts.mu.Lock()
			queue.contracts.definitions[input.Type] = contract
			queue.contracts.mu.Unlock()
		}
		if contract == nil {
			continue
		}
		encoded, err := json.Marshal(input.Payload)
		if err != nil {
			return err
		}
		var payload any
		if err := decodeContractJSON(encoded, &payload); err != nil {
			return err
		}
		if err := contract.validator.Validate(payload); err != nil {
			return &TaskContractValidationError{
				TaskType: input.Type,
				Version:  contract.version,
				Kind:     contractPayloadKind,
			}
		}
		input.ContractVersion = contract.version
		input.PayloadMaxBytes = contract.payloadMaxBytes
		input.ResultMaxBytes = contract.resultMaxBytes
		input.SensitivePayloadKeys = contract.sensitivePayloadKeys
		input.SensitiveResultKeys = contract.sensitiveResultKeys
	}
	return nil
}

// refreshPayloadContracts reloads the current contract of each task type PostgreSQL reported.
func (queue *Queue) refreshPayloadContracts(ctx context.Context, taskTypes []string) error {
	for _, taskType := range taskTypes {
		contract, err := queue.loadPayloadContract(ctx, taskType)
		if err != nil {
			return err
		}
		queue.contracts.mu.Lock()
		queue.contracts.definitions[taskType] = contract
		queue.contracts.mu.Unlock()
	}
	return nil
}

type payloadContract struct {
	version              string
	validator            *jsonschema.Schema
	payloadMaxBytes      any
	resultMaxBytes       any
	sensitivePayloadKeys any
	sensitiveResultKeys  any
}

// loadPayloadContract returns the current contract for a task type, or nil when the type has none.
func (queue *Queue) loadPayloadContract(ctx context.Context, taskType string) (*payloadContract, error) {
	rows, err := queue.executor.Query(
		ctx,
		protocolStatementRegistry[getContractDefinitionStatementName],
		taskType,
		nil,
	)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	if len(rows) != 1 {
		return nil, errorsNewInvalidContract()
	}
	row := rows[0]
	version, ok := row[contractVersionField].(string)
	if !ok {
		return nil, errorsNewInvalidContract()
	}
	document, err := contractDocument(row[contractSchemaField])
	if err != nil {
		return nil, err
	}
	validator, err := queue.contracts.validator(
		taskType+contractCacheSeparator+version+contractCacheSeparator+contractPayloadKind,
		document[contractPayloadSchemaField],
	)
	if err != nil {
		return nil, err
	}
	return &payloadContract{
		version:              version,
		validator:            validator,
		payloadMaxBytes:      row[rowPayloadMaxBytesField],
		resultMaxBytes:       row[rowResultMaxBytesField],
		sensitivePayloadKeys: row[rowPayloadRedactKeysField],
		sensitiveResultKeys:  row[rowResultRedactKeysField],
	}, nil
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
	if err := AssertSchemaCompatible(ctx, queue.executor); err != nil {
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
	Timezone             string   `json:"timezone"`
	CatchupPolicy        string   `json:"catchupPolicy"`
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
		if definition.Task.Priority < 0 || definition.Task.Priority > 100 {
			return nil, fmt.Errorf(
				scheduleDefinitionErrorFormat,
				index+1,
				fmt.Errorf(priorityRangeMessage, ErrInvalidScheduleDefinition),
			)
		}
		queueName := definition.Task.Queue
		if queueName == emptyString {
			queueName = defaultQueue
		}
		maxAttempts := definition.Task.MaxAttempts
		if maxAttempts == 0 {
			maxAttempts = defaultMaxAttempts
		}
		enabled := true
		if definition.Enabled != nil {
			enabled = *definition.Enabled
		}
		timezone := definition.Timezone
		if timezone == emptyString {
			timezone = defaultScheduleTimezone
		}
		catchupPolicy := definition.CatchupPolicy
		if catchupPolicy == ScheduleCatchupPolicy(emptyString) {
			catchupPolicy = ScheduleCatchupSkip
		}
		if catchupPolicy != ScheduleCatchupSkip && catchupPolicy != ScheduleCatchupLatest && catchupPolicy != ScheduleCatchupAll {
			return nil, fmt.Errorf(scheduleDefinitionErrorFormat, index+1, ErrInvalidScheduleDefinition)
		}
		input[index] = scheduleInput{
			Name: definition.Name, Schedule: definition.Schedule, Timezone: timezone,
			CatchupPolicy: string(catchupPolicy), Enabled: enabled,
			Queue: queueName, Priority: definition.Task.Priority,
			ConcurrencyKey: nilIfEmpty(definition.Task.ConcurrencyKey), Type: definition.Task.Type,
			Payload: definition.Task.Payload, MaxAttempts: maxAttempts,
			RetryPolicy: definition.Task.RetryPolicy, PayloadMaxBytes: defaultTaskValueMaxBytes,
			ResultMaxBytes: defaultTaskValueMaxBytes, SensitivePayloadKeys: []string{},
			SensitiveResultKeys: []string{},
		}
	}
	return json.Marshal(input)
}

type enqueueInput struct {
	Queue                string            `json:"queue"`
	Type                 string            `json:"type"`
	Payload              any               `json:"payload"`
	Priority             int               `json:"priority"`
	ContractVersion      any               `json:"contractVersion"`
	PayloadMaxBytes      any               `json:"payloadMaxBytes"`
	ResultMaxBytes       any               `json:"resultMaxBytes"`
	SensitivePayloadKeys any               `json:"sensitivePayloadKeys"`
	SensitiveResultKeys  any               `json:"sensitiveResultKeys"`
	RunAt                *string           `json:"runAt,omitempty"`
	Deadline             *string           `json:"deadline"`
	ConcurrencyKey       any               `json:"concurrencyKey"`
	Budget               any               `json:"budget"`
	ExecutionTimeoutMS   any               `json:"executionTimeoutMs"`
	MaxAttempts          int               `json:"maxAttempts"`
	RetryPolicy          any               `json:"retryPolicy"`
	PrerequisiteTaskID   any               `json:"prerequisiteTaskId"`
	Dependencies         *Dependencies     `json:"dependencies"`
	Tags                 []string          `json:"tags"`
	Idempotency          *Idempotency      `json:"idempotency,omitempty"`
	Debounce             *Debounce         `json:"debounce,omitempty"`
	Throttle             *Throttle         `json:"throttle,omitempty"`
	TraceContext         map[string]string `json:"traceContext,omitempty"`
}

func serializeEnqueueRequests(
	requests []EnqueueRequest,
	defaultQueue string,
	now time.Time,
	traceContext map[string]string,
) ([]enqueueInput, error) {
	input := make([]enqueueInput, len(requests))
	for index, request := range requests {
		value, err := serializeEnqueueRequest(request, defaultQueue, now)
		if err != nil {
			return nil, fmt.Errorf(enqueueRequestErrorFormat, index+1, err)
		}
		input[index] = value
		input[index].TraceContext = traceContext
	}
	return input, nil
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
		PayloadMaxBytes:      defaultTaskValueMaxBytes,
		ResultMaxBytes:       defaultTaskValueMaxBytes,
		SensitivePayloadKeys: []string{},
		SensitiveResultKeys:  []string{},
		ConcurrencyKey:       nilIfEmpty(options.ConcurrencyKey),
		Budget:               nilIfEmpty(options.Budget),
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
		taskIDs := append([]string{}, options.Dependencies.PrerequisiteTaskIDs...)
		slices.Sort(taskIDs)
		dependencies := *options.Dependencies
		dependencies.PrerequisiteTaskIDs = taskIDs
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
		seen := make(map[string]struct{}, len(options.Dependencies.PrerequisiteTaskIDs))
		for _, taskID := range options.Dependencies.PrerequisiteTaskIDs {
			seen[taskID] = struct{}{}
		}
		if len(seen) == 0 || len(seen) != len(options.Dependencies.PrerequisiteTaskIDs) {
			return fmt.Errorf(uniqueDependenciesMessage, ErrInvalidEnqueueOptions)
		}
		if len(seen) > MaxTaskDependencies {
			return fmt.Errorf(dependencyCountMessage, ErrInvalidEnqueueOptions, MaxTaskDependencies)
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
	taskID, ok := uuidString(row[rowTaskIDField])
	if !ok {
		return EnqueueResult{}, ErrInvalidEnqueueResult
	}
	outcome, ok := row[rowOutcomeField].(string)
	if !ok {
		return EnqueueResult{}, ErrInvalidEnqueueResult
	}
	result := EnqueueResult{TaskID: taskID, Outcome: EnqueueOutcome(outcome)}
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
		if value != NonReplaceableIncompatibleKeyMode &&
			value != NonReplaceableNotPending &&
			value != NonReplaceableWindowElapsed {
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
	ExistingTaskID        string   `json:"existingTaskId"`
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
	DependentTaskID    string   `json:"dependentTaskId"`
	PrerequisiteTaskID string   `json:"prerequisiteTaskId"`
	CycleTaskIDs       []string `json:"cycleTaskIds"`
	Truncated          bool     `json:"truncated"`
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
	TaskID string          `json:"taskId"`
	Limit  DependencyLimit `json:"limit"`
	Max    int             `json:"max"`
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
