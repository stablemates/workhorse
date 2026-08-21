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
	defaultWorkerLease         = 30 * time.Second
	defaultWorkerPollInterval  = time.Second
	defaultMaintenanceInterval = time.Second
	minimumWorkerLease         = 100 * time.Millisecond
	maximumWorkerLease         = 24 * time.Hour
	workerPromotionLimit       = 100
	workerRecoveryLimit        = 100
	expirationRetryInterval    = 5 * time.Millisecond
	expirationRetryBudget      = time.Second
)

type ownershipStatus string

// ErrStaleLease matches a lifecycle settlement rejected under an expired or superseded fence.
var ErrStaleLease = errors.New(staleLeaseMessage)

// ErrLeaseLost matches a handler cancellation caused by PostgreSQL rejecting its fence.
var ErrLeaseLost = errors.New(leaseLostMessage)

// ErrCancellationRequested matches cooperative cancellation requested by an operator.
var ErrCancellationRequested = errors.New(cancellationRequestedMessage)

// ErrDeadlineExceeded matches cancellation at a job's immutable deadline.
var ErrDeadlineExceeded = errors.New(deadlineExceededMessage)

// ErrExecutionTimeout matches cancellation after an attempt consumes its execution budget.
var ErrExecutionTimeout = errors.New(executionTimeoutMessage)

// StaleLeaseError identifies the job whose fenced settlement PostgreSQL rejected.
type StaleLeaseError struct {
	JobID string
}

func (err *StaleLeaseError) Error() string {
	return fmt.Sprintf(staleLeaseErrorFormat, ErrStaleLease, err.JobID)
}

func (err *StaleLeaseError) Unwrap() error { return ErrStaleLease }

// LeaseLostError identifies the attempt whose fence PostgreSQL no longer accepts.
type LeaseLostError struct{ JobID string }

func (err *LeaseLostError) Error() string {
	return fmt.Sprintf(jobLifecycleErrorFormat, ErrLeaseLost, err.JobID)
}
func (err *LeaseLostError) Unwrap() error { return ErrLeaseLost }

// CancellationRequestedError identifies an operator cancellation delivered to a handler.
type CancellationRequestedError struct{ JobID string }

func (err *CancellationRequestedError) Error() string {
	return fmt.Sprintf(jobLifecycleErrorFormat, ErrCancellationRequested, err.JobID)
}
func (err *CancellationRequestedError) Unwrap() error { return ErrCancellationRequested }

// DeadlineExceededError identifies a job whose immutable deadline cancelled its handler.
type DeadlineExceededError struct{ JobID string }

func (err *DeadlineExceededError) Error() string {
	return fmt.Sprintf(jobLifecycleErrorFormat, ErrDeadlineExceeded, err.JobID)
}
func (err *DeadlineExceededError) Unwrap() error { return ErrDeadlineExceeded }

// ExecutionTimeoutError identifies an attempt whose active execution budget was consumed.
type ExecutionTimeoutError struct {
	JobID   string
	Attempt int
}

func (err *ExecutionTimeoutError) Error() string {
	return fmt.Sprintf(attemptLifecycleErrorFormat, ErrExecutionTimeout, err.JobID, err.Attempt)
}
func (err *ExecutionTimeoutError) Unwrap() error { return ErrExecutionTimeout }

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
	Queue               string
	WorkerID            string
	LeaseDuration       time.Duration
	HeartbeatInterval   time.Duration
	PollInterval        time.Duration
	MaintenanceInterval time.Duration
}

