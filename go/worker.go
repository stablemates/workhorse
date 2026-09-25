package workhorse

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	pseudorand "math/rand/v2"
	"os"
	"reflect"
	"runtime/debug"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
)

const (
	defaultWorkerLease         = 30 * time.Second
	defaultWorkerPollInterval  = 250 * time.Millisecond
	defaultMaintenanceInterval = time.Second
	defaultRegistryInterval    = 5 * time.Second
	// ADR 0011 sets the routine offer at once a minute. PostgreSQL owns the global due decision,
	// so the offer rate does not have to follow the tick rate.
	defaultMaintenanceRoutineInterval = time.Minute
	// The deadline sits under the 30 second termination grace a container platform gives a process
	// by default, so the worker finishes its own shutdown before the platform sends SIGKILL.
	defaultShutdownGracePeriod = 25 * time.Second
	minimumWorkerLease         = 100 * time.Millisecond
	maximumWorkerLease         = 24 * time.Hour
	maximumWorkerConcurrency   = 100
	workerPromotionLimit       = 100
	workerRecoveryLimit        = 100
	expirationRetryInterval    = 5 * time.Millisecond
	expirationRetryBudget      = time.Second
	maximumEmptyPollInterval   = 5 * time.Second
	notificationClaimDelay     = 50 * time.Millisecond
	// How long a cancelled handler has to unwind before Run stops waiting for it. A handler that
	// honours its context returns well inside this window, so abandonment reports a handler that
	// ignored cancellation rather than one that was about to finish.
	handlerUnwindPeriod = 250 * time.Millisecond
	// A worker that subscribes to task notifications polls only as a fallback, so it waits the
	// ceiling between empty claims. A worker that cannot subscribe starts at the shorter interval
	// and backs off toward the same ceiling.
	defaultNotificationPollInterval = maximumEmptyPollInterval
)

func workerPollDelay(base time.Duration, consecutiveEmpty int, backoff bool) time.Duration {
	delay := base
	if backoff {
		delay = min(delay, maximumEmptyPollInterval)
		for range min(max(consecutiveEmpty-1, 0), 30) {
			if delay >= maximumEmptyPollInterval/2 {
				delay = maximumEmptyPollInterval
				break
			}
			delay *= 2
		}
	}
	jitter := 0.9 + pseudorand.Float64()*0.2
	return max(time.Millisecond, time.Duration(float64(delay)*jitter))
}

func resetTimer(timer *time.Timer, delay time.Duration) {
	if !timer.Stop() {
		select {
		case <-timer.C:
		default:
		}
	}
	timer.Reset(delay)
}

type ownershipStatus string

// errExpirationNotDue reports that PostgreSQL kept refusing an expiration the local timer fired for.
var errExpirationNotDue = errors.New(expirationNotDueMessage)

// ErrStaleLease matches a lifecycle settlement rejected under an expired or superseded fence.
var ErrStaleLease = errors.New(staleLeaseMessage)

// ErrLeaseLost matches a handler cancellation caused by PostgreSQL rejecting its fence.
var ErrLeaseLost = errors.New(leaseLostMessage)

// ErrCancellationRequested matches cooperative cancellation requested by an operator.
var ErrCancellationRequested = errors.New(cancellationRequestedMessage)

// ErrDeadlineExceeded matches cancellation at a task's immutable deadline.
var ErrDeadlineExceeded = errors.New(deadlineExceededMessage)

// ErrExecutionTimeout matches cancellation after an attempt consumes its execution budget.
var ErrExecutionTimeout = errors.New(executionTimeoutMessage)

// ErrShutdownIncomplete matches a Run that returned with handlers still executing. Run cancels
// them at the shutdown grace period and stops renewing their leases, so PostgreSQL recovers their
// tasks, but it does not wait for goroutines it no longer controls. Those goroutines may still use
// the pool, so a caller that receives this error should end the process rather than close the pool
// and continue.
var ErrShutdownIncomplete = errors.New(shutdownIncompleteMessage)

// StaleLeaseError identifies the task whose fenced settlement PostgreSQL rejected.
type StaleLeaseError struct {
	TaskID string
}

func (err *StaleLeaseError) Error() string {
	return fmt.Sprintf(staleLeaseErrorFormat, ErrStaleLease, err.TaskID)
}

func (err *StaleLeaseError) Unwrap() error { return ErrStaleLease }

// LeaseLostError identifies the attempt whose fence PostgreSQL no longer accepts.
type LeaseLostError struct{ TaskID string }

func (err *LeaseLostError) Error() string {
	return leaseLostErrorMessage
}
func (err *LeaseLostError) Unwrap() error { return ErrLeaseLost }

// CancellationRequestedError identifies an operator cancellation delivered to a handler.
type CancellationRequestedError struct{ TaskID string }

func (err *CancellationRequestedError) Error() string {
	return fmt.Sprintf(taskLifecycleErrorFormat, ErrCancellationRequested, err.TaskID)
}
func (err *CancellationRequestedError) Unwrap() error { return ErrCancellationRequested }

// DeadlineExceededError identifies a task whose immutable deadline cancelled its handler.
type DeadlineExceededError struct{ TaskID string }

func (err *DeadlineExceededError) Error() string {
	return fmt.Sprintf(taskLifecycleErrorFormat, ErrDeadlineExceeded, err.TaskID)
}
func (err *DeadlineExceededError) Unwrap() error { return ErrDeadlineExceeded }

// ExecutionTimeoutError identifies an attempt whose active execution budget was consumed.
type ExecutionTimeoutError struct {
	TaskID  string
	Attempt int
}

func (err *ExecutionTimeoutError) Error() string {
	return fmt.Sprintf(attemptLifecycleErrorFormat, ErrExecutionTimeout, err.TaskID, err.Attempt)
}
func (err *ExecutionTimeoutError) Unwrap() error { return ErrExecutionTimeout }

// ClaimedTask is PostgreSQL's immutable snapshot of one fenced attempt.
type ClaimedTask struct {
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
	// claimSentAt is when this worker sent the claim request. The lease watchdog measures from it,
	// so a claim that took a long time to answer shortens the watchdog instead of overrunning it.
	claimSentAt time.Time
	// payloadError records a payload the worker could not decode. The attempt fails through the
	// ordinary failure path, so one unreadable row never ends Run.
	payloadError error
}

// Handler processes one claimed payload with fenced durable operations outside a transaction.
type Handler func(context.Context, any, *HandlerContext) (any, error)

// WorkerOptions configures a bounded worker with notification-assisted polling.
type WorkerOptions struct {
	Queue               string
	Queues              []string
	WorkerID            string
	Concurrency         int
	LeaseDuration       time.Duration
	HeartbeatInterval   time.Duration
	PollInterval        time.Duration
	MaintenanceInterval time.Duration
	// MaintenanceRoutineInterval bounds how often this worker offers the slow retention routines
	// to PostgreSQL. It defaults to one minute and never runs faster than MaintenanceInterval.
	MaintenanceRoutineInterval time.Duration
	RegistryInterval           time.Duration
	DisableRegistry            bool
	ScheduleNamespaces         []string
	ScheduleCatchupLimit       int
	ShutdownGracePeriod        time.Duration
	PollingOnly                bool
	// SharedHeartbeats opts out of the dedicated heartbeat connection reservation.
	SharedHeartbeats    bool
	Logger              *slog.Logger
	OnRegistrationError func(error)
	// RetryDelay overrides the delay the persisted retry policy would choose, for one failed
	// attempt. It returns nil to leave the choice to the policy, which is what a worker without
	// this option always does.
	RetryDelay func(attempt int, task ClaimedTask) *time.Duration
}

// Worker claims and settles tasks through a caller-owned pool.
type Worker struct {
	pool                *pgxpool.Pool
	queues              []string
	queueCursorMu       sync.Mutex
	nextQueueIndex      int
	workerID            string
	concurrency         int
	leaseDuration       time.Duration
	heartbeatInterval   time.Duration
	pollInterval        time.Duration
	maintenanceInterval time.Duration
	// maintenanceRoutineInterval and lastRoutineOffer gate the slow routines. RunOnce and the
	// maintenance loop both offer them, so the last offer is shared state.
	maintenanceRoutineInterval time.Duration
	lastRoutineOffer           atomic.Int64
	registryInterval           time.Duration
	registryEnabled            bool
	hostname                   string
	instanceID                 string
	scheduleNamespaces         []string
	scheduleCatchupLimit       int
	shutdownGracePeriod        time.Duration
	pollingOnly                bool
	logger                     *slog.Logger
	metrics                    *workerMetrics
	runPermit                  chan struct{}
	handlerSlots               chan struct{}
	handlers                   map[string]Handler
	compatibility              *CachedCompatibilityCheck
	onRegistrationError        func(error)
	retryDelay                 func(attempt int, task ClaimedTask) *time.Duration
	contracts                  contractCache
	activeSlots                atomic.Int64
	draining                   atomic.Bool
	remotelyPaused             atomic.Bool
	registered                 atomic.Bool
	heartbeatMu                sync.Mutex
	heartbeatMembers           map[*heartbeatMember]struct{}
	heartbeatWake              chan struct{}
	heartbeatRunning           bool
	heartbeatLease             *heartbeatConnectionLease
	sharedHeartbeats           bool
}

