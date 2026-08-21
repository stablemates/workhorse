package workhorse

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	defaultWorkerLease        = 30 * time.Second
	defaultWorkerPollInterval = time.Second
	minimumWorkerLease        = 100 * time.Millisecond
	maximumWorkerLease        = 24 * time.Hour
	workerPromotionLimit      = 100
)

// ErrStaleLease matches a lifecycle settlement rejected under an expired or superseded fence.
var ErrStaleLease = errors.New(staleLeaseMessage)

// StaleLeaseError identifies the job whose fenced settlement PostgreSQL rejected.
type StaleLeaseError struct {
	JobID string
}

func (err *StaleLeaseError) Error() string {
	return fmt.Sprintf(staleLeaseErrorFormat, ErrStaleLease, err.JobID)
}

func (err *StaleLeaseError) Unwrap() error { return ErrStaleLease }

// ClaimedJob is PostgreSQL's immutable snapshot of one fenced attempt.
type ClaimedJob struct {
	ID                 string
	Queue              string
	Type               string
	Priority           int
	Payload            any
	ContractVersion    *string
	ResultMaxBytes     int
	RedactErrorDetails bool
	TraceContext       any
	Attempt            int
	MaxAttempts        int
	RetryPolicy        map[string]any
	Deadline           *time.Time
	ExecutionTimeout   time.Duration
	AttemptTimeout     *time.Time
	FenceToken         int64
	LeaseExpiresAt     time.Time
}

// Handler processes one claimed payload outside a database transaction.
type Handler func(context.Context, any) (any, error)

// WorkerOptions configures the minimal single-queue polling worker.
type WorkerOptions struct {
	Queue         string
	WorkerID      string
	LeaseDuration time.Duration
	PollInterval  time.Duration
}

// Worker claims and settles one job at a time through a dedicated pooled connection.
type Worker struct {
	pool          *pgxpool.Pool
	queue         string
	workerID      string
	leaseDuration time.Duration
	pollInterval  time.Duration
	handlers      map[string]Handler
	compatibility *CachedCompatibilityCheck
}

type fencedLease struct {
	jobID      string
	workerID   string
	fenceToken int64
}

func (lease fencedLease) parameters() []any {
	return []any{lease.jobID, lease.workerID, lease.fenceToken}
}

// NewWorker constructs a single-queue worker over a caller-owned pool.
func NewWorker(pool *pgxpool.Pool, options WorkerOptions) (*Worker, error) {
	if pool == nil {
		return nil, errors.New(nilWorkerPoolMessage)
	}
	queue := options.Queue
	if queue == emptyString {
		queue = defaultWorkerQueueValue
	}
	workerID := options.WorkerID
	if workerID == emptyString {
		workerID = defaultWorkerID()
	}
	leaseDuration := options.LeaseDuration
	if leaseDuration == 0 {
		leaseDuration = defaultWorkerLease
	}
	if leaseDuration < minimumWorkerLease || leaseDuration > maximumWorkerLease || leaseDuration%time.Millisecond != 0 {
		return nil, fmt.Errorf(workerLeaseRangeMessage, minimumWorkerLease, maximumWorkerLease)
	}
	pollInterval := options.PollInterval
	if pollInterval == 0 {
		pollInterval = defaultWorkerPollInterval
	}
	if pollInterval < 0 {
		return nil, errors.New(negativeWorkerPollMessage)
	}
	return &Worker{
		pool:          pool,
		queue:         queue,
		workerID:      workerID,
		leaseDuration: leaseDuration,
		pollInterval:  pollInterval,
		handlers:      make(map[string]Handler),
		compatibility: NewCachedCompatibilityCheck(NewPGXExecutor(pool)),
	}, nil
}

// Handle registers the handler for a job type and returns the worker for chaining.
func (worker *Worker) Handle(jobType string, handler Handler) *Worker {
	if jobType == emptyString {
		panic(emptyWorkerJobTypeMessage)
	}
	if handler == nil {
		panic(nilWorkerHandlerMessage)
	}
	worker.handlers[jobType] = handler
	return worker
}