// Worker claims and settles one job at a time through a caller-owned pool.
type Worker struct {
	pool                *pgxpool.Pool
	queue               string
	workerID            string
	leaseDuration       time.Duration
	heartbeatInterval   time.Duration
	pollInterval        time.Duration
	maintenanceInterval time.Duration
	handlers            map[string]Handler
	compatibility       *CachedCompatibilityCheck
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
	heartbeatInterval := options.HeartbeatInterval
	if heartbeatInterval == 0 {
		heartbeatInterval = leaseDuration / 3 / time.Millisecond * time.Millisecond
	}
	if heartbeatInterval <= 0 || heartbeatInterval >= leaseDuration || heartbeatInterval%time.Millisecond != 0 {
		return nil, errors.New(workerHeartbeatRangeMessage)
	}
	pollInterval := options.PollInterval
	if pollInterval == 0 {
		pollInterval = defaultWorkerPollInterval
	}
	if pollInterval < 0 {
		return nil, errors.New(negativeWorkerPollMessage)
	}
	maintenanceInterval := options.MaintenanceInterval
	if maintenanceInterval == 0 {
		maintenanceInterval = defaultMaintenanceInterval
	}
	if maintenanceInterval < time.Millisecond || maintenanceInterval%time.Millisecond != 0 {
		return nil, errors.New(workerMaintenanceRangeMessage)
	}
	return &Worker{
		pool:                pool,
		queue:               queue,
		workerID:            workerID,
		leaseDuration:       leaseDuration,
		heartbeatInterval:   heartbeatInterval,
		pollInterval:        pollInterval,
		maintenanceInterval: maintenanceInterval,
		handlers:            make(map[string]Handler),
		compatibility:       NewCachedCompatibilityCheck(NewPGXExecutor(pool)),
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
	if err := worker.compatibility.Assert(ctx); err != nil {
		return err
	}
	executor := NewPGXExecutor(worker.pool)
	maintenanceContext, stopMaintenance := context.WithCancel(ctx)
	maintenanceErrors := make(chan error, 1)
	maintenanceDone := make(chan struct{})
	go func() {
		defer close(maintenanceDone)
		maintenanceErrors <- worker.maintenanceLoop(maintenanceContext)
	}()
	defer func() {
		stopMaintenance()
		<-maintenanceDone
	}()
	for {
		select {
		case err := <-maintenanceErrors:
			if err != nil {
				return err
			}
		default:
		}
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
		case err := <-maintenanceErrors:
			if !timer.Stop() {
				<-timer.C
			}
			return err
		case <-timer.C:
		}
	}
}

// RunOnce claims and processes at most one job.
func (worker *Worker) RunOnce(ctx context.Context) (bool, error) {
	if err := worker.compatibility.Assert(ctx); err != nil {
		return false, err
	}
	if err := worker.runMaintenance(ctx); err != nil {
		return false, err
	}
	return worker.runOnce(ctx, NewPGXExecutor(worker.pool))
}

func (worker *Worker) maintenanceLoop(ctx context.Context) error {
	if err := worker.runMaintenance(ctx); err != nil {
		return err
	}
	ticker := time.NewTicker(worker.maintenanceInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if err := worker.runMaintenance(ctx); err != nil {
				return err
			}
		}
	}
}

func (worker *Worker) runMaintenance(ctx context.Context) error {
	_, err := NewPGXExecutor(worker.pool).Query(
		ctx,
		protocolStatementRegistry[recoverExpiredStatementName],
		workerRecoveryLimit,
		nil,
	)
	return err
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
		return true, worker.execute(ctx, executor, job, handler)
	}
	return true, worker.fail(ctx, executor, job, err)
}

type ownershipResult struct {
	status ownershipStatus
	err    error
}

