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
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
)

// minimumDefaultHeartbeat is the smallest default heartbeat interval. It is the smallest supported
// interval in every SDK.
const minimumDefaultHeartbeat = 100 * time.Millisecond

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
	// minimumStartupBudget is the least time a worker with a dedicated heartbeat connection gives its
	// startup: the reservation and the compatibility check together. Startup owns no lease, so the
	// heartbeat interval alone is too short. The floor is a design choice (ADR 0071).
	minimumStartupBudget = 5 * time.Second
	// deregistrationTimeout bounds the last statement a stopping worker issues.
	deregistrationTimeout = time.Second
	// A worker that subscribes to task notifications polls only as a fallback, so it waits the
	// ceiling between empty claims. A worker that cannot subscribe starts at the shorter interval
	// and backs off toward the same ceiling.
	defaultNotificationPollInterval = maximumEmptyPollInterval
	// A queue whose fast claim was refused is claimed through claim_many_v1 for this long before
	// the worker tries the fast claim again, so a tier change reaches running workers.
	fastTierProbeInterval = 30 * time.Second
	// completionBatchLimit bounds both the completions one complete_many_and_claim_v1 call settles
	// and the tasks it claims, which is the statement's own per-call limit.
	completionBatchLimit = 100
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
	// fastTier marks a task claimed from a fast-tier queue. Its handler context rejects durable
	// features, and its completion goes through the batched statement.
	fastTier bool
	// slot is the dispatch slot the task runs in. It is nil outside Run's dispatch loop.
	slot *dispatchSlot
}

// Handler processes one claimed payload with fenced durable operations outside a transaction.
type Handler func(context.Context, any, *HandlerContext) (any, error)

// WorkerOptions configures a bounded worker with notification-assisted polling.
type WorkerOptions struct {
	Queue         string
	Queues        []string
	WorkerID      string
	Concurrency   int
	LeaseDuration time.Duration
	// HeartbeatInterval defaults to the larger of 100 ms and a third of LeaseDuration, and it must
	// be shorter than LeaseDuration. The smallest supported value is 100 ms. The worker accepts a
	// shorter value, but on a loaded host it can renew no lease.
	HeartbeatInterval   time.Duration
	PollInterval        time.Duration
	MaintenanceInterval time.Duration
	// MaintenanceRoutineInterval bounds how often this worker offers the slow retention routines
	// to PostgreSQL. It defaults to one minute and never runs faster than MaintenanceInterval.
	MaintenanceRoutineInterval time.Duration
	RegistryInterval           time.Duration
	// DisableRegistry skips registration, so operator surfaces neither see nor pause this worker.
	// An unregistered worker does not shorten the expired-lease scan spacing, which follows the
	// shortest maintenance interval among live registered workers. While any are live, an expired
	// lease can wait up to that interval for recovery.
	DisableRegistry      bool
	ScheduleNamespaces   []string
	ScheduleCatchupLimit int
	ShutdownGracePeriod  time.Duration
	PollingOnly          bool
	// SharedHeartbeats opts out of the dedicated heartbeat connection reservation. Without it, Run
	// and RunOnce refuse to start unless the pool lends the heartbeat connection and then one more
	// connection for the compatibility check within the larger of HeartbeatInterval and 5 s, and
	// the worker claims no task while the pool holds no heartbeat connection.
	SharedHeartbeats bool
	// Cohorts splits the slots into fixed shares for fast-tier dispatch (ADR 0076). It takes 1
	// through Concurrency. Zero selects the default: one cohort below concurrency 8, otherwise one
	// per 8 slots between 2 and 8, and never more than the pool connections the worker leaves spare.
	Cohorts             int
	Logger              *slog.Logger
	OnRegistrationError func(error)
	// RetryDelay overrides the delay the persisted retry policy would choose, for one failed
	// attempt. It returns nil to leave the choice to the policy, which is what a worker without
	// this option always does.
	RetryDelay func(attempt int, task ClaimedTask) *time.Duration
}

// Worker claims and settles tasks through a caller-owned pool.
type Worker struct {
	pool           *pgxpool.Pool
	queues         []string
	queueCursorMu  sync.Mutex
	nextQueueIndex int
	// fullTierUntil holds, per queue, when the worker next tries a fast claim after PostgreSQL
	// refused one. fullTierMu guards it because claims overlap.
	fullTierMu    sync.Mutex
	fullTierUntil map[string]time.Time
	// fastTierQueues holds the queues whose last claim PostgreSQL answered on the fast tier.
	fastTierQueues    map[string]struct{}
	workerID          string
	concurrency       int
	cohorts           int
	leaseDuration     time.Duration
	heartbeatInterval time.Duration
	// heartbeatRoundBound is the deadline of one heartbeat round (heartbeatRoundBoundFor). Rounds
	// start on a fixed schedule, so after one timed-out round the next round still ends before the
	// lease when 2 × heartbeatInterval + heartbeatRoundBound < leaseDuration, as with the defaults.
	heartbeatRoundBound time.Duration
	// startupBudget is max(heartbeatInterval, minimumStartupBudget). Run and RunOnce reserve the
	// heartbeat connection and run the compatibility check inside it.
	startupBudget       time.Duration
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
	// heartbeatRound sends the heartbeat statements of one round and returns the status of each
	// member, in the order of members. It is queryHeartbeatRound outside tests.
	heartbeatRound func(members []*heartbeatMember, deadline time.Time) ([]ownershipStatus, error)
	completions    completionBatcher
	// claimConnection is holdClaimConnection outside tests. A claim and a fused completion take
	// their connection through it before they read the claim gate.
	claimConnection func(ctx context.Context, executor Executor) (Executor, func(), error)
	// slotsMu guards the count of each runSlots and the move of that count to endedRunSlots.
	slotsMu sync.Mutex
	// endedRunSlots counts the handler slots that executions of an ended run still hold. A later
	// run subtracts them from its free slots, so the handlers of all runs stay within the
	// concurrency. endedRunSlotFreed wakes the dispatch loop when one of these slots is free.
	endedRunSlots     atomic.Int64
	endedRunSlotFreed chan struct{}
}

type heartbeatMember struct {
	ctx           context.Context
	task          ClaimedTask
	cancelHandler context.CancelCauseFunc
	result        chan ownershipResult
	renewed       chan time.Time
	// leaseEnd is the end of the attempt's local lease window, which the supervising goroutine
	// moves on each accepted renewal. A busy retry never runs past it. Write it only through
	// publishLeaseEnd.
	leaseEnd atomic.Pointer[time.Time]
}