type heartbeatMember struct {
	ctx           context.Context
	task          ClaimedTask
	cancelHandler context.CancelCauseFunc
	result        chan ownershipResult
	renewed       chan time.Time
}

// renew reports an accepted renewal to the supervising goroutine without blocking. The reported
// instant is when the round's request was sent, which is when the granted lease started.
func (member *heartbeatMember) renew(sentAt time.Time) {
	select {
	case member.renewed <- sentAt:
	default:
	}
}

// deliver hands the first ownership result to the supervising goroutine without blocking. The
// heartbeat loop is shared by every member, so a later result for the same member is dropped.
func (member *heartbeatMember) deliver(result ownershipResult) {
	select {
	case member.result <- result:
	default:
	}
}

type fencedLease struct {
	taskID     string
	workerID   string
	fenceToken int64
}

func (lease fencedLease) parameters() []any {
	return []any{lease.taskID, lease.workerID, lease.fenceToken}
}

// NewWorker constructs a bounded worker over a caller-owned pool.
func NewWorker(pool *pgxpool.Pool, options WorkerOptions) (*Worker, error) {
	if pool == nil {
		return nil, errors.New(nilWorkerPoolMessage)
	}
	if pool.Config().MaxConns < 3 && !options.SharedHeartbeats {
		return nil, fmt.Errorf(workerHeartbeatCapacityErrorFormat, pool.Config().MaxConns)
	}
	if options.Queue != emptyString && len(options.Queues) > 0 {
		return nil, errors.New(workerQueueOptionsMessage)
	}
	queues := options.Queues
	if len(queues) == 0 {
		queue := options.Queue
		if queue == emptyString {
			queue = defaultWorkerQueueValue
		}
		queues = []string{queue}
	}
	uniqueQueues := make([]string, 0, len(queues))
	seenQueues := make(map[string]struct{}, len(queues))
	for _, queue := range queues {
		if queue == emptyString {
			return nil, errors.New(workerQueuesMessage)
		}
		if _, exists := seenQueues[queue]; exists {
			continue
		}
		seenQueues[queue] = struct{}{}
		uniqueQueues = append(uniqueQueues, queue)
	}
	if len(uniqueQueues) == 0 {
		return nil, errors.New(workerQueuesMessage)
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
		pollInterval = defaultNotificationPollInterval
		if options.PollingOnly {
			pollInterval = defaultWorkerPollInterval
		}
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
	maintenanceRoutineInterval := options.MaintenanceRoutineInterval
	if maintenanceRoutineInterval == 0 {
		maintenanceRoutineInterval = defaultMaintenanceRoutineInterval
	}
	if maintenanceRoutineInterval < time.Millisecond || maintenanceRoutineInterval%time.Millisecond != 0 {
		return nil, errors.New(workerRoutineIntervalRangeMessage)
	}
	registryInterval := options.RegistryInterval
	if registryInterval == 0 {
		registryInterval = defaultRegistryInterval
	}
	if registryInterval < 100*time.Millisecond || registryInterval%time.Millisecond != 0 {
		return nil, errors.New(workerRegistryRangeMessage)
	}
	scheduleNamespaces := make([]string, 0, len(options.ScheduleNamespaces))
	seenScheduleNamespaces := make(map[string]struct{}, len(options.ScheduleNamespaces))
	for _, namespace := range options.ScheduleNamespaces {
		if namespace == emptyString {
			return nil, errors.New(workerScheduleNamespacesMessage)
		}
		if _, exists := seenScheduleNamespaces[namespace]; exists {
			continue
		}
		seenScheduleNamespaces[namespace] = struct{}{}
		scheduleNamespaces = append(scheduleNamespaces, namespace)
	}
	scheduleCatchupLimit := options.ScheduleCatchupLimit
	if scheduleCatchupLimit == 0 {
		scheduleCatchupLimit = 100
	}
	if scheduleCatchupLimit < 1 || scheduleCatchupLimit > 10_000 {
		return nil, errors.New(workerScheduleCatchupRangeMessage)
	}
	concurrency := options.Concurrency
	if concurrency == 0 {
		concurrency = 1
	}
	if concurrency < 1 || concurrency > maximumWorkerConcurrency {
		return nil, fmt.Errorf(workerConcurrencyRangeMessage, maximumWorkerConcurrency)
	}
	shutdownGracePeriod := options.ShutdownGracePeriod
	if shutdownGracePeriod == 0 {
		shutdownGracePeriod = defaultShutdownGracePeriod
	}
	if shutdownGracePeriod < time.Millisecond || shutdownGracePeriod%time.Millisecond != 0 {
		return nil, errors.New(workerShutdownGraceRangeMessage)
	}
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	runPermit := make(chan struct{}, 1)
	runPermit <- struct{}{}
	metrics, err := newWorkerMetrics()
	if err != nil {
		return nil, fmt.Errorf(workerMetricCreationErrorFormat, err)
	}
	return &Worker{
		pool:                       pool,
		queues:                     uniqueQueues,
		workerID:                   workerID,
		concurrency:                concurrency,
		leaseDuration:              leaseDuration,
		heartbeatInterval:          heartbeatInterval,
		pollInterval:               pollInterval,
		maintenanceInterval:        maintenanceInterval,
		maintenanceRoutineInterval: maintenanceRoutineInterval,
		registryInterval:           registryInterval,
		registryEnabled:            !options.DisableRegistry,
		hostname:                   workerHostname(),
		scheduleNamespaces:         scheduleNamespaces,
		scheduleCatchupLimit:       scheduleCatchupLimit,
		shutdownGracePeriod:        shutdownGracePeriod,
		pollingOnly:                options.PollingOnly,
		logger:                     logger,
		metrics:                    metrics,
		runPermit:                  runPermit,
		handlerSlots:               make(chan struct{}, concurrency),
		handlers:                   make(map[string]Handler),
		compatibility:              NewCachedCompatibilityCheck(NewPGXExecutor(pool)),
		onRegistrationError:        options.OnRegistrationError,
		retryDelay:                 options.RetryDelay,
		contracts:                  newContractCache(),
		heartbeatMembers:           make(map[*heartbeatMember]struct{}),
		heartbeatWake:              make(chan struct{}, 1),
		sharedHeartbeats:           options.SharedHeartbeats,
	}, nil
}

// Handle registers the handler for a task type and returns the worker for chaining.
func (worker *Worker) Handle(taskType string, handler Handler) *Worker {
	if taskType == emptyString {
		panic(emptyWorkerTaskTypeMessage)
	}
	if handler == nil {
		panic(nilWorkerHandlerMessage)
	}
	worker.handlers[taskType] = handler
	return worker
}

// Run listens and polls until the context is cancelled or an operational lifecycle error occurs, then drains.
func (worker *Worker) Run(ctx context.Context) error {
	releaseRun, err := worker.acquireRun(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return nil
		}
		return err
	}
	defer releaseRun()
	worker.holdHeartbeats(ctx)
	defer worker.releaseHeartbeatConnection()
	if err := worker.compatibility.Assert(ctx); err != nil {
		return err
	}
	instanceID, ok := newUUID()
	if !ok {
		return errors.New(workerInstanceIDMessage)
	}
	worker.instanceID = instanceID
	worker.registered.Store(false)
	executor := NewPGXExecutor(worker.pool)
	worker.draining.Store(false)
	worker.refreshRegistration(ctx, executor, false)
	registryContext, stopRegistry := context.WithCancel(context.WithoutCancel(ctx))
	registryWake := make(chan struct{}, 1)
	registryDone := make(chan struct{})
	go func() {
		defer close(registryDone)
		worker.registrationLoop(registryContext, executor, registryWake)
	}()
	notificationContext, stopNotifications := context.WithCancel(ctx)
	notificationWake := make(chan struct{}, 1)
	notificationDone := make(chan struct{})
	var notificationListening atomic.Bool
	go func() {
		defer close(notificationDone)
		listenForTaskNotifications(
			notificationContext,
			worker.pool,
			worker.queues,
			worker.pollingOnly,
			worker.logger,
			notificationWake,
			&notificationListening,
		)
	}()
	defer func() {
		stopNotifications()
		<-notificationDone
	}()
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
	executionContext, cancelExecutions := context.WithCancel(context.WithoutCancel(ctx))
	defer cancelExecutions()
	executionResults := make(chan error, worker.concurrency)
	active, firstError := worker.dispatch(ctx, dispatchEnvironment{
		// A claim may commit tasks before a later queue fails. The claim must finish even when the
		// run context is cancelled, and every task it returned still needs to be executed before the
		// error is surfaced.
		claim: func(limit int) ([]ClaimedTask, error) {
			return worker.claimNextMany(context.WithoutCancel(ctx), executor, limit)
		},
		execute: func(claimed ClaimedTask) error {
			handler := worker.handlers[claimed.Type]
			if handler == nil {
				return worker.release(executionContext, executor, claimed)
			}
			return worker.execute(executionContext, executor, claimed, handler)
		},
		executionResults:  executionResults,
		notificationWake:  notificationWake,
		registryWake:      registryWake,
		maintenanceErrors: maintenanceErrors,
		listening:         notificationListening.Load,
	})

	worker.draining.Store(true)
	worker.refreshRegistration(context.WithoutCancel(ctx), executor, true)
	stopMaintenance()
	graceTimer := time.NewTimer(worker.shutdownGracePeriod)
	abandoned := 0
	for active > 0 {
		select {
		case err := <-executionResults:
			active--
			if err != nil && firstError == nil {
				firstError = err
			}
			continue
		case <-graceTimer.C:
		}
		// The grace period is the time a handler gets to finish on its own. What follows bounds
		// what used to be unbounded: cancel, give the cancelled handlers one short window to
		// unwind, then abandon whatever still runs so Run always returns.
		cancelExecutions()
		unwindTimer := time.NewTimer(handlerUnwindPeriod)
		for active > 0 {
			select {
			case <-executionResults:
				active--
				continue
			case <-unwindTimer.C:
			}
			break
		}
		if !unwindTimer.Stop() {
			select {
			case <-unwindTimer.C:
			default:
			}
		}
		// An abandoned handler keeps running inside the caller's process and settles its own task.
		// Its lease renewal stops here, so a handler that never returns leaves a lease PostgreSQL
		// recovers, which is what a worker process that exits at its deadline leaves behind too.
		if active > 0 {
			worker.abandonHeartbeats()
			abandoned = active
		}
		break
	}
	if !graceTimer.Stop() {
		select {
		case <-graceTimer.C:
		default:
		}
	}
	stopRegistry()
	<-registryDone
	worker.deregister(context.WithoutCancel(ctx), executor)
	if abandoned > 0 {
		incomplete := fmt.Errorf(workerShutdownIncompleteFormat, ErrShutdownIncomplete, abandoned)
		if firstError == nil {
			return incomplete
		}
		return errors.Join(firstError, incomplete)
	}
	return firstError
}