func (worker *Worker) execute(
	ctx context.Context,
	executor Executor,
	job ClaimedJob,
	handler Handler,
) error {
	handlerParent := ctx
	cancelDeadline := func() {}
	if expiration, cause := ownershipExpiration(job); expiration != nil {
		handlerParent, cancelDeadline = context.WithDeadlineCause(ctx, *expiration, cause)
	}
	handlerContext, cancelHandler := context.WithCancelCause(handlerParent)
	stopOwnership, ownershipDone := worker.superviseOwnership(ctx, job, cancelHandler)
	result, handlerError := handler(handlerContext, job.Payload)
	stopOwnership()
	ownership := <-ownershipDone
	cause := context.Cause(handlerContext)
	cancelHandler(nil)
	cancelDeadline()

	if ownership.err != nil {
		return ownership.err
	}
	if ownership.status == workerOwnershipCancelRequested {
		return worker.acknowledgeCancellation(ctx, executor, job)
	}
	if ownership.status == workerOwnershipDeadline || ownership.status == workerOwnershipTimeout {
		return nil
	}
	if ownership.status == workerOwnershipStale {
		return &StaleLeaseError{JobID: job.ID}
	}
	if ownership.status == workerOwnershipNotDue {
		return errors.New(expirationNotDueMessage)
	}
	if errors.Is(cause, ErrCancellationRequested) {
		return worker.acknowledgeCancellation(ctx, executor, job)
	}
	if errors.Is(cause, ErrDeadlineExceeded) || errors.Is(cause, ErrExecutionTimeout) {
		return worker.settleExpiration(ctx, executor, job)
	}
	if errors.Is(cause, ErrLeaseLost) {
		return &StaleLeaseError{JobID: job.ID}
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if handlerError != nil {
		return worker.fail(ctx, executor, job, handlerError)
	}
	if err := worker.complete(ctx, executor, job, result); errors.Is(err, ErrStaleLease) {
		return worker.reconcileRejectedSettlement(ctx, executor, job, err)
	} else {
		return err
	}
}

func (worker *Worker) superviseOwnership(
	ctx context.Context,
	job ClaimedJob,
	cancelHandler context.CancelCauseFunc,
) (func(), <-chan ownershipResult) {
	stop := make(chan struct{})
	done := make(chan ownershipResult, 1)
	go func() {
		heartbeatTimer := time.NewTimer(worker.heartbeatInterval)
		defer heartbeatTimer.Stop()
		expirationTimer, expirationCause := ownershipExpirationTimer(job)
		if expirationTimer != nil {
			defer expirationTimer.Stop()
		}
		for {
			var expiration <-chan time.Time
			if expirationTimer != nil {
				expiration = expirationTimer.C
			}
			select {
			case <-stop:
				done <- ownershipResult{status: workerOwnershipAccepted}
				return
			case <-ctx.Done():
				done <- ownershipResult{err: ctx.Err()}
				return
			case <-expiration:
				cancelHandler(expirationCause)
				status, err := worker.expireOwnership(ctx, job)
				done <- ownershipResult{status: status, err: err}
				return
			case <-heartbeatTimer.C:
				status, err := worker.refreshOwnership(ctx, job)
				if err != nil {
					cancelHandler(err)
					done <- ownershipResult{err: err}
					return
				}
				if status == workerOwnershipAccepted {
					heartbeatTimer.Reset(worker.heartbeatInterval)
					continue
				}
				cancelHandler(ownershipCause(job, status))
				done <- ownershipResult{status: status}
				return
			}
		}
	}()
	var once bool
	return func() {
		if !once {
			once = true
			close(stop)
		}
	}, done
}

func ownershipExpirationTimer(job ClaimedJob) (*time.Timer, error) {
	expiration, cause := ownershipExpiration(job)
	if expiration == nil {
		return nil, nil
	}
	return time.NewTimer(max(time.Millisecond, time.Until(expiration.Add(time.Millisecond)))), cause
}

func ownershipExpiration(job ClaimedJob) (*time.Time, error) {
	var expiration *time.Time
	var cause error
	if job.Deadline != nil {
		expiration = job.Deadline
		cause = &DeadlineExceededError{JobID: job.ID}
	}
	if job.AttemptTimeout != nil && (expiration == nil || job.AttemptTimeout.Before(*expiration)) {
		expiration = job.AttemptTimeout
		cause = &ExecutionTimeoutError{JobID: job.ID, Attempt: job.Attempt}
	}
	if expiration == nil {
		return nil, nil
	}
	return expiration, cause
}

func ownershipCause(job ClaimedJob, status ownershipStatus) error {
	switch status {
	case workerOwnershipCancelRequested:
		return &CancellationRequestedError{JobID: job.ID}
	case workerOwnershipDeadline:
		return &DeadlineExceededError{JobID: job.ID}
	case workerOwnershipTimeout:
		return &ExecutionTimeoutError{JobID: job.ID, Attempt: job.Attempt}
	default:
		return &LeaseLostError{JobID: job.ID}
	}
}

func (worker *Worker) refreshOwnership(ctx context.Context, job ClaimedJob) (ownershipStatus, error) {
	arguments := append(worker.fencedLease(job).parameters(), int(worker.leaseDuration/time.Millisecond))
	rows, err := NewPGXExecutor(worker.pool).Query(
		ctx,
		protocolStatementRegistry[heartbeatStatementName],
		arguments...,
	)
	if err != nil {
		return emptyString, err
	}
	return parseOwnershipStatus(rows)
}

func (worker *Worker) expireOwnership(ctx context.Context, job ClaimedJob) (ownershipStatus, error) {
	deadline := time.Now().Add(expirationRetryBudget)
	for {
		rows, err := NewPGXExecutor(worker.pool).Query(
			ctx,
			protocolStatementRegistry[expireOwnedStatementName],
			worker.fencedLease(job).parameters()...,
		)
		if err != nil {
			return emptyString, err
		}
		status, err := parseOwnershipStatus(rows)
		if err != nil || status != workerOwnershipNotDue || !time.Now().Before(deadline) {
			return status, err
		}
		timer := time.NewTimer(expirationRetryInterval)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return emptyString, ctx.Err()
		case <-timer.C:
		}
	}
}