// Run polls until the context is cancelled or an operational lifecycle error occurs.
func (worker *Worker) Run(ctx context.Context) error {
	executor, release, err := worker.acquireExecutor(ctx)
	if err != nil {
		return err
	}
	defer release()
	for {
		processed, err := worker.runOnce(ctx, executor)
		if err != nil {
			return err
		}
		if processed || worker.pollInterval == 0 {
			continue
		}
		timer := time.NewTimer(worker.pollInterval)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return nil
		case <-timer.C:
		}
	}
}

// RunOnce claims and processes at most one job.
func (worker *Worker) RunOnce(ctx context.Context) (bool, error) {
	executor, release, err := worker.acquireExecutor(ctx)
	if err != nil {
		return false, err
	}
	defer release()
	return worker.runOnce(ctx, executor)
}

func (worker *Worker) acquireExecutor(ctx context.Context) (Executor, func(), error) {
	if err := worker.compatibility.Assert(ctx); err != nil {
		return nil, nil, err
	}
	connection, err := worker.pool.Acquire(ctx)
	if err != nil {
		return nil, nil, err
	}
	return NewPGXExecutor(connection), connection.Release, nil
}

func (worker *Worker) runOnce(ctx context.Context, executor Executor) (bool, error) {
	if _, err := executor.Query(
		ctx,
		internalStatementRegistry[promoteStatementName],
		workerPromotionLimit,
	); err != nil {
		return false, err
	}
	rows, err := executor.Query(
		ctx,
		protocolStatementRegistry[claimStatementName],
		worker.queue,
		worker.workerID,
		int(worker.leaseDuration/time.Millisecond),
	)
	if err != nil {
		return false, err
	}
	if len(rows) == 0 {
		return false, nil
	}
	if len(rows) != 1 {
		return false, errors.New(invalidClaimResultMessage)
	}
	job, err := claimedJob(rows[0], worker.queue)
	if err != nil {
		return false, err
	}
	handler := worker.handlers[job.Type]
	if handler == nil {
		err = fmt.Errorf(missingWorkerHandlerFormat, job.Type)
	} else {
		var result any
		result, err = handler(ctx, job.Payload)
		if err == nil {
			return true, worker.complete(ctx, executor, job, result)
		}
	}
	return true, worker.fail(ctx, executor, job, err)
}

func (worker *Worker) complete(ctx context.Context, executor Executor, job ClaimedJob, result any) error {
	encoded, err := json.Marshal(result)
	if err != nil {
		return worker.fail(ctx, executor, job, err)
	}
	lease := worker.fencedLease(job)
	arguments := append(lease.parameters(), encoded)
	rows, err := executor.Query(ctx, protocolStatementRegistry[completeStatementName], arguments...)
	if err != nil {
		return err
	}
	if len(rows) != 1 {
		return errors.New(invalidCompletionResultMessage)
	}
	accepted, ok := rows[0][rowAcceptedField].(bool)
	if !ok {
		return errors.New(invalidCompletionResultMessage)
	}
	if !accepted {
		return &StaleLeaseError{JobID: job.ID}
	}
	return nil
}

func (worker *Worker) fail(ctx context.Context, executor Executor, job ClaimedJob, handlerError error) error {
	envelope := handlerErrorEnvelope(handlerError, job.RedactErrorDetails)
	encoded, err := json.Marshal(envelope)
	if err != nil {
		return err
	}
	lease := worker.fencedLease(job)
	arguments := append(lease.parameters(), encoded, nil)
	rows, err := executor.Query(ctx, protocolStatementRegistry[failStatementName], arguments...)
	if err != nil {
		return err
	}
	if len(rows) != 1 {
		return errors.New(invalidFailureResultMessage)
	}
	state, ok := rows[0][rowStateField].(string)
	if !ok {
		return errors.New(invalidFailureResultMessage)
	}
	switch state {
	case workerFailureReady, workerFailureScheduled, workerFailureFailed:
		return nil
	case workerFailureStale:
		return &StaleLeaseError{JobID: job.ID}
	default:
		return fmt.Errorf(rejectedFailureStateFormat, state)
	}
}