// dispatchRefillBatch is how many free slots let a second claim start while one is in flight: a
// quarter of the concurrency, rounded up.
func dispatchRefillBatch(concurrency int) int {
	return (concurrency + 3) / 4
}

// dispatchEnvironment carries what the dispatch loop needs from Run. A test replaces the claim and
// the execution with fakes and drives the loop without PostgreSQL.
type dispatchEnvironment struct {
	claim             func(limit int) ([]ClaimedTask, error)
	execute           func(task ClaimedTask) error
	executionResults  chan error
	notificationWake  <-chan struct{}
	registryWake      <-chan struct{}
	maintenanceErrors <-chan error
	listening         func() bool
}

// claimSettlement is one finished claim. skipped reports a claim that was never sent because the
// worker stopped or paused during the notification delay.
type claimSettlement struct {
	limit       int
	wakeVersion int
	skipped     bool
	tasks       []ClaimedTask
	err         error
}

// dispatch keeps the slots full without one serial claim round trip per task (ADR 0076). A claim
// reserves the slots it asks for, so claimed tasks never exceed the concurrency. With no claim in
// flight, any free slot starts one. While one is in flight, another starts only once the unreserved
// free slots reach the refill batch, so a busy worker claims in batches and its claims overlap.
//
// dispatch returns when the context ends, an execution fails, a claim fails, or maintenance fails.
// It first waits for every claim still in flight and launches the tasks those claims returned. It
// returns the executions still running and the first error; the caller drains the executions.
func (worker *Worker) dispatch(ctx context.Context, environment dispatchEnvironment) (int, error) {
	refillBatch := dispatchRefillBatch(worker.concurrency)
	claimResults := make(chan claimSettlement, worker.concurrency)
	active := 0
	reserved := 0
	claimsInFlight := 0
	consecutiveEmptyClaims := 0
	wakeVersion := 0
	notificationDelayPending := false
	stopping := false
	var firstError error
	// Set by a claim that found nothing to run. No claim starts until its deadline or a wake that
	// arrived after that claim started.
	var emptyWait *struct {
		deadline    time.Time
		wakeVersion int
	}
	maintenanceErrors := environment.maintenanceErrors
	waitTimer := time.NewTimer(time.Hour)
	stopTimer := func() {
		if !waitTimer.Stop() {
			select {
			case <-waitTimer.C:
			default:
			}
		}
	}
	stopTimer()
	defer stopTimer()

	pollDelay := func() time.Duration {
		return workerPollDelay(worker.pollInterval, consecutiveEmptyClaims, !environment.listening())
	}
	launch := func(task ClaimedTask) {
		worker.handlerSlots <- struct{}{}
		active++
		worker.activeSlots.Add(1)
		go func() {
			err := environment.execute(task)
			<-worker.handlerSlots
			worker.activeSlots.Add(-1)
			environment.executionResults <- err
		}()
	}
	startClaim := func(limit int) {
		reserved += limit
		claimsInFlight++
		delayed := notificationDelayPending
		notificationDelayPending = false
		startedVersion := wakeVersion
		go func() {
			settlement := claimSettlement{limit: limit, wakeVersion: startedVersion}
			if delayed {
				delay := time.NewTimer(time.Duration(pseudorand.Int64N(int64(notificationClaimDelay) + 1)))
				select {
				case <-ctx.Done():
					delay.Stop()
					settlement.skipped = true
				case <-delay.C:
					settlement.skipped = worker.remotelyPaused.Load()
				}
				if settlement.skipped {
					claimResults <- settlement
					return
				}
			}
			settlement.tasks, settlement.err = environment.claim(limit)
			claimResults <- settlement
		}()
	}
	settleClaim := func(settlement claimSettlement) {
		claimsInFlight--
		reserved -= settlement.limit
		if settlement.skipped {
			return
		}
		// A claim that claimed only task types this worker cannot run made no progress: every one
		// of them goes straight back to its queue. Counting it as empty backs off instead of
		// spinning on a task no worker in this release can run. The check runs before the launch,
		// so reading the handlers happens before any execution the claim starts.
		runnable := false
		for _, task := range settlement.tasks {
			if worker.handlers[task.Type] != nil {
				runnable = true
				break
			}
		}
		// A claimed task holds a lease, so it runs even when the loop is stopping or has failed.
		for _, task := range settlement.tasks {
			launch(task)
		}
		if settlement.err != nil {
			if firstError == nil && ctx.Err() == nil {
				firstError = settlement.err
			}
			// A claim that returned no task ends the run too. Otherwise a queue that fails every
			// claim would poll on forever without surfacing its error.
			stopping = true
			return
		}
		if runnable {
			consecutiveEmptyClaims = 0
			emptyWait = nil
			return
		}
		consecutiveEmptyClaims++
		if emptyWait == nil {
			emptyWait = &struct {
				deadline    time.Time
				wakeVersion int
			}{time.Now().Add(pollDelay()), settlement.wakeVersion}
		}
	}

	for !stopping {
		select {
		case <-ctx.Done():
			stopping = true
			continue
		default:
		}
		// A nil channel never fires, so the loop waits only on executions and claims.
		var wakeAfter <-chan time.Time
		if worker.remotelyPaused.Load() {
			// A paused worker starts no claim but keeps observing its executions and claims.
			resetTimer(waitTimer, pollDelay())
			wakeAfter = waitTimer.C
		} else {
			if emptyWait != nil {
				remaining := time.Until(emptyWait.deadline)
				if remaining <= 0 || wakeVersion != emptyWait.wakeVersion {
					emptyWait = nil
				} else {
					resetTimer(waitTimer, remaining)
					wakeAfter = waitTimer.C
				}
			}
			if emptyWait == nil {
				for {
					free := worker.concurrency - active - reserved
					if free <= 0 || (claimsInFlight > 0 && free < refillBatch) {
						break
					}
					startClaim(free)
				}
			}
		}

		select {
		case <-ctx.Done():
			stopping = true
		case err := <-maintenanceErrors:
			if err != nil {
				if firstError == nil && ctx.Err() == nil {
					firstError = err
				}
				stopping = true
			} else {
				maintenanceErrors = nil
			}
		case err := <-environment.executionResults:
			active--
			if err != nil {
				if firstError == nil {
					firstError = err
				}
				stopping = true
			}
		case settlement := <-claimResults:
			settleClaim(settlement)
		case <-wakeAfter:
		case <-environment.notificationWake:
			wakeVersion++
			notificationDelayPending = true
		case <-environment.registryWake:
		}
	}

	for claimsInFlight > 0 {
		settleClaim(<-claimResults)
	}
	return active, firstError
}

