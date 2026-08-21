package workhorse

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// MaxEnqueueBatchSize is PostgreSQL's atomic enqueue batch limit.
const MaxEnqueueBatchSize = 1000

const (
	defaultJobValueMaxBytes = 1_048_576
	defaultMaxAttempts      = 25
)

// ErrEnqueueBatchTooLarge reports a batch that exceeds MaxEnqueueBatchSize.
var ErrEnqueueBatchTooLarge = errors.New(enqueueBatchTooLargeMessage)

// ErrInvalidEnqueueResult reports a result set that violates the SQL protocol contract.
var ErrInvalidEnqueueResult = errors.New(invalidEnqueueResultMessage)

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

// EnqueueRequest is one job submitted through an atomic enqueue batch.
type EnqueueRequest struct {
	Type    string
	Payload any
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

// NewQueue constructs an enqueue client without taking ownership of the executor.
func NewQueue(executor Executor, defaultQueue string) *Queue {
	return &Queue{executor: executor, defaultQueue: defaultQueue}
}

// Enqueue submits one job and returns its stable identifier.
func (queue *Queue) Enqueue(ctx context.Context, jobType string, payload any) (string, error) {
	result, err := queue.EnqueueWithResult(ctx, jobType, payload)
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
) (EnqueueResult, error) {
	results, err := queue.EnqueueManyWithResults(ctx, []EnqueueRequest{{Type: jobType, Payload: payload}})
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
	if err := AssertCompatible(ctx, queue.executor); err != nil {
		return nil, err
	}

	type enqueueInput struct {
		Queue                string   `json:"queue"`
		Type                 string   `json:"type"`
		Payload              any      `json:"payload"`
		Priority             int      `json:"priority"`
		ContractVersion      any      `json:"contractVersion"`
		PayloadMaxBytes      int      `json:"payloadMaxBytes"`
		ResultMaxBytes       int      `json:"resultMaxBytes"`
		SensitivePayloadKeys []string `json:"sensitivePayloadKeys"`
		SensitiveResultKeys  []string `json:"sensitiveResultKeys"`
		RunAt                string   `json:"runAt"`
		Deadline             any      `json:"deadline"`
		ConcurrencyKey       any      `json:"concurrencyKey"`
		ExecutionTimeoutMS   any      `json:"executionTimeoutMs"`
		MaxAttempts          int      `json:"maxAttempts"`
		RetryPolicy          any      `json:"retryPolicy"`
		PrerequisiteJobID    any      `json:"prerequisiteJobId"`
		Dependencies         any      `json:"dependencies"`
		Tags                 []string `json:"tags"`
	}
	input := make([]enqueueInput, len(requests))
	for index, request := range requests {
		input[index] = enqueueInput{
			Queue:                queue.defaultQueue,
			Type:                 request.Type,
			Payload:              request.Payload,
			PayloadMaxBytes:      defaultJobValueMaxBytes,
			ResultMaxBytes:       defaultJobValueMaxBytes,
			SensitivePayloadKeys: []string{},
			SensitiveResultKeys:  []string{},
			RunAt:                time.Now().UTC().Format(time.RFC3339Nano),
			MaxAttempts:          defaultMaxAttempts,
			Tags:                 []string{},
		}
	}
	payload, err := json.Marshal(input)
	if err != nil {
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