func (worker *Worker) fencedLease(job ClaimedJob) fencedLease {
	return fencedLease{jobID: job.ID, workerID: worker.workerID, fenceToken: job.FenceToken}
}

func claimedJob(row Row, queue string) (ClaimedJob, error) {
	jobID, ok := uuidString(row[rowJobIDField])
	if !ok {
		return ClaimedJob{}, errors.New(invalidClaimResultMessage)
	}
	jobType, ok := row[rowJobTypeField].(string)
	if !ok || jobType == emptyString {
		return ClaimedJob{}, errors.New(invalidClaimResultMessage)
	}
	priority, priorityOK := integer(row[rowPriorityField])
	attempt, attemptOK := integer(row[rowAttemptField])
	maxAttempts, maxAttemptsOK := integer(row[rowMaxAttemptsField])
	resultMaxBytes, resultMaxBytesOK := integer(row[rowResultMaxBytesField])
	fenceToken, fenceOK := int64Value(row[rowFenceTokenField])
	leaseExpiresAt, leaseOK := row[rowLeaseExpiresAtField].(time.Time)
	if !priorityOK || !attemptOK || !maxAttemptsOK || !resultMaxBytesOK || !fenceOK || !leaseOK {
		return ClaimedJob{}, errors.New(invalidClaimResultMessage)
	}
	payload, err := decodedJSON(row[rowPayloadField])
	if err != nil {
		return ClaimedJob{}, err
	}
	job := ClaimedJob{
		ID: jobID, Queue: queue, Type: jobType, Priority: priority, Payload: payload,
		ResultMaxBytes: resultMaxBytes, RedactErrorDetails: row[rowRedactErrorDetailsField] == true,
		TraceContext: row[rowTraceContextField], Attempt: attempt, MaxAttempts: maxAttempts,
		FenceToken: fenceToken, LeaseExpiresAt: leaseExpiresAt,
	}
	if value, ok := row[rowContractVersionField].(string); ok {
		job.ContractVersion = &value
	}
	if value, ok := row[rowRetryPolicyField].(map[string]any); ok {
		job.RetryPolicy = value
	}
	if value, ok := row[rowDeadlineAtField].(time.Time); ok {
		job.Deadline = &value
	}
	if value, ok := int64Value(row[rowExecutionTimeoutMSField]); ok {
		job.ExecutionTimeout = time.Duration(value) * time.Millisecond
	}
	if value, ok := row[rowAttemptTimeoutAtField].(time.Time); ok {
		job.AttemptTimeout = &value
	}
	return job, nil
}

func decodedJSON(value any) (any, error) {
	switch value := value.(type) {
	case []byte:
		var decoded any
		if err := json.Unmarshal(value, &decoded); err != nil {
			return nil, err
		}
		return decoded, nil
	case string:
		var decoded any
		if err := json.Unmarshal([]byte(value), &decoded); err != nil {
			return nil, err
		}
		return decoded, nil
	default:
		return value, nil
	}
}

func int64Value(value any) (int64, bool) {
	switch value := value.(type) {
	case int:
		return int64(value), true
	case int16:
		return int64(value), true
	case int32:
		return int64(value), true
	case int64:
		return value, true
	default:
		return 0, false
	}
}

func handlerErrorEnvelope(err error, redact bool) map[string]any {
	if redact {
		return map[string]any{errorNameField: redactedHandlerErrorNameValue, errorMessageField: redactedHandlerErrorTextValue}
	}
	name := genericHandlerErrorName
	if value := reflect.TypeOf(err); value != nil {
		name = value.String()
	}
	return map[string]any{errorNameField: name, errorMessageField: err.Error()}
}

func defaultWorkerID() string {
	hostname, err := os.Hostname()
	if err != nil || hostname == emptyString {
		hostname = defaultWorkerName
	}
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return fmt.Sprintf(workerIDFallbackFormat, hostname, os.Getpid())
	}
	return fmt.Sprintf(workerIDFormat, hostname, os.Getpid(), hex.EncodeToString(suffix[:]))
}