// RunOnce claims and processes at most one task.
func (worker *Worker) RunOnce(ctx context.Context) (bool, error) {
	worker.holdHeartbeats(ctx)
	defer worker.releaseHeartbeatConnection()
	releaseRun, err := worker.acquireRun(ctx)
	if err != nil {
		return false, err
	}
	defer releaseRun()
	if err := worker.compatibility.Assert(ctx); err != nil {
		return false, err
	}
	instanceID, ok := newUUID()
	if !ok {
		return false, errors.New(workerInstanceIDMessage)
	}
	worker.instanceID = instanceID
	worker.registered.Store(false)
	executor := NewPGXExecutor(worker.pool)
	worker.refreshRegistration(ctx, executor, false)
	defer worker.deregister(context.WithoutCancel(ctx), executor)
	if worker.remotelyPaused.Load() {
		return false, nil
	}
	if err := worker.runMaintenance(ctx); err != nil {
		return false, err
	}
	return worker.runOnce(ctx, executor)
}

func (worker *Worker) registrationLoop(ctx context.Context, executor Executor, wake chan<- struct{}) {
	if !worker.registryEnabled {
		return
	}
	ticker := time.NewTicker(worker.registryInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			before := worker.remotelyPaused.Load()
			worker.refreshRegistration(ctx, executor, worker.draining.Load())
			if before != worker.remotelyPaused.Load() {
				select {
				case wake <- struct{}{}:
				default:
				}
			}
		}
	}
}

func (worker *Worker) refreshRegistration(ctx context.Context, executor Executor, draining bool) {
	if !worker.registryEnabled {
		return
	}
	maintenanceMS := max(int(worker.maintenanceInterval/time.Millisecond), 100)
	rows, err := executor.Query(
		ctx,
		internalStatementRegistry[registerWorkerStatementName],
		worker.workerID,
		worker.instanceID,
		worker.hostname,
		os.Getpid(),
		worker.queues,
		worker.scheduleNamespaces,
		worker.concurrency,
		int(worker.leaseDuration/time.Millisecond),
		int(worker.heartbeatInterval/time.Millisecond),
		int(worker.pollInterval/time.Millisecond),
		maintenanceMS,
		max(int(worker.maintenanceRoutineInterval/time.Millisecond), 100),
		int(worker.registryInterval/time.Millisecond),
		int(worker.activeSlots.Load()),
		draining,
		ProtocolVersion,
		sdkLanguage,
		Version,
	)
	if err == nil && len(rows) != 1 {
		err = errors.New(invalidWorkerRegistrationResultMessage)
	}
	if err != nil {
		if worker.onRegistrationError != nil {
			worker.onRegistrationError(err)
		}
		return
	}
	paused, ok := rows[0][rowPausedField].(bool)
	if !ok {
		if worker.onRegistrationError != nil {
			worker.onRegistrationError(errors.New(invalidWorkerRegistrationResultMessage))
		}
		return
	}
	worker.remotelyPaused.Store(paused)
	worker.registered.Store(true)
}

func (worker *Worker) deregister(ctx context.Context, executor Executor) {
	if !worker.registryEnabled || !worker.registered.Swap(false) {
		return
	}
	_, _ = executor.Query(ctx, internalStatementRegistry[deregisterWorkerStatementName], worker.workerID)
}

func (worker *Worker) acquireRun(ctx context.Context) (func(), error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-worker.runPermit:
		return func() { worker.runPermit <- struct{}{} }, nil
	}
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
	executor := NewPGXExecutor(worker.pool)
	rows, err := executor.Query(
		ctx,
		internalStatementRegistry[tickStatementName],
		workerPromotionLimit,
		workerRecoveryLimit,
	)
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return errors.New(invalidMaintenanceResultMessage)
	}
	for _, row := range rows {
		phase, phaseOK := row[rowPhaseField].(string)
		skipped, skippedOK := row[rowSkippedLockField].(bool)
		if !phaseOK || !skippedOK {
			return errors.New(invalidMaintenanceResultMessage)
		}
		if skipped {
			continue
		}
		if row[rowErrorField] != nil {
			// tick_v1 reports a phase failure as data, and the next tick retries the phase. Returning
			// it would stop every worker in the fleet on one lock timeout.
			worker.logger.WarnContext(
				ctx,
				fmt.Sprintf(maintenancePhaseErrorFormat, phase, row[rowErrorField]),
				slog.String(maintenancePhaseAttribute, phase),
				slog.String(workerIDAttribute, worker.workerID),
			)
			continue
		}
		if phase == recoverMaintenancePhase {
			worker.recordRecovery(ctx, row)
		}
	}
	if len(worker.scheduleNamespaces) > 0 {
		if err := worker.fireDueSchedules(ctx, executor); err != nil {
			return err
		}
	}
	if !worker.dueForMaintenanceRoutines() {
		return nil
	}
	maintenance, err := executor.Query(
		ctx,
		internalStatementRegistry[runMaintenanceStatementName],
		time.Now(),
	)
	if err != nil {
		return err
	}
	for _, row := range maintenance {
		if _, ok := row[rowPhaseField].(string); !ok {
			return errors.New(invalidMaintenanceResultMessage)
		}
		if _, ok := row[rowSkippedLockField].(bool); !ok {
			return errors.New(invalidMaintenanceResultMessage)
		}
	}
	return nil
}

// dueForMaintenanceRoutines reports whether this pass offers the slow routines, and claims the
// offer when it does. The tick runs every second to bound dispatch latency, but ADR 0011 puts the
// routines on their own cadence because PostgreSQL decides which phase is due.
func (worker *Worker) dueForMaintenanceRoutines() bool {
	now := time.Now().UnixNano()
	last := worker.lastRoutineOffer.Load()
	if last != 0 && now-last < int64(worker.maintenanceRoutineInterval) {
		return false
	}
	return worker.lastRoutineOffer.CompareAndSwap(last, now)
}

func (worker *Worker) recordRecovery(ctx context.Context, row Row) {
	expired, expiredOK := integer(row[rowExpiredLeasesField])
	retried, retriedOK := integer(row[rowRetriedField])
	rowsAffected, rowsOK := integer(row[rowRowsAffectedField])
	if worker.metrics.enabled && expiredOK && expired > 0 {
		worker.metrics.expiredLeases.Add(ctx, int64(expired))
	}
	if worker.metrics.enabled && retriedOK && retried > 0 {
		worker.metrics.retried.Add(
			ctx,
			int64(retried),
			metric.WithAttributes(
				attribute.String(queueNameAttribute, telemetryUnknownValue),
				attribute.String(taskTypeAttribute, telemetryUnknownValue),
			),
		)
	}
	if rowsOK && rowsAffected > 0 {
		logWorkerEvent(
			ctx,
			worker.logger,
			slog.LevelInfo,
			leasesRecoveredEvent,
			leasesRecoveredLogMessage,
			func() []any {
				return []any{
					slog.Int(recoveryRowsAffectedAttribute, rowsAffected),
					slog.Int(recoveryExpiredLeasesAttribute, expired),
					slog.Int(recoveryRetriedAttribute, retried),
				}
			},
		)
	}
}

// A nil evaluation instant asks the database for its own clock, so schedules, budgets, and rate
// limits all advance on one clock rather than on this process's.
func (worker *Worker) fireDueSchedules(ctx context.Context, executor Executor) error {
	_, err := executor.Query(
		ctx,
		internalStatementRegistry[fireDueSchedulesStatementName],
		worker.scheduleNamespaces,
		nil,
		worker.scheduleCatchupLimit,
		worker.maintenanceInterval.Milliseconds(),
	)
	return err
}

func (worker *Worker) runOnce(ctx context.Context, executor Executor) (bool, error) {
	task, claimErr := worker.claimNext(context.WithoutCancel(ctx), executor)
	if task == nil {
		return false, claimErr
	}
	handler := worker.handlers[task.Type]
	var err error
	if handler == nil {
		err = worker.release(ctx, executor, *task)
	} else {
		err = worker.execute(ctx, executor, *task, handler)
	}
	// A pass that only handed its claim back made no progress: the task returns to its queue
	// untouched. Reporting it as processed would spin a caller's loop, and Run's own fill loop
	// already counts such a pass as empty for the poll backoff.
	processed := handler != nil
	if err != nil {
		return processed, err
	}
	return processed, claimErr
}

func (worker *Worker) claimNext(ctx context.Context, executor Executor) (*ClaimedTask, error) {
	tasks, err := worker.claimNextMany(ctx, executor, 1)
	if len(tasks) == 0 {
		return nil, err
	}
	return &tasks[0], err
}

// nextClaimQueue advances the round-robin cursor. Claims overlap, so the cursor is shared state.
func (worker *Worker) nextClaimQueue() string {
	worker.queueCursorMu.Lock()
	defer worker.queueCursorMu.Unlock()
	queue := worker.queues[worker.nextQueueIndex]
	worker.nextQueueIndex = (worker.nextQueueIndex + 1) % len(worker.queues)
	return queue
}