func parseOwnershipStatus(rows []Row) (ownershipStatus, error) {
	if len(rows) != 1 {
		return emptyString, errors.New(invalidOwnershipResultMessage)
	}
	value, ok := rows[0][rowStatusField].(string)
	if !ok {
		return emptyString, errors.New(invalidOwnershipResultMessage)
	}
	status := ownershipStatus(value)
	switch status {
	case workerOwnershipAccepted, workerOwnershipCancelRequested, workerOwnershipDeadline,
		workerOwnershipTimeout, workerOwnershipStale, workerOwnershipNotDue:
		return status, nil
	default:
		return emptyString, fmt.Errorf(unknownOwnershipStatusFormat, status)
	}
}

func (worker *Worker) acknowledgeCancellation(ctx context.Context, executor Executor, job ClaimedJob) error {
	accepted, err := worker.cancellationAccepted(ctx, executor, job)
	if err != nil {
		return err
	}
	if !accepted {
		return &StaleLeaseError{JobID: job.ID}
	}
	return nil
}

func (worker *Worker) reconcileRejectedSettlement(
	ctx context.Context,
	executor Executor,
	job ClaimedJob,
	settlementError error,
) error {
	accepted, err := worker.cancellationAccepted(ctx, executor, job)
	if err != nil {
		return err
	}
	if accepted {
		return nil
	}
	status, err := worker.expireOwnership(ctx, job)
	if err != nil {
		return err
	}
	switch status {
	case workerOwnershipCancelRequested:
		return worker.acknowledgeCancellation(ctx, executor, job)
	case workerOwnershipDeadline, workerOwnershipTimeout:
		return nil
	default:
		return settlementError
	}
}

func (worker *Worker) settleExpiration(ctx context.Context, executor Executor, job ClaimedJob) error {
	status, err := worker.expireOwnership(ctx, job)
	if err != nil {
		return err
	}
	switch status {
	case workerOwnershipCancelRequested:
		return worker.acknowledgeCancellation(ctx, executor, job)
	case workerOwnershipDeadline, workerOwnershipTimeout:
		return nil
	case workerOwnershipStale:
		return &StaleLeaseError{JobID: job.ID}
	default:
		return errors.New(expirationNotDueMessage)
	}
}

func (worker *Worker) cancellationAccepted(
	ctx context.Context,
	executor Executor,
	job ClaimedJob,
) (bool, error) {
	rows, err := executor.Query(
		ctx,
		protocolStatementRegistry[acknowledgeCancelStatementName],
		worker.fencedLease(job).parameters()...,
	)
	if err != nil {
		return false, err
	}
	if len(rows) != 1 {
		return false, errors.New(invalidCancelAcknowledgeMessage)
	}
	accepted, ok := rows[0][rowAcceptedField].(bool)
	if !ok {
		return false, errors.New(invalidCancelAcknowledgeMessage)
	}
	return accepted, nil
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
	case workerFailureCancelRequested:
		return worker.acknowledgeCancellation(ctx, executor, job)
	case workerFailureDeadline, workerFailureTimeout:
		return nil
	case workerFailureStale:
		return worker.reconcileRejectedSettlement(
			ctx,
			executor,
			job,
			&StaleLeaseError{JobID: job.ID},
		)
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