// publishLeaseEnd stores a new copy of end for the heartbeat loop to read. A published value never
// changes, so the loop can read it while the supervising goroutine applies a later renewal.
func (member *heartbeatMember) publishLeaseEnd(end time.Time) {
	member.leaseEnd.Store(&end)
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
		// The default never goes below the smallest supported interval, as in every SDK.
		heartbeatInterval = max(minimumDefaultHeartbeat, leaseDuration/3/time.Millisecond*time.Millisecond)
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
	cohorts := options.Cohorts
	if cohorts == 0 {
		// The listener and the dedicated heartbeat connection each hold one pooled connection.
		spare := int(pool.Config().MaxConns)
		if !options.PollingOnly {
			spare--
		}
		if !options.SharedHeartbeats {
			spare--
		}
		cohorts = defaultDispatchCohorts(concurrency, spare)
	}
	if cohorts < 1 || cohorts > concurrency {
		return nil, errors.New(workerCohortsRangeMessage)
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
	worker := &Worker{
		pool:                       pool,
		queues:                     uniqueQueues,
		workerID:                   workerID,
		concurrency:                concurrency,
		cohorts:                    cohorts,
		leaseDuration:              leaseDuration,
		heartbeatInterval:          heartbeatInterval,
		heartbeatRoundBound:        heartbeatRoundBoundFor(heartbeatInterval),
		startupBudget:              max(heartbeatInterval, minimumStartupBudget),
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
		endedRunSlotFreed:          make(chan struct{}, 1),
		handlers:                   make(map[string]Handler),
		compatibility:              NewCachedCompatibilityCheck(NewPGXExecutor(pool)),
		onRegistrationError:        options.OnRegistrationError,
		retryDelay:                 options.RetryDelay,
		contracts:                  newContractCache(),
		heartbeatMembers:           make(map[*heartbeatMember]struct{}),
		heartbeatWake:              make(chan struct{}, 1),
		sharedHeartbeats:           options.SharedHeartbeats,
	}
	worker.heartbeatRound = worker.queryHeartbeatRound
	worker.claimConnection = holdClaimConnection
	return worker, nil
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
// Without SharedHeartbeats, Run first reserves the heartbeat connection and runs the compatibility
// check inside the startup budget, and it returns an error if either step fails.
func (worker *Worker) Run(ctx context.Context) error {
	releaseRun, err := worker.acquireRun(ctx)
	if err != nil {
		if ctx.Err() != nil {
			return nil
		}
		return err
	}
	defer releaseRun()
	worker.holdHeartbeats()
	defer worker.releaseHeartbeatConnection()
	if err := worker.prepareStart(ctx); err != nil {
		return err
	}
	heartbeatWake := make(chan struct{}, 1)
	worker.watchHeartbeats(func() { wakeWorker(heartbeatWake) })
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
	notificationWake := make(chan struct{}, 1)
	// Every worker on the pool shares one listener connection. The subscription ends when the run's
	// context does, so a stopped worker no longer holds a share while it drains.
	notifications := subscribeToTaskNotifications(
		ctx, worker.pool, worker.queues, worker.pollingOnly, worker.logger, notificationWake,
	)
	stopNotificationsAtCancel := context.AfterFunc(ctx, notifications.close)
	// stopDeadline is the grace period plus the handler unwind window, from the start of the grace.
	// No step of the stop path waits past it. startGrace sets it before Run returns.
	var stopDeadline time.Time
	defer func() {
		stopNotificationsAtCancel()
		// The last subscriber stops the listener, which can wait for its UNLISTEN. That wait ends
		// at the stop deadline; the listener then returns its connection on its own.
		closed := make(chan struct{})
		go func() {
			notifications.close()
			close(closed)
		}()
		deadline := time.NewTimer(max(0, time.Until(stopDeadline)))
		defer deadline.Stop()
		select {
		case <-closed:
		case <-deadline.C:
		}
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
	// The grace period starts when the run stops, not when the claims in flight settle. Every
	// shutdown step that needs a pooled connection waits on drainContext, so handlers that hold the
	// whole pool cannot hold Run past its deadline.
	drainContext, expireDrain := context.WithCancel(context.WithoutCancel(ctx))
	defer expireDrain()
	var graceStart sync.Once
	var graceTimer *time.Timer
	startGrace := func() {
		graceStart.Do(func() {
			stopDeadline = time.Now().Add(worker.shutdownGracePeriod + handlerUnwindPeriod)
			graceTimer = time.AfterFunc(worker.shutdownGracePeriod, expireDrain)
		})
	}
	defer func() {
		graceStart.Do(func() {})
		if graceTimer != nil {
			graceTimer.Stop()
		}
	}()
	runDone := make(chan struct{})
	defer close(runDone)
	go func() {
		select {
		case <-ctx.Done():
			startGrace()
		case <-runDone:
		}
	}()
	// A fused completion claims through its execution's context, so the deadline cancels the
	// executions as well. Otherwise dispatch could wait on a completion claim that waits on the pool.
	stopExecutionsAtDeadline := context.AfterFunc(drainContext, cancelExecutions)
	defer stopExecutionsAtDeadline()
	// A fused completion hands its slot to a replacement before its execution ends, so up to twice
	// the concurrency of executions can finish at once.
	executionResults := make(chan executionResult, 2*worker.concurrency)
	active, firstError := worker.dispatch(ctx, dispatchEnvironment{
		// A claim may commit tasks before a later queue fails. The claim must finish even when the
		// run context is cancelled, and every task it returned still needs to be executed before the
		// error is surfaced. The drain deadline still ends it: a lease it committed but never
		// returned expires on its own (ADR 0076).
		claim: func(limit int, fastLimit int) ([]ClaimedTask, error) {
			return worker.claimNextMany(drainContext, executor, limit, fastLimit)
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
		listening:         notifications.isListening,
		claimable:         worker.heartbeatReady,
		heartbeatWake:     heartbeatWake,
		// A maintenance, claim, or execution error stops the run while the caller's context is
		// still live. The grace period starts then, so a stalled claim cannot hold the settlement.
		stopped:    startGrace,
		graceEnded: drainContext.Done(),
	})

	startGrace()
	worker.draining.Store(true)
	worker.refreshRegistration(drainContext, executor, true)
	stopMaintenance()
	abandoned, firstError := worker.drainExecutions(
		drainContext, executionResults, active, firstError, cancelExecutions,
	)
	stopRegistry()
	<-registryDone
	deregisterContext, cancelDeregister := context.WithDeadline(context.WithoutCancel(ctx), stopDeadline)
	worker.deregister(deregisterContext, executor)
	cancelDeregister()
	if abandoned > 0 {
		incomplete := fmt.Errorf(workerShutdownIncompleteFormat, ErrShutdownIncomplete, abandoned)
		if firstError == nil {
			return incomplete
		}
		return errors.Join(firstError, incomplete)
	}
	return firstError
}

// drainExecutions waits for the active executions to settle. The grace period is the time a handler
// gets to finish on its own. After it, drainExecutions cancels the executions, gives the cancelled
// handlers one short window to unwind, then abandons whatever still runs so Run always returns.
// It returns how many executions it abandoned and the first error a settled execution reported.
func (worker *Worker) drainExecutions(
	drainContext context.Context,
	executionResults <-chan executionResult,
	active int,
	firstError error,
	cancelExecutions context.CancelFunc,
) (int, error) {
	for active > 0 {
		select {
		case result := <-executionResults:
			active--
			// The deadline cancels the executions as soon as the grace period ends, possibly
			// before this loop observes it. A cancellation the deadline caused is part of the
			// unwind, not an error of the run.
			cancelledByDeadline := drainContext.Err() != nil && errors.Is(result.err, context.Canceled)
			if result.err != nil && firstError == nil && !cancelledByDeadline {
				firstError = result.err
			}
			continue
		case <-drainContext.Done():
		}
		break
	}
	if active == 0 {
		return 0, firstError
	}
	cancelExecutions()
	unwindTimer := time.NewTimer(handlerUnwindPeriod)
	defer unwindTimer.Stop()
	for active > 0 {
		select {
		case <-executionResults:
			active--
		case <-unwindTimer.C:
			// An abandoned handler keeps running inside the caller's process and settles its own
			// task. Its lease renewal stops here, so a handler that never returns leaves a lease
			// PostgreSQL recovers, which is what a worker process that exits at its deadline
			// leaves behind too.
			worker.abandonHeartbeats()
			return active, firstError
		}
	}
	return 0, firstError
}

// dispatchRefillBatch is how many free slots let a second claim start while one is in flight: a
// quarter of the concurrency, rounded up.
func dispatchRefillBatch(concurrency int) int {
	return (concurrency + 3) / 4
}

// defaultDispatchCohorts is the cohort count a worker without a Cohorts option uses (ADR 0076). It
// keeps one pooled connection per cohort after the listener and the heartbeat take theirs.
func defaultDispatchCohorts(concurrency int, spareConnections int) int {
	cohorts := 1
	if concurrency >= 8 {
		cohorts = min(8, max(2, (concurrency+7)/8))
	}
	return max(1, min(cohorts, spareConnections))
}

// dispatchEnvironment carries what the dispatch loop needs from Run. A test replaces the claim and
// the execution with fakes and drives the loop without PostgreSQL.
type dispatchEnvironment struct {
	claim             func(limit int, fastLimit int) ([]ClaimedTask, error)
	execute           func(task ClaimedTask) error
	executionResults  chan executionResult
	notificationWake  <-chan struct{}
	registryWake      <-chan struct{}
	maintenanceErrors <-chan error
	listening         func() bool
	// claimable reports whether the worker may claim now: a worker with a dedicated heartbeat
	// connection claims only while it holds that connection (ADR 0071). Nil always allows claims.
	claimable func() bool
	// heartbeatWake fires when the heartbeat connection arrives again, so a closed gate opens at once.
	heartbeatWake <-chan struct{}
	// claimSettled runs in the loop for each claim it settles, with whether the claim was skipped.
	// A test waits on it to order its events. Nil runs nothing.
	claimSettled func(skipped bool)
	// notificationDelay draws the delay before a claim that a notification woke from idle. Nil
	// draws a random delay up to notificationClaimDelay.
	notificationDelay func() time.Duration
	// stopped runs once, when the loop stops and before it waits for the claims in flight. A claim
	// that waits on a lifecycle error's shutdown must see that the shutdown has started.
	stopped func()
	// graceEnded closes when the shutdown grace ends. Nil never closes.
	graceEnded <-chan struct{}
}

// executionResult is one finished execution and the slot it held.
type executionResult struct {
	slot *dispatchSlot
	err  error
}

// dispatchSlot is the slot one execution holds. The loop owns cohort and handedOver. released
// makes sure the handler slot returns exactly once: either the execution returns it when it ends,
// or the loop returns it early when the execution's fused completion claimed replacements.
//
// claimer belongs to the dispatch loop of the run that launched the execution. A fused completion
// asks only that loop for a reservation. After the run ends, that loop grants none, so an execution
// that outlived its run never reserves the slots of a later run of the same Worker.
type dispatchSlot struct {
	cohort     int
	claimer    *completionClaimer
	run        *runSlots
	handedOver bool
	released   atomic.Bool
}

// runSlots counts the handler slots that the executions of one dispatch loop hold. When the loop
// returns, endRun moves the count to Worker.endedRunSlots. An execution that outlives its run thus
// keeps its slot, and the next run of the same Worker starts no task in that slot.
type runSlots struct {
	held  int
	ended bool
}

func (worker *Worker) takeSlot(run *runSlots) {
	worker.slotsMu.Lock()
	run.held++
	worker.slotsMu.Unlock()
	worker.activeSlots.Add(1)
}

func (slot *dispatchSlot) release(worker *Worker) {
	if !slot.released.CompareAndSwap(false, true) {
		return
	}
	worker.activeSlots.Add(-1)
	worker.slotsMu.Lock()
	defer worker.slotsMu.Unlock()
	if !slot.run.ended {
		slot.run.held--
		return
	}
	worker.endedRunSlots.Add(-1)
	wakeWorker(worker.endedRunSlotFreed)
}

// endRun moves the slots that the executions of run still hold to endedRunSlots.
func (worker *Worker) endRun(run *runSlots) {
	worker.slotsMu.Lock()
	defer worker.slotsMu.Unlock()
	run.ended = true
	worker.endedRunSlots.Add(int64(run.held))
	run.held = 0
}

// claimSettlement is one finished claim. skipped reports a claim that was never sent because the
// worker stopped or paused during the notification delay. cohort is -1 for a claim for the whole
// worker; a cohort claim reserves cohortLimit slots in that cohort.
type claimSettlement struct {
	limit       int
	cohort      int
	cohortLimit int
	wakeVersion int
	skipped     bool
	tasks       []ClaimedTask
	err         error
}

// completionClaimer connects a fast-tier completion to the dispatch loop that owns the slots. An
// execution asks for a reservation before it writes its completion, and it settles the reservation
// with the tasks the fused claim returned.
type completionClaimer struct {
	requests    chan completionRequest
	settlements chan completionSettlement
	// done closes when the loop stops granting reservations.
	done chan struct{}
}

type completionRequest struct {
	slot  *dispatchSlot
	reply chan *completionReservation
}

// completionReservation is the slots the loop set aside for one fused completion claim: the
// completing task's own slot and the free slots of its cohort.
type completionReservation struct {
	claimer     *completionClaimer
	slot        *dispatchSlot
	limit       int
	cohort      int
	wakeVersion int
}

type completionSettlement struct {
	reservation *completionReservation
	tasks       []ClaimedTask
	// answered is false when the completion failed or fell back to complete_v1, so it says
	// nothing about the queue's backlog.
	answered bool
}

// reserve asks the loop for a fused claim. It returns nil when the task holds no slot of this loop,
// the loop has stopped, or the loop declines.
func (claimer *completionClaimer) reserve(task ClaimedTask) *completionReservation {
	if claimer == nil || task.slot == nil || task.slot.claimer != claimer {
		return nil
	}
	reply := make(chan *completionReservation, 1)
	select {
	case claimer.requests <- completionRequest{slot: task.slot, reply: reply}:
		return <-reply
	case <-claimer.done:
		return nil
	}
}

// settle hands the claimed tasks to the loop. The loop waits for every reservation it granted, so
// the send always finds a receiver.
func (reservation *completionReservation) settle(tasks []ClaimedTask, answered bool) {
	if reservation == nil {
		return
	}
	reservation.claimer.settlements <- completionSettlement{
		reservation: reservation,
		tasks:       tasks,
		answered:    answered,
	}
}

// dispatch keeps the slots full without one serial claim round trip per task (ADR 0076). A claim
// reserves the slots it asks for, so claimed tasks never exceed the concurrency. With no claim in
// flight, any free slot starts one. While one is in flight, another starts only once the unreserved
// free slots reach the refill batch, so a busy worker claims in batches and its claims overlap.
//
// Every task belongs to one cohort, a fixed share of the slots. A fast-tier completion batches only
// with its own cohort and claims replacements for only that cohort's slots. With more than one
// cohort and no full-tier queue, plain claims leave one at a time, each for one cohort. The cohorts'
// completion round trips then alternate, and one cohort's handlers run while another waits.
//
// dispatch returns when the context ends, an execution fails, a claim fails, or maintenance fails.
// It first waits for every claim and fused completion claim still in flight and launches the tasks
// they returned. It returns the executions still running and the first error; the caller drains
// the executions.
//
// The executions of an ended run of the same Worker keep their slots until they return. The free
// slots exclude them, so a claim never asks for a slot that a launch cannot take at once.
func (worker *Worker) dispatch(ctx context.Context, environment dispatchEnvironment) (int, error) {
	run := &runSlots{}
	// The caller drains the executions after the loop returns. Each later run counts their slots.
	defer worker.endRun(run)
	refillBatch := dispatchRefillBatch(worker.concurrency)
	cohorts := worker.cohorts
	// The first cohorts take the remainder of an uneven split.
	cohortCapacity := make([]int, cohorts)
	for cohort := range cohortCapacity {
		cohortCapacity[cohort] = worker.concurrency / cohorts
		if cohort < worker.concurrency%cohorts {
			cohortCapacity[cohort]++
		}
	}
	// Per-cohort counterparts of active, handedOver and reserved, and the plain claims in flight
	// for each cohort. A claim for the whole worker counts toward no cohort.
	cohortActive := make([]int, cohorts)
	cohortHandedOver := make([]int, cohorts)
	cohortReserved := make([]int, cohorts)
	cohortClaims := make([]int, cohorts)
	wholeClaims := 0
	claimResults := make(chan claimSettlement, worker.concurrency)
	claimer := &completionClaimer{
		requests:    make(chan completionRequest),
		settlements: make(chan completionSettlement),
		done:        make(chan struct{}),
	}
	active := 0
	// handedOver counts executions whose fused completion is in flight or claimed replacements:
	// their slots already belong to the reservation or to the replacements.
	handedOver := 0
	reserved := 0
	claimsInFlight := 0
	completionClaimsInFlight := 0
	consecutiveEmptyClaims := 0
	wakeVersion := 0
	notificationDelayPending := false
	// A short random delay spreads one notification's claims across workers.
	notificationDelay := environment.notificationDelay
	if notificationDelay == nil {
		notificationDelay = func() time.Duration {
			return time.Duration(pseudorand.Int64N(int64(notificationClaimDelay) + 1))
		}
	}
	stopping := false
	var firstError error
	// Set by a claim that found nothing to run. No claim starts until its deadline or a wake that
	// arrived after that claim started. A release wait follows a claim that released every task it
	// claimed. Each release notifies the queue, so a wake does not end that wait: only its
	// deadline, a stop, a pause, or the return of the heartbeat connection does.
	var emptyWait *struct {
		deadline    time.Time
		wakeVersion int
		release     bool
	}
	maintenanceErrors := environment.maintenanceErrors
	claimable := environment.claimable
	if claimable == nil {
		claimable = func() bool { return true }
	}
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
	freeSlots := func() int {
		// endedRunSlots only decreases while this loop runs, so an older value is safe.
		return worker.concurrency - int(worker.endedRunSlots.Load()) - active + handedOver - reserved
	}
	cohortFree := func(cohort int) int {
		return cohortCapacity[cohort] - cohortActive[cohort] + cohortHandedOver[cohort] - cohortReserved[cohort]
	}
	// The cohort with the most free slots, the first one on a tie.
	roomiestCohort := func() int {
		best := 0
		for cohort := 1; cohort < cohorts; cohort++ {
			if cohortFree(cohort) > cohortFree(best) {
				best = cohort
			}
		}
		return best
	}
	setEmptyWait := func(startedVersion int, release bool) {
		consecutiveEmptyClaims++
		if emptyWait == nil || (release && !emptyWait.release) {
			emptyWait = &struct {
				deadline    time.Time
				wakeVersion int
				release     bool
			}{time.Now().Add(pollDelay()), startedVersion, release}
		}
	}
	runnable := func(tasks []ClaimedTask) bool {
		for _, task := range tasks {
			if worker.handlers[task.Type] != nil {
				return true
			}
		}
		return false
	}
	// A task joins the cohort whose claim leased it. A claim for the whole worker, or one that
	// returned more tasks than its cohort has room for, spreads the rest over the roomiest cohorts.
	launch := func(task ClaimedTask, preferred int) {
		cohort := preferred
		if cohort < 0 || cohortFree(cohort) <= 0 {
			cohort = roomiestCohort()
		}
		slot := &dispatchSlot{cohort: cohort, claimer: claimer, run: run}
		task.slot = slot
		worker.takeSlot(run)
		active++
		cohortActive[cohort]++
		go func() {
			err := environment.execute(task)
			slot.release(worker)
			environment.executionResults <- executionResult{slot: slot, err: err}
		}()
	}
	observe := func(result executionResult) {
		active--
		cohortActive[result.slot.cohort]--
		if result.slot.handedOver {
			handedOver--
			cohortHandedOver[result.slot.cohort]--
		}
		if result.err != nil {
			if firstError == nil {
				firstError = result.err
			}
			stopping = true
		}
	}
	startClaim := func(limit int, cohort int, cohortLimit int) {
		reserved += limit
		if cohort < 0 {
			wholeClaims++
		} else {
			cohortClaims[cohort]++
			cohortReserved[cohort] += cohortLimit
		}
		claimsInFlight++
		// The notification delay spreads idle workers that one notification woke together. A worker
		// whose last claim found work would claim now anyway, so it claims without the delay.
		delayed := notificationDelayPending && consecutiveEmptyClaims > 0
		notificationDelayPending = false
		startedVersion := wakeVersion
		// A cohort claim takes only its cohort's share from a fast-tier queue.
		fastLimit := limit
		if cohort >= 0 {
			fastLimit = cohortLimit
		}
		go func() {
			settlement := claimSettlement{
				limit:       limit,
				cohort:      cohort,
				cohortLimit: cohortLimit,
				wakeVersion: startedVersion,
			}
			if delayed {
				delay := time.NewTimer(notificationDelay())
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
			// The gate can close between the start of the claim and its statement. A claim that
			// finds it closed is skipped, so it does not count as an empty claim.
			if !claimable() {
				settlement.skipped = true
				claimResults <- settlement
				return
			}
			settlement.tasks, settlement.err = environment.claim(limit, fastLimit)
			// The gate closed while the claim waited for its connection. Every task it already
			// claimed still runs, and the claim does not count as empty or failed.
			if errors.Is(settlement.err, errHeartbeatClaimGateClosed) {
				settlement.err = nil
				settlement.skipped = len(settlement.tasks) == 0
			}
			claimResults <- settlement
		}()
	}
	settleClaim := func(settlement claimSettlement) {
		claimsInFlight--
		reserved -= settlement.limit
		if settlement.cohort < 0 {
			wholeClaims--
		} else {
			cohortClaims[settlement.cohort]--
			cohortReserved[settlement.cohort] -= settlement.cohortLimit
		}
		if environment.claimSettled != nil {
			environment.claimSettled(settlement.skipped)
		}
		if settlement.skipped {
			return
		}
		// A claim that claimed only task types this worker cannot run made no progress: every one
		// of them goes straight back to its queue. Counting it as empty backs off instead of
		// spinning on a task no worker in this release can run. The check runs before the launch,
		// so reading the handlers happens before any execution the claim starts.
		progressed := runnable(settlement.tasks)
		// A claimed task holds a lease, so it runs even when the loop is stopping or has failed.
		for _, task := range settlement.tasks {
			launch(task, settlement.cohort)
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
		if progressed {
			consecutiveEmptyClaims = 0
			emptyWait = nil
			return
		}
		setEmptyWait(settlement.wakeVersion, len(settlement.tasks) > 0)
	}
	// The refill-batch rule applies to a fused claim as well: while a plain claim that can fill the
	// completing task's cohort is in flight, a completion claims only when that would fill at least
	// a refill batch of slots. A claim for another cohort does not hold a completion back.
	reserveCompletionClaim := func(slot *dispatchSlot) *completionReservation {
		// A slot of another run never changes this loop's counters.
		if slot.claimer != claimer {
			return nil
		}
		if stopping || firstError != nil || emptyWait != nil || worker.remotelyPaused.Load() || !claimable() {
			return nil
		}
		cohort := slot.cohort
		limit := min(freeSlots(), cohortFree(cohort)) + 1
		if (wholeClaims > 0 || cohortClaims[cohort] > 0) && limit < refillBatch {
			return nil
		}
		reserved += limit
		cohortReserved[cohort] += limit
		slot.handedOver = true
		handedOver++
		cohortHandedOver[cohort]++
		completionClaimsInFlight++
		return &completionReservation{
			claimer:     claimer,
			slot:        slot,
			limit:       limit,
			cohort:      cohort,
			wakeVersion: wakeVersion,
		}
	}
	settleCompletionClaim := func(settlement completionSettlement) {
		reservation := settlement.reservation
		completionClaimsInFlight--
		reserved -= reservation.limit
		cohortReserved[reservation.cohort] -= reservation.limit
		if len(settlement.tasks) > 0 {
			// The completing execution's slot now belongs to the first replacement.
			reservation.slot.release(worker)
		} else {
			reservation.slot.handedOver = false
			handedOver--
			cohortHandedOver[reservation.cohort]--
		}
		progressed := runnable(settlement.tasks)
		for _, task := range settlement.tasks {
			launch(task, reservation.cohort)
		}
		if progressed {
			consecutiveEmptyClaims = 0
		} else if settlement.answered && len(settlement.tasks) == 0 && len(worker.queues) == 1 {
			// Another queue may still have work, so only a single-queue worker backs off here.
			setEmptyWait(reservation.wakeVersion, false)
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
			// A paused worker starts no claim but keeps observing its executions and claims. A pause
			// ends the empty wait, so a resume claims at once. A release wait ignores the wake of the
			// resume, so it must end here.
			emptyWait = nil
			resetTimer(waitTimer, pollDelay())
			wakeAfter = waitTimer.C
		} else if claimable() {
			// Without the heartbeat connection, the loop starts no claim and waits for
			// heartbeatWake, an execution, or a claim in flight.
			if emptyWait != nil {
				remaining := time.Until(emptyWait.deadline)
				if remaining <= 0 || (!emptyWait.release && wakeVersion != emptyWait.wakeVersion) {
					emptyWait = nil
				} else {
					resetTimer(waitTimer, remaining)
					wakeAfter = waitTimer.C
				}
			}
			if emptyWait == nil {
				// Cohort claims need every queue to be fast tier, because only a fast-tier completion
				// refills its cohort. A worker with a full-tier queue keeps whole-worker claims.
				noFullTier, allFastTier := worker.tierState()
				if cohorts == 1 || !noFullTier {
					for {
						free := freeSlots()
						if free <= 0 || (claimsInFlight > 0 && free < refillBatch) {
							break
						}
						startClaim(free, -1, 0)
					}
				} else if free := freeSlots(); claimsInFlight == 0 && free > 0 {
					// One plain claim at a time: the next cohort's claim leaves when this one
					// returns, which starts the cohorts out of phase. A claim that still has to learn
					// a queue's tier reserves every free slot, so a full-tier answer claims them all.
					cohort := roomiestCohort()
					cohortLimit := min(free, cohortFree(cohort))
					limit := free
					if allFastTier {
						limit = cohortLimit
					}
					startClaim(limit, cohort, cohortLimit)
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
		case result := <-environment.executionResults:
			observe(result)
		case settlement := <-claimResults:
			settleClaim(settlement)
		case request := <-claimer.requests:
			request.reply <- reserveCompletionClaim(request.slot)
		case settlement := <-claimer.settlements:
			settleCompletionClaim(settlement)
		case <-wakeAfter:
		case <-environment.notificationWake:
			wakeVersion++
			notificationDelayPending = true
		case <-environment.heartbeatWake:
			// The heartbeat connection is back. Claims start now, not at the next poll.
			emptyWait = nil
		case <-worker.endedRunSlotFreed:
			// An execution of an ended run freed its slot. A claim for it starts now, not at the
			// next poll.
		case <-environment.registryWake:
		}
	}

	if environment.stopped != nil {
		environment.stopped()
	}
	// No reservation is granted from here on. Every claim and fused claim still in flight settles
	// first, so the executions the caller drains include every task they leased.
	close(claimer.done)
	graceEnded := environment.graceEnded
	for claimsInFlight > 0 || completionClaimsInFlight > 0 {
		select {
		case settlement := <-claimResults:
			settleClaim(settlement)
		case settlement := <-claimer.settlements:
			settleCompletionClaim(settlement)
		case request := <-claimer.requests:
			request.reply <- nil
		case <-graceEnded:
			// The grace ends their statements. The loop still waits until each one returns, so Run
			// keeps its hold on the heartbeat connection while a claim can still lease tasks.
			graceEnded = nil
			worker.logger.Warn(
				claimsOutlivedGraceLogMessage,
				claimsInFlightLogField, claimsInFlight,
				completionClaimsInFlightLogField, completionClaimsInFlight,
			)
		}
	}
	return active, firstError
}

// RunOnce claims and processes at most one task. It starts as Run does, and it claims nothing while
// the pool holds no heartbeat connection.
func (worker *Worker) RunOnce(ctx context.Context) (bool, error) {
	// The reservation is shared by the worker's invocations, so only the permit holder may take or
	// release it.
	releaseRun, err := worker.acquireRun(ctx)
	if err != nil {
		return false, err
	}
	defer releaseRun()
	worker.holdHeartbeats()
	defer worker.releaseHeartbeatConnection()
	if err := worker.prepareStart(ctx); err != nil {
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
	// A worker that cannot deregister in time ages out of the fleet view on its heartbeat window.
	deregisterContext, cancel := context.WithTimeout(ctx, deregistrationTimeout)
	defer cancel()
	_, _ = executor.Query(deregisterContext, internalStatementRegistry[deregisterWorkerStatementName], worker.workerID)
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
	if !worker.heartbeatReady() {
		return false, nil
	}
	// The executions of an ended run can hold every slot. Their handlers count toward the
	// concurrency, so RunOnce starts no other handler.
	if int(worker.endedRunSlots.Load()) >= worker.concurrency {
		return false, nil
	}
	task, claimErr := worker.claimNext(context.WithoutCancel(ctx), executor)
	if errors.Is(claimErr, errHeartbeatClaimGateClosed) {
		claimErr = nil
	}
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
	tasks, err := worker.claimNextMany(ctx, executor, 1, 1)
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

// claimNextMany fills up to limit slots from the configured queues in round-robin order. A
// fast-tier queue takes at most fastLimit of them, which is how a cohort claim stays within its
// cohort while a full-tier answer still fills every slot the claim reserved.
// Promotion of due scheduled rows belongs to the maintenance tick, which every worker runs on
// its maintenance interval, so the claim path issues only the claim statements.
func (worker *Worker) claimNextMany(
	ctx context.Context,
	executor Executor,
	limit int,
	fastLimit int,
) ([]ClaimedTask, error) {
	executor, release, err := worker.claimConnection(ctx, executor)
	if err != nil {
		return nil, err
	}
	defer release()
	tasks := make([]ClaimedTask, 0, limit)
	for range worker.queues {
		// The gate is read on the held connection, right before each claim statement, so a claim
		// that waited for the pool does not claim after the heartbeat connection went away.
		if !worker.heartbeatReady() {
			return tasks, errHeartbeatClaimGateClosed
		}
		queue := worker.nextClaimQueue()
		startedAt := time.Now()
		rows, fast, err := worker.claimQueue(ctx, executor, queue, limit-len(tasks), fastLimit-len(tasks))
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
		tasks, err = worker.appendClaimedTasks(ctx, tasks, rows, queue, startedAt, fast)
		if err != nil {
			return tasks, err
		}
		if len(tasks) == limit {
			break
		}
	}
	return tasks, nil
}

// appendClaimedTasks decodes claimed rows into tasks that carry when their claim was sent.
func (worker *Worker) appendClaimedTasks(
	ctx context.Context,
	tasks []ClaimedTask,
	rows []Row,
	queue string,
	sentAt time.Time,
	fast bool,
) ([]ClaimedTask, error) {
	for _, row := range rows {
		task, err := claimedTask(row, queue)
		if err != nil {
			return tasks, err
		}
		task.claimSentAt = sentAt
		task.fastTier = fast
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
	return tasks, nil
}

// writeCompletion records a success and reports whether the fence still held. A fast task completes
// through complete_many_and_claim_v1. Inside Run it joins the batch of its cohort, and the same
// statement claims replacements for the slots the dispatch loop reserved. If its queue left the fast
// tier after the claim, PostgreSQL refuses that statement and complete_v1 settles the task instead.
func (worker *Worker) writeCompletion(
	ctx context.Context,
	executor Executor,
	task ClaimedTask,
	encoded []byte,
) (bool, error) {
	if task.fastTier {
		accepted, err := worker.writeFastCompletion(ctx, executor, task, encoded)
		rejection := fastTierRejection(err)
		if rejection == nil || rejection.Feature != fastTierBatchedCompletionFeature {
			return accepted, err
		}
		worker.markFullTier(task.Queue)
	}
	arguments := append(worker.fencedLease(task).parameters(), encoded)
	rows, err := queryFencedWrite(ctx, executor, protocolStatementRegistry[completeStatementName], arguments...)
	if err != nil {
		return false, err
	}
	if len(rows) != 1 {
		return false, errors.New(invalidCompletionResultMessage)
	}
	accepted, ok := rows[0][rowAcceptedField].(bool)
	if !ok {
		return false, errors.New(invalidCompletionResultMessage)
	}
	return accepted, nil
}

func (worker *Worker) writeFastCompletion(
	ctx context.Context,
	executor Executor,
	task ClaimedTask,
	encoded []byte,
) (bool, error) {
	entry := &completionEntry{
		ctx:      ctx,
		executor: executor,
		task:     task,
		encoded:  encoded,
		answer:   make(chan completionAnswer, 1),
	}
	if task.slot == nil {
		// Outside Run the executor may be a caller's transaction, so the completion goes alone.
		worker.completeChunk(task.Queue, []*completionEntry{entry})
		answer := <-entry.answer
		return answer.accepted, answer.err
	}
	// Only the loop of the run that launched the task can reserve slots for its fused claim.
	reservation := task.slot.claimer.reserve(task)
	if reservation != nil {
		entry.limit = reservation.limit
	}
	key := completionBatchKey{queue: task.Queue, cohort: task.slot.cohort, claimer: task.slot.claimer}
	answer := worker.completions.submit(worker, key, entry)
	if answer.err != nil {
		reservation.settle(nil, false)
		return false, answer.err
	}
	tasks, err := worker.appendClaimedTasks(ctx, nil, answer.rows, task.Queue, answer.sentAt, true)
	// Every decoded task holds a lease, so it runs even when a later row failed to decode. A
	// statement that the closed gate held to a claim limit of 0 says nothing about the backlog.
	reservation.settle(tasks, entry.limit > 0)
	if err != nil {
		return false, err
	}
	return answer.accepted, nil
}

// completionBatcher groups the fast-tier completions that finish while an earlier batch of the same
// queue and cohort is in flight. One batch per key is in flight at a time, and the next one leaves
// when it returns. A completion that finds its key idle leaves at once, so batching adds no delay.
type completionBatcher struct {
	mu       sync.Mutex
	pending  map[completionBatchKey][]*completionEntry
	flushing map[completionBatchKey]bool
}

// completionBatchKey names one batch. claimer keeps the completions of each run in their own
// statements, so a completion that outlived its run cannot join, or fail, a later run's batch.
type completionBatchKey struct {
	queue   string
	cohort  int
	claimer *completionClaimer
}

type completionEntry struct {
	ctx      context.Context
	executor Executor
	task     ClaimedTask
	encoded  json.RawMessage
	// limit is how many tasks this entry's reservation lets the statement claim.
	limit  int
	answer chan completionAnswer
}

type completionAnswer struct {
	accepted bool
	rows     []Row
	sentAt   time.Time
	err      error
}

func (batcher *completionBatcher) submit(
	worker *Worker,
	key completionBatchKey,
	entry *completionEntry,
) completionAnswer {
	batcher.mu.Lock()
	if batcher.pending == nil {
		batcher.pending = make(map[completionBatchKey][]*completionEntry)
		batcher.flushing = make(map[completionBatchKey]bool)
	}
	batcher.pending[key] = append(batcher.pending[key], entry)
	start := !batcher.flushing[key]
	batcher.flushing[key] = true
	batcher.mu.Unlock()
	if start {
		go batcher.flush(worker, key)
	}
	return <-entry.answer
}

func (batcher *completionBatcher) flush(worker *Worker, key completionBatchKey) {
	for {
		batcher.mu.Lock()
		entries := batcher.pending[key]
		delete(batcher.pending, key)
		if len(entries) == 0 {
			delete(batcher.flushing, key)
			batcher.mu.Unlock()
			return
		}
		batcher.mu.Unlock()
		chunks := completionChunks(entries)
		var wait sync.WaitGroup
		for _, chunk := range chunks {
			wait.Add(1)
			go func() {
				defer wait.Done()
				worker.completeChunk(key.queue, chunk)
			}()
		}
		wait.Wait()
	}
}

// completionChunks splits a batch so no statement settles more than completionBatchLimit tasks or
// claims more than completionBatchLimit. An entry whose own limit exceeds the bound goes alone.
func completionChunks(entries []*completionEntry) [][]*completionEntry {
	var chunks [][]*completionEntry
	var chunk []*completionEntry
	limit := 0
	for _, entry := range entries {
		if len(chunk) > 0 && (len(chunk) == completionBatchLimit || limit+entry.limit > completionBatchLimit) {
			chunks = append(chunks, chunk)
			chunk, limit = nil, 0
		}
		chunk = append(chunk, entry)
		limit += entry.limit
	}
	return append(chunks, chunk)
}

// completeChunk runs one complete_many_and_claim_v1 statement and answers every entry in it. The
// claimed tasks go to the entries in order, each up to its own limit. A failed statement fails only
// its own entries.
//
// The chunk names its tasks in task ID order, as the heartbeat names its leases, so the two
// statements lock shared runtime rows in the same order. A plan that locks in another order can
// still deadlock. PostgreSQL then rolls back the whole statement, so queryFencedWrite sends the
// chunk again.
func (worker *Worker) completeChunk(queue string, chunk []*completionEntry) {
	slices.SortFunc(chunk, func(left, right *completionEntry) int {
		return strings.Compare(left.task.ID, right.task.ID)
	})
	ids := make([]string, len(chunk))
	fences := make([]int64, len(chunk))
	results := make([]json.RawMessage, len(chunk))
	limit := 0
	for _, entry := range chunk {
		limit += entry.limit
	}
	executor := chunk[0].executor
	if limit > 0 {
		// A chunk that claims holds its connection first, so the gate is read after the wait for
		// the pool and right before each attempt of the statement.
		held, release, err := worker.claimConnection(chunk[0].ctx, executor)
		if err != nil {
			for _, entry := range chunk {
				entry.answer <- completionAnswer{err: err}
			}
			return
		}
		defer release()
		executor = held
	}
	for index, entry := range chunk {
		ids[index] = entry.task.ID
		fences[index] = entry.task.FenceToken
		results[index] = entry.encoded
	}
	var sentAt time.Time
	rows, err := queryFencedWriteEach(
		chunk[0].ctx,
		executor,
		protocolStatementRegistry[completeManyAndClaimStatementName],
		func() ([]any, error) {
			// Without the heartbeat connection, this attempt and every later one settle the
			// chunk and claim nothing. The entries keep a limit of 0, so the dispatch loop
			// returns their reservations.
			if limit > 0 && !worker.heartbeatReady() {
				for _, entry := range chunk {
					entry.limit = 0
				}
				limit = 0
			}
			sentAt = time.Now()
			return []any{
				worker.workerID, ids, fences, results, queue, limit, int(worker.leaseDuration / time.Millisecond),
			}, nil
		},
	)
	var accepted []any
	if err == nil {
		ok := len(rows) > 0
		if ok {
			accepted, ok = rows[0][rowAcceptedField].([]any)
		}
		if !ok {
			err = errors.New(invalidCompletionResultMessage)
		}
	}
	if err != nil {
		for _, entry := range chunk {
			entry.answer <- completionAnswer{err: err}
		}
		return
	}
	acceptedIDs := make(map[string]struct{}, len(accepted))
	for _, id := range accepted {
		if id, ok := uuidString(id); ok {
			acceptedIDs[id] = struct{}{}
		}
	}
	claimed := claimedFastRows(rows)
	for _, entry := range chunk {
		take := min(entry.limit, len(claimed))
		_, isAccepted := acceptedIDs[entry.task.ID]
		entry.answer <- completionAnswer{
			accepted: isAccepted,
			rows:     claimed[:take:take],
			sentAt:   sentAt,
		}
		claimed = claimed[take:]
	}
}

// claimQueue claims from one queue. It tries the fast claim first, because only PostgreSQL knows a
// queue's tier. A refusal marks the queue as full tier until the next probe, and the worker then
// claims through claim_many_v1. A fast-tier queue takes at most fastLimit tasks.
func (worker *Worker) claimQueue(
	ctx context.Context,
	executor Executor,
	queue string,
	limit int,
	fastLimit int,
) ([]Row, bool, error) {
	leaseMS := int(worker.leaseDuration / time.Millisecond)
	if worker.probesFastTier(queue) {
		if fastLimit <= 0 {
			return nil, false, nil
		}
		rows, err := queryFencedWriteEach(
			ctx,
			executor,
			protocolStatementRegistry[completeManyAndClaimStatementName],
			func() ([]any, error) {
				if !worker.heartbeatReady() {
					return nil, errHeartbeatClaimGateClosed
				}
				return []any{
					worker.workerID, []string{}, []int64{}, []json.RawMessage{}, queue, min(limit, fastLimit), leaseMS,
				}, nil
			},
		)
		if err == nil {
			worker.markFastTier(queue)
			return claimedFastRows(rows), true, nil
		}
		if fastTierRejection(err) == nil {
			return nil, false, err
		}
		worker.markFullTier(queue)
	}
	// The fallback after a refused fast claim is a new statement, so it reads the gate again.
	if !worker.heartbeatReady() {
		return nil, false, errHeartbeatClaimGateClosed
	}
	rows, err := executor.Query(
		ctx,
		protocolStatementRegistry[claimManyStatementName],
		queue,
		worker.workerID,
		limit,
		leaseMS,
	)
	return rows, false, err
}

func (worker *Worker) probesFastTier(queue string) bool {
	worker.fullTierMu.Lock()
	defer worker.fullTierMu.Unlock()
	until, known := worker.fullTierUntil[queue]
	return !known || !time.Now().Before(until)
}

func (worker *Worker) markFullTier(queue string) {
	worker.fullTierMu.Lock()
	defer worker.fullTierMu.Unlock()
	if worker.fullTierUntil == nil {
		worker.fullTierUntil = make(map[string]time.Time)
	}
	worker.fullTierUntil[queue] = time.Now().Add(fastTierProbeInterval)
	delete(worker.fastTierQueues, queue)
}

func (worker *Worker) markFastTier(queue string) {
	worker.fullTierMu.Lock()
	defer worker.fullTierMu.Unlock()
	delete(worker.fullTierUntil, queue)
	if worker.fastTierQueues == nil {
		worker.fastTierQueues = make(map[string]struct{})
	}
	worker.fastTierQueues[queue] = struct{}{}
}

// tierState reports whether no queue is known to be full tier and whether every queue is known to
// be fast tier. Cohort claims need the first; a claim sized to one cohort needs the second.
func (worker *Worker) tierState() (noFullTier bool, allFastTier bool) {
	worker.fullTierMu.Lock()
	defer worker.fullTierMu.Unlock()
	return len(worker.fullTierUntil) == 0, len(worker.fastTierQueues) == len(worker.queues)
}

// claimedFastRows drops the placeholder row the batched statement returns when it claims nothing.
func claimedFastRows(rows []Row) []Row {
	claimed := rows[:0]
	for _, row := range rows {
		if row[rowTaskIDField] != nil {
			claimed = append(claimed, row)
		}
	}
	return claimed
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
	settledAfterShutdown := false
	defer func() {
		// The stop still ends execute with its error, but a settled task is not a failed span.
		spanError := resultError
		if settledAfterShutdown {
			spanError = nil
		}
		finishHandlerSpan(span, outcome, spanError)
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
	handlerReturned, releaseOwnership := worker.superviseOwnership(ctx, task, cancelHandler)
	// Renewal outlives the handler: result validation and the fenced final write can wait on the
	// pool past a whole lease, and a lapsed lease would hand the finished task to recovery.
	defer releaseOwnership()
	durability := &HandlerContext{
		Task: task, context: handlerContext, cancel: cancelHandler, executor: executor,
		contracts: &worker.contracts, compatibility: worker.compatibility, workerID: worker.workerID,
	}
	if task.payloadError != nil {
		handler = func(context.Context, any, *HandlerContext) (any, error) {
			return nil, fmt.Errorf(undecodablePayloadFormat, task.payloadError)
		}
	}
	result, handlerError := callHandler(task.Type, handler, handlerContext, task.Payload, durability)
	// Read before the supervisor settles, so a stop that lands after the handler returned cannot
	// turn the handler's own failure into a shutdown.
	cancelledAtReturn := context.Cause(handlerContext)
	ownership := handlerReturned()
	cause := context.Cause(handlerContext)
	cancelHandler(nil)
	cancelDeadline()

	// The stop is the end of Run, or of the context a caller passed to RunOnce. The supervisor
	// usually reports it first, as its ownership error. A handler that fails after the stop
	// cancelled it returns its task to the queue without an attempt, and a panic still fails the
	// attempt. A handler that returns a value once the stop has come completes its task, whether
	// it returned before or after its cancellation.
	var panicked *HandlerPanicError
	stoppedForShutdown := !durability.suspended.Load() && ctx.Err() != nil &&
		((handlerError == nil && cancelledAtReturn == nil) ||
			(cancelledAtReturn != nil && errors.Is(cancelledAtReturn, context.Cause(ctx)) &&
				!errors.As(handlerError, &panicked)))
	if ownership.err != nil {
		if stoppedForShutdown && errors.Is(ownership.err, ctx.Err()) {
			outcome = worker.settleAfterShutdown(ctx, executor, task, result, handlerError)
			settledAfterShutdown = outcome == handlerOutcomeSucceeded ||
				outcome == handlerOutcomeReleased
		}
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
		if stoppedForShutdown {
			outcome = worker.settleAfterShutdown(ctx, executor, task, result, handlerError)
			settledAfterShutdown = outcome == handlerOutcomeSucceeded ||
				outcome == handlerOutcomeReleased
		}
		return ctx.Err()
	}
	// A result the task cannot store fails the attempt like a handler error, so it settles under the
	// retry policy instead of reaching complete_v1, whose refusal would end Run.
	var encodedResult []byte
	if handlerError == nil {
		encodedResult, handlerError = worker.encodeResult(ctx, executor, task, result)
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
	if err := worker.complete(ctx, executor, task, encodedResult); errors.Is(err, ErrStaleLease) {
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

// superviseOwnership watches one attempt's lease. handlerReturned reports how ownership stood
// when the handler returned. An accepted lease keeps renewing after that, so the settlement that
// follows writes under a live lease. release ends the renewal and returns once the attempt has left the heartbeat batch.
//
// Once the handler has returned, a rejected renewal, a lapsed watchdog, or an expiry only stops
// renewing. The fenced settlement write then meets the same verdict in PostgreSQL and reconciles
// it, so the attempt still ends with one authoritative transition.
func (worker *Worker) superviseOwnership(
	ctx context.Context,
	task ClaimedTask,
	cancelHandler context.CancelCauseFunc,
) (handlerReturned func() ownershipResult, release func()) {
	returned := make(chan struct{})
	settled := make(chan struct{})
	done := make(chan ownershipResult, 1)
	exited := make(chan struct{})
	member := &heartbeatMember{
		ctx: ctx, task: task, cancelHandler: cancelHandler, result: make(chan ownershipResult, 1),
		renewed: make(chan time.Time, 1),
	}
	leaseEnd := worker.leaseEndFrom(task.claimSentAt)
	member.publishLeaseEnd(leaseEnd)
	worker.registerHeartbeat(member)
	go func() {
		defer close(exited)
		defer worker.unregisterHeartbeat(member)
		expirationTimer, expirationCause := ownershipExpirationTimer(task)
		if expirationTimer != nil {
			defer expirationTimer.Stop()
		}
		// The lease watchdog ends this attempt once its last accepted renewal is a full lease old.
		// A heartbeat that never answers cannot report the loss, and by then a peer may own the
		// task, so the worker stops the handler on its own clock rather than on an answer.
		watchdog := time.NewTimer(untilLeaseEnd(leaseEnd))
		defer watchdog.Stop()
		handlerRunning := true
		loseLease := func() {
			worker.recordLeaseWatchdog(ctx, task)
			if handlerRunning {
				cancelHandler(&LeaseLostError{TaskID: task.ID})
				done <- ownershipResult{status: workerOwnershipStale}
			}
		}
		for {
			var expiration <-chan time.Time
			if expirationTimer != nil {
				expiration = expirationTimer.C
			}
			awaitReturn := returned
			if !handlerRunning {
				awaitReturn = nil
			}
			select {
			case <-awaitReturn:
				handlerRunning = false
				done <- ownershipResult{status: workerOwnershipAccepted}
			case <-settled:
				return
			case <-ctx.Done():
				if handlerRunning {
					done <- ownershipResult{err: ctx.Err()}
				}
				return
			case result := <-member.result:
				if handlerRunning {
					done <- result
				}
				return
			case sentAt := <-member.renewed:
				// A renewal that arrives after the local window closed does not open it again.
				if !time.Now().Before(leaseEnd) {
					loseLease()
					return
				}
				leaseEnd = worker.leaseEndFrom(sentAt)
				member.publishLeaseEnd(leaseEnd)
				resetTimer(watchdog, untilLeaseEnd(leaseEnd))
			case <-watchdog.C:
				loseLease()
				return
			case <-expiration:
				if !handlerRunning {
					return
				}
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
	var returnOnce, releaseOnce sync.Once
	handlerReturned = func() ownershipResult {
		returnOnce.Do(func() { close(returned) })
		return <-done
	}
	release = func() {
		releaseOnce.Do(func() { close(settled) })
		<-exited
	}
	return handlerReturned, release
}

// leaseEndFrom reports when one lease granted at sentAt ends. A task claimed before this worker
// started measuring, such as one a caller built itself, gets a whole lease from now.
func (worker *Worker) leaseEndFrom(sentAt time.Time) time.Time {
	if sentAt.IsZero() {
		return time.Now().Add(worker.leaseDuration)
	}
	return sentAt.Add(worker.leaseDuration)
}

// untilLeaseEnd is the watchdog delay for a lease that ends at end. It is at least 1 ms.
func untilLeaseEnd(end time.Time) time.Duration {
	return max(time.Millisecond, time.Until(end))
}

func (worker *Worker) recordLeaseWatchdog(ctx context.Context, task ClaimedTask) {
	logWorkerEvent(
		ctx, worker.logger, slog.LevelWarn, leaseWatchdogEvent, leaseWatchdogLogMessage,
		func() []any { return taskLogAttributes(task, worker.workerID) },
	)
}

// holdHeartbeats takes this worker's share of the heartbeat connection its pool lends. A worker
// that opted out of the reservation heartbeats through the shared pool and holds nothing.
func (worker *Worker) holdHeartbeats() {
	if worker.sharedHeartbeats {
		return
	}
	worker.heartbeatMu.Lock()
	defer worker.heartbeatMu.Unlock()
	if worker.heartbeatLease == nil {
		worker.heartbeatLease = holdHeartbeatConnection(worker.pool, worker.heartbeatInterval)
	}
}

// prepareStart is the readiness check of Run and RunOnce (ADR 0071). Inside startupBudget, in order,
// it reserves the heartbeat connection ahead of any handler that could exhaust the pool, then
// borrows one ordinary connection, runs the compatibility check on it, and returns it at once. If
// either step fails, the worker does not start. The borrow proves that the pool has a connection
// to spare now. It does not prove that the pool keeps one free.
//
// A worker with SharedHeartbeats reserves nothing, and it runs the compatibility check without the
// budget.
func (worker *Worker) prepareStart(ctx context.Context) error {
	if worker.sharedHeartbeats {
		return worker.compatibility.Assert(ctx)
	}
	worker.heartbeatMu.Lock()
	lease := worker.heartbeatLease
	worker.heartbeatMu.Unlock()
	startupContext, cancel := context.WithTimeout(ctx, worker.startupBudget)
	defer cancel()
	if err := lease.reserve(startupContext); err != nil {
		return worker.startupError(ctx, startupHeartbeatConnectionStep, err)
	}
	borrowed, err := worker.pool.Acquire(startupContext)
	if err != nil {
		return worker.startupError(ctx, startupCompatibilityConnectionStep, err)
	}
	err = worker.compatibility.assertOn(startupContext, NewPGXExecutor(borrowed))
	borrowed.Release()
	// A schema refusal keeps its own error. Any other failure of the check is a startup failure.
	var refusal *CompatibilityError
	if err != nil && !errors.As(err, &refusal) {
		return worker.startupError(ctx, startupCompatibilityCheckStep, err)
	}
	return err
}

// startupError names the pool, the budget, and the opt-out. A run that its caller stopped returns
// the error unchanged, because the budget did not end it.
func (worker *Worker) startupError(ctx context.Context, step string, err error) error {
	if ctx.Err() != nil {
		return err
	}
	config := worker.pool.Config()
	pool := fmt.Sprintf(workerStartupPoolFormat, config.ConnConfig.Host, config.ConnConfig.Port, config.ConnConfig.Database)
	return fmt.Errorf(workerStartupConnectionErrorFormat, pool, config.MaxConns, step, worker.startupBudget, err)
}

// heartbeatReady reports whether the worker may claim. A worker with a dedicated heartbeat connection
// claims no task, ordinary or fused, while its pool holds no such connection (ADR 0071). A round that
// fails and keeps its connection, or a round that holds the connection, does not close this gate.
func (worker *Worker) heartbeatReady() bool {
	if worker.sharedHeartbeats {
		return true
	}
	worker.heartbeatMu.Lock()
	lease := worker.heartbeatLease
	worker.heartbeatMu.Unlock()
	return lease != nil && lease.ready()
}

// errHeartbeatClaimGateClosed ends a claim that found the claim gate closed on its held connection.
var errHeartbeatClaimGateClosed = errors.New(heartbeatClaimGateClosedMessage)

// holdClaimConnection returns an executor on one connection of the pool behind executor, and its
// release. A claim reads the claim gate after this wait, so the wait for the pool cannot carry a
// claim past a lost heartbeat connection. Any other executor is returned unchanged.
func holdClaimConnection(ctx context.Context, executor Executor) (Executor, func(), error) {
	if pgx, ok := executor.(*pgxExecutor); ok {
		if pool, ok := pgx.queryer.(*pgxpool.Pool); ok {
			held, err := pool.Acquire(ctx)
			if err != nil {
				return nil, nil, err
			}
			return NewPGXExecutor(held), held.Release, nil
		}
	}
	return executor, func() {}, nil
}

// watchHeartbeats calls onReady each time the shared heartbeat connection arrives again, until the
// run releases its hold.
func (worker *Worker) watchHeartbeats(onReady func()) {
	worker.heartbeatMu.Lock()
	lease := worker.heartbeatLease
	worker.heartbeatMu.Unlock()
	if lease != nil {
		lease.watch(onReady)
	}
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

// heartbeatRoundBoundFor is the deadline of one heartbeat round for interval. It is three quarters
// of the interval, so that one timed-out round leaves a renewal margin when 2 × interval + bound <
// lease. Below an interval of 200 ms the bound is at least min(50 ms, interval). Up to 50 ms the
// bound thus equals the interval, as before SM-1444, and a timed-out round leaves about no margin.
// It is at least 1 ms, in whole milliseconds rounded down. Every SDK uses the same formula.
func heartbeatRoundBoundFor(interval time.Duration) time.Duration {
	threeQuarters := interval / time.Millisecond * 3 / 4 * time.Millisecond
	return max(time.Millisecond, threeQuarters, min(50*time.Millisecond, interval))
}

// busyRetryBase is the longest base delay before a busy retry. The retry waits base × (1 + random),
// with base = min(busyRetryBase, heartbeatInterval / 8).
const busyRetryBase = 100 * time.Millisecond

// busyRetryMargin is the part of busyRetryMinimum above minimumRoundRemaining.
const busyRetryMargin = 12 * time.Millisecond

// busyRetryMinimum is the least time a busy retry must have before its deadline, or it does not run.
// It is the time a round needs at the settings statement, plus a margin for the payload, the wait
// for the connection, and BEGIN.
const busyRetryMinimum = minimumRoundRemaining + busyRetryMargin

// busyRetryDelay is the wait before a busy retry. The jitter keeps two workers from meeting the
// same lock holder in step. Every SDK uses the same formula.
func busyRetryDelay(interval time.Duration) time.Duration {
	base := min(busyRetryBase, interval/8)
	return base + time.Duration(pseudorand.Float64()*float64(base))
}

// runHeartbeats sends one round at a time. A regular round falls due one heartbeatInterval after
// the previous regular round started, not after it ended. A round that ends after its next slot
// starts one overdue round at once, and the interval after it counts from that start, so missed
// slots are never replayed. A wake that finds members starts no early round. time.Now carries a
// monotonic reading, so a wall clock step does not move the schedule.
//
// Between two slots, a busy retry renews only the leases that the latest round reported busy
// (busyRetrySelection). It is a round for the one-round-in-flight rule, and it never moves the
// regular slot. Each round replaces the pending retry, and a round that fails schedules none.
func (worker *Worker) runHeartbeats() {
	next := time.Now().Add(worker.heartbeatInterval)
	var retry []*heartbeatMember
	var retryAt time.Time
	timer := time.NewTimer(worker.heartbeatInterval)
	defer timer.Stop()
	for {
		select {
		case <-worker.heartbeatWake:
		case <-timer.C:
		}
		members := worker.heartbeatSnapshot()
		if members == nil {
			return
		}
		now := time.Now()
		var round []*heartbeatMember
		var deadline time.Time
		switch {
		case !now.Before(next):
			// The regular round takes every lease, the busy ones too, and drops the pending retry.
			next = now.Add(worker.heartbeatInterval)
			round, deadline = members, now.Add(worker.heartbeatRoundBound)
		case retry != nil && !now.Before(retryAt):
			round, deadline = worker.busyRetrySelection(retry, now, next)
			retry = nil
		}
		if round != nil {
			retry = worker.refreshOwnershipMany(round, deadline)
			if retry != nil {
				retryAt = time.Now().Add(busyRetryDelay(worker.heartbeatInterval))
			}
		}
		dueAt := next
		if retry != nil && retryAt.Before(next) {
			dueAt = retryAt
		}
		timer.Reset(max(0, time.Until(dueAt)))
	}
}

// heartbeatSnapshot returns the registered members. With no member left it returns nil and ends
// the heartbeat loop under the same lock, so the next registration starts a new schedule.
func (worker *Worker) heartbeatSnapshot() []*heartbeatMember {
	worker.heartbeatMu.Lock()
	defer worker.heartbeatMu.Unlock()
	if len(worker.heartbeatMembers) == 0 {
		worker.heartbeatRunning = false
		return nil
	}
	members := make([]*heartbeatMember, 0, len(worker.heartbeatMembers))
	for member := range worker.heartbeatMembers {
		members = append(members, member)
	}
	return members
}

// busyRetrySelection returns the busy members that a retry can still renew, and the retry's
// deadline. Each member is still registered, so a completed, replaced, or abandoned attempt is
// gone, and its local lease window has not ended. With no such member it returns nil, and the
// loop waits for the regular slot. The deadline is the earliest of the round bound, the next
// regular slot, and the end of each selected lease window, so a retry never renews a lease that
// the worker has already given up. Every round is bounded, so a deadline less than busyRetryMinimum
// after now also returns nil: such a retry could fail before its heartbeat statement and renew
// nothing. The regular round renews the busy leases instead.
func (worker *Worker) busyRetrySelection(
	busy []*heartbeatMember, now time.Time, next time.Time,
) ([]*heartbeatMember, time.Time) {
	registered := worker.registeredHeartbeats(busy)
	deadline := now.Add(worker.heartbeatRoundBound)
	if next.Before(deadline) {
		deadline = next
	}
	var selection []*heartbeatMember
	for _, member := range busy {
		end := member.leaseEnd.Load()
		if !registered[member] || end == nil || !end.After(now) {
			continue
		}
		selection = append(selection, member)
		if end.Before(deadline) {
			deadline = *end
		}
	}
	if deadline.Sub(now) < busyRetryMinimum {
		return nil, deadline
	}
	return selection, deadline
}

// refreshOwnershipMany sends one round for members, which must end by deadline, and applies each
// status to the member that the round sent. It returns the members that the round reported busy.
// A failed round returns nil: it proves nothing about ownership, so every attempt keeps running
// and the next regular round tries again. Each attempt's watchdog decides when a renewal is too
// old to trust.
func (worker *Worker) refreshOwnershipMany(members []*heartbeatMember, deadline time.Time) []*heartbeatMember {
	// A lease renewed by this round runs from before the request left, which can only be earlier
	// than the database's renewal, so a local lease window never outlasts the real one.
	sentAt := time.Now()
	statuses, err := worker.heartbeatRound(members, deadline)
	if err != nil {
		worker.logger.Warn(heartbeatRoundFailedLogMessage, errorLogField, err)
		return nil
	}
	// A result counts only for the member that the round sent. A member that left or was
	// replaced while the round ran gets nothing from it.
	// Two members can name the same task while an old attempt has not unregistered yet, so each
	// status belongs to the member at its position, not to its task ID.
	registered := worker.registeredHeartbeats(members)
	var busy []*heartbeatMember
	for index, member := range members {
		if !registered[member] {
			continue
		}
		status := statuses[index]
		switch status {
		case workerOwnershipAccepted:
			member.renew(sentAt)
		case workerOwnershipBusy:
			// Another transaction holds the row. The lease got no renewal and no ownership
			// verdict, so the watchdog keeps its window and the attempt keeps running.
			worker.recordHeartbeatStatus(member.ctx, status)
			busy = append(busy, member)
		default:
			member.cancelHandler(ownershipCause(member.task, status))
			worker.recordRejectedHeartbeat(member.ctx, member.task, status)
			member.deliver(ownershipResult{status: status})
		}
	}
	return busy
}

// heartbeatStatementLeaseLimit is the most leases that one heartbeat statement accepts.
// heartbeat_many_v2 raises an error above it. A round can hold more members than the concurrency
// limit, because a fused completion claim registers its tasks before the completing attempts
// unregister.
const heartbeatStatementLeaseLimit = 100

// queryHeartbeatRound sends the heartbeat statements of one round for members and returns the
// status of each member, in the order of members. It sends the leases in task ID order, at most
// heartbeatStatementLeaseLimit in each statement. The round ends by deadline, on the client and on
// the server, so a statement that stalls cannot hold the batch past the next round.
func (worker *Worker) queryHeartbeatRound(
	members []*heartbeatMember, deadline time.Time,
) ([]ownershipStatus, error) {
	type lease struct {
		TaskID     string `json:"taskId"`
		FenceToken string `json:"fenceToken"`
		LeaseMS    int    `json:"leaseMs"`
	}
	leaseMS := int(worker.leaseDuration / time.Millisecond)
	// Task ID order matches the order a batched completion locks its rows in. Each statement
	// returns its rows in input order, so position maps a row back to its member.
	order := make([]int, len(members))
	for index := range order {
		order[index] = index
	}
	slices.SortStableFunc(order, func(left, right int) int {
		return strings.Compare(members[left].task.ID, members[right].task.ID)
	})
	var payloads []string
	for chunk := range slices.Chunk(order, heartbeatStatementLeaseLimit) {
		requests := make([]lease, 0, len(chunk))
		for _, index := range chunk {
			member := members[index]
			requests = append(requests, lease{
				TaskID: member.task.ID, FenceToken: strconv.FormatInt(member.task.FenceToken, 10),
				LeaseMS: leaseMS,
			})
		}
		payload, err := json.Marshal(requests)
		if err != nil {
			return nil, err
		}
		payloads = append(payloads, string(payload))
	}
	roundContext := context.WithoutCancel(members[0].ctx)
	worker.heartbeatMu.Lock()
	reserved := worker.heartbeatLease
	worker.heartbeatMu.Unlock()
	statuses := make([]ownershipStatus, len(members))
	round := func(ctx context.Context, executor Executor) error {
		// Each statement commits on its own. If a later statement fails, the round fails, and
		// the renewals of the earlier statements do not count locally.
		for chunkIndex, payload := range payloads {
			rows, err := queryFencedWrite(
				ctx,
				executor,
				protocolStatementRegistry[heartbeatManyStatementName],
				worker.workerID,
				payload,
			)
			if err != nil {
				return err
			}
			chunk := order[chunkIndex*heartbeatStatementLeaseLimit:]
			chunk = chunk[:min(len(chunk), heartbeatStatementLeaseLimit)]
			if len(rows) != len(chunk) {
				return errors.New(invalidOwnershipResultMessage)
			}
			for position, row := range rows {
				member := members[chunk[position]]
				if stringValue(row[rowTaskIDField]) != member.task.ID {
					return errors.New(invalidOwnershipResultMessage)
				}
				status, parseErr := parseHeartbeatStatusRow(row)
				if parseErr != nil {
					return parseErr
				}
				statuses[chunk[position]] = status
			}
		}
		return nil
	}
	// Serialization counts against the deadline.
	bound := time.Until(deadline)
	var err error
	if reserved == nil {
		queryContext, cancel := context.WithDeadline(roundContext, deadline)
		err = runBoundedOnPool(queryContext, worker.pool, round)
		cancel()
	} else {
		err = reserved.run(roundContext, bound, round)
	}
	if err != nil {
		return nil, err
	}
	return statuses, nil
}

// parseHeartbeatStatusRow reads one heartbeat result. Only a heartbeat round reports busy, so the
// single-lease statements keep the stricter parseOwnershipStatusRow.
func parseHeartbeatStatusRow(row Row) (ownershipStatus, error) {
	if value, ok := row[rowStatusField].(string); ok && ownershipStatus(value) == workerOwnershipBusy {
		return workerOwnershipBusy, nil
	}
	return parseOwnershipStatusRow(row)
}

// recordHeartbeatStatus counts one heartbeat status other than accepted.
func (worker *Worker) recordHeartbeatStatus(ctx context.Context, status ownershipStatus) {
	if worker.metrics.enabled {
		worker.metrics.heartbeatFailures.Add(
			ctx, 1,
			metric.WithAttributes(attribute.String(heartbeatStatusAttribute, string(status))),
		)
	}
}

func (worker *Worker) recordRejectedHeartbeat(
	ctx context.Context, task ClaimedTask, status ownershipStatus,
) {
	worker.recordHeartbeatStatus(ctx, status)
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
		rows, err := queryFencedWrite(
			ctx,
			NewPGXExecutor(worker.pool),
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
	rows, err := queryFencedWrite(
		ctx,
		executor,
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

// encodeResult serializes a handler result and checks it against what the task accepts: a value
// jsonb can store, the result schema of its contract version, and its result_max_bytes. An error
// here is a failure of the attempt, never of the worker.
func (worker *Worker) encodeResult(ctx context.Context, executor Executor, task ClaimedTask, result any) ([]byte, error) {
	encoded, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	if err := checkStorable(task.Type, contractResultKind, encoded); err != nil {
		return nil, err
	}
	var normalizedResult any
	if err := decodeContractJSON(encoded, &normalizedResult); err != nil {
		return nil, err
	}
	if err := worker.validateResultContract(ctx, executor, task, normalizedResult); err != nil {
		return nil, err
	}
	if err := checkValueSize(task.Type, contractResultKind, encoded, normalizedResult, task.ResultMaxBytes); err != nil {
		return nil, err
	}
	return encoded, nil
}

func (worker *Worker) complete(ctx context.Context, executor Executor, task ClaimedTask, encoded []byte) error {
	accepted, err := worker.writeCompletion(ctx, executor, task, encoded)
	if err != nil {
		return err
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
	return worker.releaseOwned(ctx, executor, task, func(outcome handlerOutcome) {
		worker.metrics.recordHandler(ctx, task, outcome, time.Since(startedAt))
	})
}

// settleAfterShutdown settles the task of a handler that returned once the stop had come, so the
// stop leaves no finished task to lease recovery. A returned value completes the task, as it would
// without the stop. A handler error, or a value the task cannot store, returns the task to its
// queue and charges no attempt. Both writes are fenced and share one unwind window: when the write
// fails, the worker logs the failure and lease recovery settles the task, as it would without this
// settlement. A rejected completion is reconciled first, within the same window.
func (worker *Worker) settleAfterShutdown(
	ctx context.Context,
	executor Executor,
	task ClaimedTask,
	result any,
	handlerError error,
) handlerOutcome {
	settleContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), handlerUnwindPeriod)
	defer cancel()
	outcome := handlerOutcomeCanceled
	var err error
	var encoded []byte
	if handlerError == nil {
		encoded, err = worker.encodeResult(settleContext, executor, task, result)
	}
	if handlerError == nil && err == nil {
		// Without its slot, a fast-tier completion goes alone: a batch runs on its first entry's
		// context, which the stop may already have cancelled, and the stopped loop claims nothing.
		alone := task
		alone.slot = nil
		err = worker.complete(settleContext, executor, alone, encoded)
		if err == nil {
			outcome = handlerOutcomeSucceeded
		} else if errors.Is(err, ErrStaleLease) {
			// As after a normal completion, a cancellation request or an expiry may have won the
			// fence. Reconciling acknowledges or settles it, so only a lost lease reaches recovery.
			outcome = handlerOutcomeLeaseLost
			err = worker.reconcileRejectedSettlement(settleContext, executor, task, err)
		}
	} else {
		err = worker.releaseOwned(settleContext, executor, task, func(released handlerOutcome) {
			outcome = released
		})
	}
	if err != nil {
		worker.logger.WarnContext(
			ctx,
			shutdownSettlementFailedMessage,
			append(taskLogAttributes(task, worker.workerID), slog.String(errorLogField, err.Error()))...,
		)
	}
	return outcome
}

// releaseOwned hands an owned task back through release_owned_v1 without charging its attempt.
// It reports the handler outcome the release status implies before it settles that status.
func (worker *Worker) releaseOwned(
	ctx context.Context,
	executor Executor,
	task ClaimedTask,
	settled func(handlerOutcome),
) error {
	lease := worker.fencedLease(task)
	rows, err := queryFencedWrite(
		ctx,
		executor,
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
	settled(outcome)
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

// durableReplayConflictName recognizes typed conflicts through ordinary Go error wrapping.
func durableReplayConflictName(err error) string {
	var checkpointInput *CheckpointInputConflictError
	var checkpoint *CheckpointConflictError
	var wait *WaitConflictError
	var child *ChildConflictError
	var human *HumanWaitConflictError
	switch {
	case errors.As(err, &checkpointInput):
		return checkpointInputConflictErrorName
	case errors.As(err, &checkpoint):
		return checkpointConflictErrorName
	case errors.As(err, &wait):
		return waitConflictErrorName
	case errors.As(err, &child):
		return childConflictErrorName
	case errors.As(err, &human):
		return humanWaitConflictErrorName
	default:
		return emptyString
	}
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
	var delay any
	if durableReplayConflictName(handlerError) != emptyString {
		delay = int64(-1)
	} else {
		delay = worker.retryDelayOverride(task)
	}
	arguments := append(lease.parameters(), encoded, delay)
	rows, err := queryFencedWrite(ctx, executor, protocolStatementRegistry[failStatementName], arguments...)
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
// A durable replay conflict keeps its class even through a wrapper. For other errors, an error
// that names itself through ErrorNamer wins, because only the error knows which failure
// it reports. An exported concrete type names itself next, which keeps a declared error type
// legible without asking every declaration to implement an interface. Everything else, including
// every errors.New and fmt.Errorf value, is the generic error TypeScript and Python also call
// "Error".
func handlerErrorName(err error) string {
	if name := durableReplayConflictName(err); name != emptyString {
		return name
	}
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