// claimNextMany fills up to limit slots from the configured queues in round-robin order.
// Promotion of due scheduled rows belongs to the maintenance tick, which every worker runs on
// its maintenance interval, so the claim path issues only claim_many_v1.
func (worker *Worker) claimNextMany(ctx context.Context, executor Executor, limit int) ([]ClaimedTask, error) {
	tasks := make([]ClaimedTask, 0, limit)
	for range worker.queues {
		queue := worker.nextClaimQueue()
		startedAt := time.Now()
		rows, err := executor.Query(
			ctx,
			protocolStatementRegistry[claimManyStatementName],
			queue,
			worker.workerID,
			limit-len(tasks),
			int(worker.leaseDuration/time.Millisecond),
		)
		if err != nil {
			return tasks, err
		}
		claimResult := telemetryEmptyValue
		if len(rows) > 0 {
			claimResult = telemetryClaimedValue
		}
		if worker.metrics.enabled {
			worker.metrics.claimDuration.Record(
				ctx,
				float64(time.Since(startedAt))/float64(time.Millisecond),
				metric.WithAttributes(
					attribute.String(queueNameAttribute, queue),
					attribute.String(claimResultAttribute, claimResult),
				),
			)
		}
		if len(rows) == 0 {
			continue
		}
		for _, row := range rows {
			task, err := claimedTask(row, queue)
			if err != nil {
				return tasks, err
			}
			task.claimSentAt = startedAt
			logWorkerEvent(
				ctx,
				worker.logger,
				slog.LevelDebug,
				taskClaimedEvent,
				taskClaimedLogMessage,
				func() []any { return taskLogAttributes(task, worker.workerID) },
			)
			if worker.metrics.enabled {
				worker.metrics.claimed.Add(ctx, 1, taskMetricOptions(task))
			}
			tasks = append(tasks, task)
		}
		if len(tasks) == limit {
			break
		}
	}
	return tasks, nil
}

type ownershipResult struct {
	status            ownershipStatus
	expirationSettled bool
	err               error
}

func (worker *Worker) execute(
	ctx context.Context,
	executor Executor,
	task ClaimedTask,
	handler Handler,
) (resultError error) {
	handlerParent, span := startHandlerSpan(ctx, task)
	outcome := handlerOutcomeUnknown
	startedAt := time.Now()
	logWorkerEvent(
		handlerParent,
		worker.logger,
		slog.LevelDebug,
		handlerStartedEvent,
		handlerStartedLogMessage,
		func() []any { return taskLogAttributes(task, worker.workerID) },
	)
	defer func() {
		finishHandlerSpan(span, outcome, resultError)
		worker.metrics.recordHandler(handlerParent, task, outcome, time.Since(startedAt))
		attributes := func() []any {
			return append(
				taskLogAttributes(task, worker.workerID),
				slog.String(handlerOutcomeAttribute, string(outcome)),
			)
		}
		logWorkerEvent(
			handlerParent,
			worker.logger,
			slog.LevelInfo,
			executionFinishedEvent,
			executionFinishedLogMessage,
			attributes,
		)
		logWorkerEvent(
			handlerParent,
			worker.logger,
			slog.LevelDebug,
			handlerFinishedEvent,
			handlerFinishedLogMessage,
			attributes,
		)
	}()
	// A lost lease ends this attempt only. Lease recovery already owns the task, so the worker
	// records lease_lost and keeps claiming instead of stopping Run.
	defer func() {
		if errors.Is(resultError, ErrStaleLease) || errors.Is(resultError, errExpirationNotDue) {
			if errors.Is(resultError, errExpirationNotDue) {
				worker.logger.WarnContext(
					handlerParent,
					expirationNotDueMessage,
					taskLogAttributes(task, worker.workerID)...,
				)
			}
			outcome = handlerOutcomeLeaseLost
			resultError = nil
		}
	}()
	cancelDeadline := func() {}
	if expiration, cause := ownershipExpiration(task); expiration != nil {
		handlerParent, cancelDeadline = context.WithDeadlineCause(handlerParent, *expiration, cause)
	}
	handlerContext, cancelHandler := context.WithCancelCause(handlerParent)
	stopOwnership, ownershipDone := worker.superviseOwnership(ctx, task, cancelHandler)
	durability := &HandlerContext{
		Task: task, context: handlerContext, cancel: cancelHandler, executor: executor,
		workerID: worker.workerID,
	}
	if task.payloadError != nil {
		handler = func(context.Context, any, *HandlerContext) (any, error) {
			return nil, fmt.Errorf(undecodablePayloadFormat, task.payloadError)
		}
	}
	result, handlerError := callHandler(task.Type, handler, handlerContext, task.Payload, durability)
	stopOwnership()
	ownership := <-ownershipDone
	cause := context.Cause(handlerContext)
	cancelHandler(nil)
	cancelDeadline()

	if ownership.err != nil {
		return ownership.err
	}
	if durability.suspended.Load() {
		outcome = handlerOutcomeSuspended
		return nil
	}
	if ownership.status == workerOwnershipCancelRequested {
		outcome = handlerOutcomeCanceled
		return worker.acknowledgeCancellation(ctx, executor, task)
	}
	if ownership.status == workerOwnershipDeadline {
		outcome = handlerOutcomeDeadlineExceeded
		if ownership.expirationSettled {
			return nil
		}
		return worker.settleExpiration(ctx, executor, task)
	}
	if ownership.status == workerOwnershipTimeout {
		outcome = handlerOutcomeTimeout
		if ownership.expirationSettled {
			return nil
		}
		return worker.settleExpiration(ctx, executor, task)
	}
	if ownership.status == workerOwnershipStale {
		outcome = handlerOutcomeLeaseLost
		return &StaleLeaseError{TaskID: task.ID}
	}
	if ownership.status == workerOwnershipNotDue {
		return errExpirationNotDue
	}
	if errors.Is(cause, ErrCancellationRequested) {
		outcome = handlerOutcomeCanceled
		return worker.acknowledgeCancellation(ctx, executor, task)
	}
	if errors.Is(cause, ErrDeadlineExceeded) {
		outcome = handlerOutcomeDeadlineExceeded
		return worker.settleExpiration(ctx, executor, task)
	}
	if errors.Is(cause, ErrExecutionTimeout) {
		outcome = handlerOutcomeTimeout
		return worker.settleExpiration(ctx, executor, task)
	}
	if errors.Is(cause, ErrLeaseLost) {
		outcome = handlerOutcomeLeaseLost
		return &StaleLeaseError{TaskID: task.ID}
	}
	if ctx.Err() != nil {
		outcome = handlerOutcomeCanceled
		return ctx.Err()
	}
	if handlerError != nil {
		span.RecordError(handlerTelemetryError(handlerError, task.RedactErrorDetails))
		span.SetStatus(codes.Error, handlerFailedSpanStatusMessage)
		state, err := worker.failWithState(ctx, executor, task, handlerError)
		if err != nil {
			return err
		}
		switch state {
		case workerFailureReady, workerFailureScheduled:
			outcome = handlerOutcomeRetry
		case workerFailureFailed:
			outcome = handlerOutcomeFailed
		case workerFailureCancelRequested:
			outcome = handlerOutcomeCanceled
		case workerFailureDeadline:
			outcome = handlerOutcomeDeadlineExceeded
		case workerFailureTimeout:
			outcome = handlerOutcomeTimeout
		default:
			outcome = handlerOutcomeLeaseLost
		}
		return nil
	}
	outcome = handlerOutcomeSucceeded
	if err := worker.complete(ctx, executor, task, result); errors.Is(err, ErrStaleLease) {
		outcome = handlerOutcomeLeaseLost
		return worker.reconcileRejectedSettlement(ctx, executor, task, err)
	} else {
		return err
	}
}

func callHandler(
	taskType string,
	handler Handler,
	ctx context.Context,
	payload any,
	durability *HandlerContext,
) (result any, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = newHandlerPanicError(workerHandlerPanicFormat, taskType, recovered)
		}
	}()
	return handler(ctx, payload, durability)
}

func (worker *Worker) superviseOwnership(
	ctx context.Context,
	task ClaimedTask,
	cancelHandler context.CancelCauseFunc,
) (func(), <-chan ownershipResult) {
	stop := make(chan struct{})
	done := make(chan ownershipResult, 1)
	member := &heartbeatMember{
		ctx: ctx, task: task, cancelHandler: cancelHandler, result: make(chan ownershipResult, 1),
		renewed: make(chan time.Time, 1),
	}
	worker.registerHeartbeat(member)
	go func() {
		defer worker.unregisterHeartbeat(member)
		expirationTimer, expirationCause := ownershipExpirationTimer(task)
		if expirationTimer != nil {
			defer expirationTimer.Stop()
		}
		// The lease watchdog ends this attempt once its last accepted renewal is a full lease old.
		// A heartbeat that never answers cannot report the loss, and by then a peer may own the
		// task, so the worker stops the handler on its own clock rather than on an answer.
		watchdog := time.NewTimer(worker.leaseFrom(task.claimSentAt))
		defer watchdog.Stop()
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
			case result := <-member.result:
				done <- result
				return
			case sentAt := <-member.renewed:
				resetTimer(watchdog, worker.leaseFrom(sentAt))
			case <-watchdog.C:
				cancelHandler(&LeaseLostError{TaskID: task.ID})
				worker.recordLeaseWatchdog(ctx, task)
				done <- ownershipResult{status: workerOwnershipStale}
				return
			case <-expiration:
				cancelHandler(expirationCause)
				// Leave the heartbeat batch first: expireOwnership can retry for a while, and this
				// goroutine does not read member.result until it returns.
				worker.unregisterHeartbeat(member)
				status, err := worker.expireOwnership(ctx, task)
				done <- ownershipResult{status: status, expirationSettled: err == nil, err: err}
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

// leaseFrom reports how long one lease granted at sentAt still has to run. A task claimed before
// this worker started measuring, such as one a caller built itself, gets a whole lease.
func (worker *Worker) leaseFrom(sentAt time.Time) time.Duration {
	if sentAt.IsZero() {
		return worker.leaseDuration
	}
	return max(time.Millisecond, time.Until(sentAt.Add(worker.leaseDuration)))
}

func (worker *Worker) recordLeaseWatchdog(ctx context.Context, task ClaimedTask) {
	logWorkerEvent(
		ctx, worker.logger, slog.LevelWarn, leaseWatchdogEvent, leaseWatchdogLogMessage,
		func() []any { return taskLogAttributes(task, worker.workerID) },
	)
}

// holdHeartbeats takes this worker's share of the heartbeat connection its pool lends, ahead of any
// handler that could exhaust the pool. A worker that opted out of the reservation heartbeats
// through the shared pool and holds nothing.
func (worker *Worker) holdHeartbeats(ctx context.Context) {
	if worker.sharedHeartbeats {
		return
	}
	worker.heartbeatMu.Lock()
	lease := worker.heartbeatLease
	if lease == nil {
		lease = holdHeartbeatConnection(worker.pool)
		worker.heartbeatLease = lease
	}
	worker.heartbeatMu.Unlock()
	lease.reserve(ctx, worker.heartbeatInterval)
}

func (worker *Worker) releaseHeartbeatConnection() {
	worker.heartbeatMu.Lock()
	lease := worker.heartbeatLease
	worker.heartbeatLease = nil
	worker.heartbeatMu.Unlock()
	if lease != nil {
		lease.release()
	}
}

func (worker *Worker) registerHeartbeat(member *heartbeatMember) {
	worker.heartbeatMu.Lock()
	defer worker.heartbeatMu.Unlock()
	worker.heartbeatMembers[member] = struct{}{}
	if worker.heartbeatRunning {
		return
	}
	worker.heartbeatRunning = true
	go worker.runHeartbeats()
}

// abandonHeartbeats drops every registered renewal at once. The tasks the abandoned handlers hold
// then expire on their own schedule, so PostgreSQL recovers them instead of watching a lease that
// no one intends to settle.
func (worker *Worker) abandonHeartbeats() {
	worker.heartbeatMu.Lock()
	worker.heartbeatMembers = make(map[*heartbeatMember]struct{})
	worker.heartbeatMu.Unlock()
	select {
	case worker.heartbeatWake <- struct{}{}:
	default:
	}
}

func (worker *Worker) unregisterHeartbeat(member *heartbeatMember) {
	worker.heartbeatMu.Lock()
	delete(worker.heartbeatMembers, member)
	empty := len(worker.heartbeatMembers) == 0
	worker.heartbeatMu.Unlock()
	if empty {
		select {
		case worker.heartbeatWake <- struct{}{}:
		default:
		}
	}
}

// registeredHeartbeats reports which of members are still registered, under one lock
// acquisition for the whole fan-out.
func (worker *Worker) registeredHeartbeats(members []*heartbeatMember) map[*heartbeatMember]bool {
	registered := make(map[*heartbeatMember]bool, len(members))
	worker.heartbeatMu.Lock()
	defer worker.heartbeatMu.Unlock()
	for _, member := range members {
		if _, ok := worker.heartbeatMembers[member]; ok {
			registered[member] = true
		}
	}
	return registered
}

func (worker *Worker) runHeartbeats() {
	timer := time.NewTimer(worker.heartbeatInterval)
	defer timer.Stop()
	for {
		select {
		case <-worker.heartbeatWake:
		case <-timer.C:
		}
		worker.heartbeatMu.Lock()
		members := make([]*heartbeatMember, 0, len(worker.heartbeatMembers))
		for member := range worker.heartbeatMembers {
			members = append(members, member)
		}
		if len(members) == 0 {
			worker.heartbeatRunning = false
			worker.heartbeatMu.Unlock()
			return
		}
		worker.heartbeatMu.Unlock()
		worker.refreshOwnershipMany(members)
		timer.Reset(worker.heartbeatInterval)
	}
}

func (worker *Worker) refreshOwnershipMany(members []*heartbeatMember) {
	type lease struct {
		TaskID     string `json:"taskId"`
		FenceToken string `json:"fenceToken"`
		LeaseMS    int    `json:"leaseMs"`
	}
	leaseMS := int(worker.leaseDuration / time.Millisecond)
	requests := make([]lease, 0, len(members))
	for _, member := range members {
		requests = append(requests, lease{
			TaskID: member.task.ID, FenceToken: strconv.FormatInt(member.task.FenceToken, 10),
			LeaseMS: leaseMS,
		})
	}
	payload, err := json.Marshal(requests)
	if err != nil {
		worker.deliverHeartbeatError(members, err)
		return
	}
	roundContext := context.WithoutCancel(members[0].ctx)
	worker.heartbeatMu.Lock()
	reserved := worker.heartbeatLease
	worker.heartbeatMu.Unlock()
	var rows []Row
	// The round is bounded by the heartbeat interval, so a statement that stalls cannot hold the
	// batch past the next round. Every attempt keeps running: its own watchdog decides when a
	// renewal is too old to trust.
	sentAt := time.Now()
	round := func(ctx context.Context, executor Executor) error {
		var roundError error
		rows, roundError = executor.Query(
			ctx,
			protocolStatementRegistry[heartbeatManyStatementName],
			worker.workerID,
			string(payload),
		)
		return roundError
	}
	if reserved == nil {
		queryContext, cancel := context.WithTimeout(roundContext, worker.heartbeatInterval)
		err = round(queryContext, NewPGXExecutor(worker.pool))
		cancel()
	} else {
		err = reserved.run(roundContext, worker.heartbeatInterval, round)
	}
	if err != nil {
		worker.logger.Warn(heartbeatRoundFailedLogMessage, errorLogField, err)
		return
	}
	statuses := make(map[string]ownershipStatus, len(rows))
	for _, row := range rows {
		status, parseErr := parseOwnershipStatusRow(row)
		if parseErr != nil {
			worker.deliverHeartbeatError(members, parseErr)
			return
		}
		statuses[stringValue(row[rowTaskIDField])] = status
	}
	registered := worker.registeredHeartbeats(members)
	for _, member := range members {
		if !registered[member] {
			continue
		}
		status := statuses[member.task.ID]
		if status == emptyString {
			status = workerOwnershipStale
		}
		if status == workerOwnershipAccepted {
			member.renew(sentAt)
			continue
		}
		member.cancelHandler(ownershipCause(member.task, status))
		worker.recordRejectedHeartbeat(member.ctx, member.task, status)
		member.deliver(ownershipResult{status: status})
	}
}

func (worker *Worker) deliverHeartbeatError(members []*heartbeatMember, err error) {
	worker.logger.Warn(heartbeatRoundFailedLogMessage, errorLogField, err)
}

func (worker *Worker) recordRejectedHeartbeat(
	ctx context.Context, task ClaimedTask, status ownershipStatus,
) {
	if worker.metrics.enabled {
		worker.metrics.heartbeatFailures.Add(
			ctx, 1,
			metric.WithAttributes(attribute.String(heartbeatStatusAttribute, string(status))),
		)
	}
	logWorkerEvent(
		ctx, worker.logger, slog.LevelInfo, heartbeatRejectedEvent, heartbeatRejectedLogMessage,
		func() []any {
			return append(taskLogAttributes(task, worker.workerID), slog.String(heartbeatStatusAttribute, string(status)))
		},
	)
}

func ownershipExpirationTimer(task ClaimedTask) (*time.Timer, error) {
	expiration, cause := ownershipExpiration(task)
	if expiration == nil {
		return nil, nil
	}
	return time.NewTimer(max(time.Millisecond, time.Until(expiration.Add(time.Millisecond)))), cause
}

func ownershipExpiration(task ClaimedTask) (*time.Time, error) {
	var expiration *time.Time
	var cause error
	if task.Deadline != nil {
		expiration = task.Deadline
		cause = &DeadlineExceededError{TaskID: task.ID}
	}
	if task.AttemptTimeout != nil && (expiration == nil || task.AttemptTimeout.Before(*expiration)) {
		expiration = task.AttemptTimeout
		cause = &ExecutionTimeoutError{TaskID: task.ID, Attempt: task.Attempt}
	}
	if expiration == nil {
		return nil, nil
	}
	return expiration, cause
}

func ownershipCause(task ClaimedTask, status ownershipStatus) error {
	switch status {
	case workerOwnershipCancelRequested:
		return &CancellationRequestedError{TaskID: task.ID}
	case workerOwnershipDeadline:
		return &DeadlineExceededError{TaskID: task.ID}
	case workerOwnershipTimeout:
		return &ExecutionTimeoutError{TaskID: task.ID, Attempt: task.Attempt}
	default:
		return &LeaseLostError{TaskID: task.ID}
	}
}

func (worker *Worker) expireOwnership(ctx context.Context, task ClaimedTask) (ownershipStatus, error) {
	deadline := time.Now().Add(expirationRetryBudget)
	for {
		rows, err := NewPGXExecutor(worker.pool).Query(
			ctx,
			protocolStatementRegistry[expireOwnedStatementName],
			worker.fencedLease(task).parameters()...,
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
	return parseOwnershipStatusRow(rows[0])
}

func parseOwnershipStatusRow(row Row) (ownershipStatus, error) {
	value, ok := row[rowStatusField].(string)
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

func (worker *Worker) acknowledgeCancellation(ctx context.Context, executor Executor, task ClaimedTask) error {
	accepted, err := worker.cancellationAccepted(ctx, executor, task)
	if err != nil {
		return err
	}
	if !accepted {
		return &StaleLeaseError{TaskID: task.ID}
	}
	return nil
}

func (worker *Worker) reconcileRejectedSettlement(
	ctx context.Context,
	executor Executor,
	task ClaimedTask,
	settlementError error,
) error {
	accepted, err := worker.cancellationAccepted(ctx, executor, task)
	if err != nil {
		return err
	}
	if accepted {
		return nil
	}
	status, err := worker.expireOwnership(ctx, task)
	if err != nil {
		return err
	}
	switch status {
	case workerOwnershipCancelRequested:
		return worker.acknowledgeCancellation(ctx, executor, task)
	case workerOwnershipDeadline, workerOwnershipTimeout:
		return nil
	default:
		return settlementError
	}
}

func (worker *Worker) settleExpiration(ctx context.Context, executor Executor, task ClaimedTask) error {
	status, err := worker.expireOwnership(ctx, task)
	if err != nil {
		return err
	}
	switch status {
	case workerOwnershipCancelRequested:
		return worker.acknowledgeCancellation(ctx, executor, task)
	case workerOwnershipDeadline, workerOwnershipTimeout:
		return nil
	case workerOwnershipStale:
		return &StaleLeaseError{TaskID: task.ID}
	default:
		return errExpirationNotDue
	}
}

func (worker *Worker) cancellationAccepted(
	ctx context.Context,
	executor Executor,
	task ClaimedTask,
) (bool, error) {
	rows, err := executor.Query(
		ctx,
		protocolStatementRegistry[acknowledgeCancelStatementName],
		worker.fencedLease(task).parameters()...,
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

func (worker *Worker) complete(ctx context.Context, executor Executor, task ClaimedTask, result any) error {
	encoded, err := json.Marshal(result)
	if err != nil {
		return worker.fail(ctx, executor, task, err)
	}
	var normalizedResult any
	if err := decodeContractJSON(encoded, &normalizedResult); err != nil {
		return worker.fail(ctx, executor, task, err)
	}
	if err := worker.validateResultContract(ctx, executor, task, normalizedResult); err != nil {
		return worker.fail(ctx, executor, task, err)
	}
	lease := worker.fencedLease(task)
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
		return &StaleLeaseError{TaskID: task.ID}
	}
	if worker.metrics.enabled {
		worker.metrics.completed.Add(ctx, 1, taskMetricOptions(task))
	}
	logWorkerEvent(
		ctx,
		worker.logger,
		slog.LevelInfo,
		taskCompletedEvent,
		taskCompletedLogMessage,
		func() []any { return taskLogAttributes(task, worker.workerID) },
	)
	return nil
}

func (worker *Worker) validateResultContract(
	ctx context.Context,
	executor Executor,
	task ClaimedTask,
	result any,
) error {
	if task.ContractVersion == nil {
		return nil
	}
	version := *task.ContractVersion
	key := task.Type + contractCacheSeparator + version + contractCacheSeparator + contractResultKind
	worker.contracts.mu.RLock()
	validator := worker.contracts.validators[key]
	worker.contracts.mu.RUnlock()
	if validator == nil {
		rows, err := executor.Query(
			ctx,
			protocolStatementRegistry[getContractDefinitionStatementName],
			task.Type,
			version,
		)
		if err != nil {
			return err
		}
		if len(rows) != 1 {
			return &TaskContractUnavailableError{TaskType: task.Type, Version: version}
		}
		document, err := contractDocument(rows[0][contractSchemaField])
		if err != nil {
			return err
		}
		validator, err = worker.contracts.validator(key, document[contractResultSchemaField])
		if err != nil {
			return err
		}
	}
	if err := validator.Validate(result); err != nil {
		return &TaskContractValidationError{TaskType: task.Type, Version: version, Kind: contractResultKind}
	}
	return nil
}

// release gives back a claim whose task type this worker has no handler for.
//
// A claim carries no task-type filter, so a worker can hold a task it cannot run. The attempt
// belongs to whichever worker reaches the handler, so PostgreSQL returns the task to its queue with
// current_attempt untouched instead of charging this worker's refusal to it. During a rolling
// deployment that is what keeps the old release from retrying away the new release's task types.
func (worker *Worker) release(ctx context.Context, executor Executor, task ClaimedTask) error {
	startedAt := time.Now()
	logWorkerEvent(
		ctx,
		worker.logger,
		slog.LevelWarn,
		handlerMissingEvent,
		handlerMissingLogMessage,
		func() []any { return taskLogAttributes(task, worker.workerID) },
	)
	lease := worker.fencedLease(task)
	rows, err := executor.Query(
		ctx,
		protocolStatementRegistry[releaseOwnedStatementName],
		lease.parameters()...,
	)
	if err != nil {
		return err
	}
	if len(rows) != 1 {
		return errors.New(invalidReleaseResultMessage)
	}
	status, ok := rows[0][rowStatusField].(string)
	if !ok {
		return errors.New(invalidReleaseResultMessage)
	}
	outcome := handlerOutcomeLeaseLost
	switch status {
	case workerReleaseReleased:
		outcome = handlerOutcomeReleased
	case workerFailureCancelRequested:
		outcome = handlerOutcomeCanceled
	case workerFailureDeadline:
		outcome = handlerOutcomeDeadlineExceeded
	case workerFailureTimeout:
		outcome = handlerOutcomeTimeout
	case workerFailureStale, workerReleaseNotDue:
	default:
		return fmt.Errorf(rejectedReleaseStatusFormat, status)
	}
	worker.metrics.recordHandler(ctx, task, outcome, time.Since(startedAt))
	logWorkerEvent(
		ctx,
		worker.logger,
		slog.LevelInfo,
		taskReleaseProcessedEvent,
		taskReleaseProcessedLogMessage,
		func() []any {
			return append(taskLogAttributes(task, worker.workerID), slog.String(releaseStatusAttribute, status))
		},
	)
	switch status {
	case workerFailureCancelRequested:
		return worker.acknowledgeCancellation(ctx, executor, task)
	case workerFailureStale:
		return worker.reconcileRejectedSettlement(
			ctx,
			executor,
			task,
			&StaleLeaseError{TaskID: task.ID},
		)
	}
	return nil
}

// retryDelayOverride reports the delay this attempt sends to fail_v1, in milliseconds. A worker
// without the option, or a callback that declines, sends nil and PostgreSQL applies the persisted
// retry policy.
func (worker *Worker) retryDelayOverride(task ClaimedTask) any {
	if worker.retryDelay == nil {
		return nil
	}
	delay := worker.retryDelay(task.Attempt, task)
	if delay == nil || *delay < 0 {
		return nil
	}
	return delay.Milliseconds()
}

func (worker *Worker) fail(ctx context.Context, executor Executor, task ClaimedTask, handlerError error) error {
	_, err := worker.failWithState(ctx, executor, task, handlerError)
	return err
}

func (worker *Worker) failWithState(
	ctx context.Context,
	executor Executor,
	task ClaimedTask,
	handlerError error,
) (string, error) {
	envelope := handlerErrorEnvelope(handlerError, task.RedactErrorDetails)
	encoded, err := json.Marshal(envelope)
	if err != nil {
		return emptyString, err
	}
	lease := worker.fencedLease(task)
	arguments := append(lease.parameters(), encoded, worker.retryDelayOverride(task))
	rows, err := executor.Query(ctx, protocolStatementRegistry[failStatementName], arguments...)
	if err != nil {
		return emptyString, err
	}
	if len(rows) != 1 {
		return emptyString, errors.New(invalidFailureResultMessage)
	}
	state, ok := rows[0][rowStateField].(string)
	if !ok {
		return emptyString, errors.New(invalidFailureResultMessage)
	}
	if worker.metrics.enabled {
		worker.metrics.failed.Add(
			ctx,
			1,
			metric.WithAttributes(
				attribute.String(queueNameAttribute, task.Queue),
				attribute.String(taskTypeAttribute, task.Type),
				attribute.String(attemptOutcomeAttribute, state),
			),
		)
		if state == workerFailureReady || state == workerFailureScheduled {
			worker.metrics.retried.Add(ctx, 1, taskMetricOptions(task))
		}
	}
	logWorkerEvent(
		ctx,
		worker.logger,
		slog.LevelInfo,
		taskFailureProcessedEvent,
		taskFailureProcessedLogMessage,
		func() []any {
			return append(taskLogAttributes(task, worker.workerID), slog.String(attemptOutcomeAttribute, state))
		},
	)
	switch state {
	case workerFailureReady, workerFailureScheduled, workerFailureFailed:
		return state, nil
	case workerFailureCancelRequested:
		return state, worker.acknowledgeCancellation(ctx, executor, task)
	case workerFailureDeadline, workerFailureTimeout:
		return state, nil
	case workerFailureStale:
		return state, worker.reconcileRejectedSettlement(
			ctx,
			executor,
			task,
			&StaleLeaseError{TaskID: task.ID},
		)
	default:
		return emptyString, fmt.Errorf(rejectedFailureStateFormat, state)
	}
}

func (worker *Worker) fencedLease(task ClaimedTask) fencedLease {
	return fencedLease{taskID: task.ID, workerID: worker.workerID, fenceToken: task.FenceToken}
}

func claimedTask(row Row, queue string) (ClaimedTask, error) {
	taskID, ok := uuidString(row[rowTaskIDField])
	if !ok {
		return ClaimedTask{}, errors.New(invalidClaimResultMessage)
	}
	taskType, ok := row[rowTaskTypeField].(string)
	if !ok || taskType == emptyString {
		return ClaimedTask{}, errors.New(invalidClaimResultMessage)
	}
	priority, priorityOK := integer(row[rowPriorityField])
	attempt, attemptOK := integer(row[rowAttemptField])
	maxAttempts, maxAttemptsOK := integer(row[rowMaxAttemptsField])
	resultMaxBytes, resultMaxBytesOK := integer(row[rowResultMaxBytesField])
	fenceToken, fenceOK := int64Value(row[rowFenceTokenField])
	leaseExpiresAt, leaseOK := row[rowLeaseExpiresAtField].(time.Time)
	if !priorityOK || !attemptOK || !maxAttemptsOK || !resultMaxBytesOK || !fenceOK || !leaseOK {
		return ClaimedTask{}, errors.New(invalidClaimResultMessage)
	}
	payload, payloadError := decodedJSON(row[rowPayloadField])
	task := ClaimedTask{
		ID: taskID, Queue: queue, Type: taskType, Priority: priority, Payload: payload,
		ResultMaxBytes: resultMaxBytes, RedactErrorDetails: row[rowRedactErrorDetailsField] == true,
		TraceContext: row[rowTraceContextField], Attempt: attempt, MaxAttempts: maxAttempts,
		FenceToken: fenceToken, LeaseExpiresAt: leaseExpiresAt, payloadError: payloadError,
	}
	if value, ok := row[rowContractVersionField].(string); ok {
		task.ContractVersion = &value
	}
	if value, ok := row[rowRetryPolicyField].(map[string]any); ok {
		task.RetryPolicy = value
	}
	if value, ok := row[rowDeadlineAtField].(time.Time); ok {
		task.Deadline = &value
	}
	if value, ok := int64Value(row[rowExecutionTimeoutMSField]); ok {
		task.ExecutionTimeout = time.Duration(value) * time.Millisecond
	}
	if value, ok := row[rowAttemptTimeoutAtField].(time.Time); ok {
		task.AttemptTimeout = &value
	}
	return task, nil
}

// decodedJSON reads a json or jsonb column. database/sql hands over the raw document as bytes,
// while pgx has already decoded it, so a string is a JSON string value and is returned as is.
func decodedJSON(value any) (any, error) {
	encoded, ok := value.([]byte)
	if !ok {
		return value, nil
	}
	var decoded any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		return nil, err
	}
	return decoded, nil
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

// ErrorNamer lets a handler error choose the name its failure envelope records.
//
// An operator groups failures by that name, so the name has to describe the failure rather than
// the value that carries it. Go attaches no name to an error, so a worker that published the
// concrete type would file every errors.New value under *errors.errorString and split one failure
// mode across buckets that mean nothing. Implement this interface to name a failure explicitly.
type ErrorNamer interface {
	error

	// ErrorName returns the name the envelope records. An empty name is ignored.
	ErrorName() string
}

// ErrorStacker lets a handler error attach a stack to its failure envelope.
//
// Go captures no stack when it creates an error, so an envelope carries one only when the error
// supplies it. A worker records a null stack otherwise.
type ErrorStacker interface {
	error

	// ErrorStack returns the stack the envelope records. An empty stack is ignored.
	ErrorStack() string
}

// HandlerPanicError reports a handler or batch handler that panicked.
//
// It carries the stack captured where the panic was recovered, so the envelope of a Go panic holds
// the same three fields as the envelope of a TypeScript or Python exception.
type HandlerPanicError struct {
	// TaskType is the task type whose handler panicked.
	TaskType string
	// Value is the value passed to panic.
	Value any
	// Stack is the stack captured at recovery.
	Stack string

	message string
}

func (err *HandlerPanicError) Error() string { return err.message }

// ErrorStack returns the stack captured where the panic was recovered.
func (err *HandlerPanicError) ErrorStack() string { return err.Stack }

func newHandlerPanicError(format string, taskType string, recovered any) *HandlerPanicError {
	return &HandlerPanicError{
		TaskType: taskType,
		Value:    recovered,
		Stack:    string(debug.Stack()),
		message:  fmt.Sprintf(format, taskType, recovered),
	}
}

// handlerErrorName resolves the name a failure envelope records for a handler error.
//
// An error that names itself through ErrorNamer wins, because only the error knows which failure
// it reports. An exported concrete type names itself next, which keeps a declared error type
// legible without asking every declaration to implement an interface. Everything else, including
// every errors.New and fmt.Errorf value, is the generic error TypeScript and Python also call
// "Error".
func handlerErrorName(err error) string {
	var namer ErrorNamer
	if errors.As(err, &namer) && namer.ErrorName() != emptyString {
		return namer.ErrorName()
	}
	if name := exportedErrorTypeName(err); name != emptyString {
		return name
	}
	return genericHandlerErrorName
}

// exportedErrorTypeName returns the declared name of an exported error type, or the empty string.
func exportedErrorTypeName(err error) string {
	value := reflect.TypeOf(err)
	for value != nil && value.Kind() == reflect.Pointer {
		value = value.Elem()
	}
	if value == nil {
		return emptyString
	}
	name := value.Name()
	if name == emptyString || !unicode.IsUpper([]rune(name)[0]) {
		return emptyString
	}
	return name
}

// handlerErrorStack returns the stack an error supplies, or nil when it supplies none.
func handlerErrorStack(err error) any {
	var stacker ErrorStacker
	if errors.As(err, &stacker) && stacker.ErrorStack() != emptyString {
		return stacker.ErrorStack()
	}
	return nil
}

// handlerErrorEnvelope renders the failure envelope PostgreSQL stores for a handler error.
//
// A redacted envelope carries the two fields redact_error_details_v1 writes, so a worker that
// redacts locally produces exactly what PostgreSQL would have produced. Every other envelope
// carries the name, the message, and a stack that is null when the error supplies none.
func handlerErrorEnvelope(err error, redact bool) map[string]any {
	if redact {
		return map[string]any{errorNameField: redactedHandlerErrorNameValue, errorMessageField: redactedHandlerErrorTextValue}
	}
	return map[string]any{
		errorNameField:    handlerErrorName(err),
		errorMessageField: err.Error(),
		errorStackField:   handlerErrorStack(err),
	}
}

// workerHostname resolves the process hostname once per worker; registration reports it on
// every registry interval.
func workerHostname() string {
	hostname, err := os.Hostname()
	if err != nil || hostname == emptyString {
		return defaultWorkerName
	}
	return hostname
}

func defaultWorkerID() string {
	hostname := workerHostname()
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return fmt.Sprintf(workerIDFallbackFormat, hostname, os.Getpid())
	}
	return fmt.Sprintf(workerIDFormat, hostname, os.Getpid(), hex.EncodeToString(suffix[:]))
}
