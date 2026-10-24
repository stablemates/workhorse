package workhorse_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
	"go.uber.org/goleak"
)

type replayConflictCase struct {
	ErrorKind          string            `json:"errorKind"`
	RedactErrorDetails bool              `json:"redactErrorDetails"`
	ExpectedState      string            `json:"expectedState"`
	ExpectedAttempt    int               `json:"expectedAttempt"`
	ExpectedErrorNames map[string]string `json:"expectedErrorNames"`
}

type workerRuntimeFixture struct {
	Cases                                []replayConflictCase              `json:"cases"`
	ID                                   string                            `json:"id"`
	Kind                                 string                            `json:"kind"`
	Covers                               []string                          `json:"covers"`
	TaskType                             string                            `json:"taskType"`
	FollowingTaskType                    string                            `json:"followingTaskType"`
	CheckpointName                       string                            `json:"checkpointName"`
	WaitName                             string                            `json:"waitName"`
	WaitMS                               int                               `json:"waitMs"`
	ExpectedHandlerOrder                 []string                          `json:"expectedHandlerOrder"`
	ExpectedHandlerRuns                  int                               `json:"expectedHandlerRuns"`
	ExpectedCheckpointOperations         int                               `json:"expectedCheckpointOperations"`
	ExpectedAttemptsAfterSuspension      int                               `json:"expectedAttemptsAfterSuspension"`
	ExpectedAttemptsAfterReplay          int                               `json:"expectedAttemptsAfterReplay"`
	ExpectedAfterSuspension              map[string]workerFixtureTaskState `json:"expectedAfterSuspension"`
	ExpectedAfterSlotRelease             map[string]workerFixtureTaskState `json:"expectedAfterSlotRelease"`
	ExpectedAfterReplay                  map[string]workerFixtureTaskState `json:"expectedAfterReplay"`
	LeaseMS                              int                               `json:"leaseMs"`
	HeartbeatMS                          int                               `json:"heartbeatMs"`
	DurationMS                           int                               `json:"durationMs"`
	MaxAttempts                          int                               `json:"maxAttempts"`
	CancelReason                         string                            `json:"cancelReason"`
	ExpectedCallsWhileBlocked            int                               `json:"expectedCallsWhileBlocked"`
	ExpectedMinimumCallsBeforeSettlement int                               `json:"expectedMinimumCallsBeforeSettlement"`
	ExpectedMaximumOverlap               int                               `json:"expectedMaximumOverlap"`
	PollMS                               int                               `json:"pollMs"`
	EmptyPollsBeforeEnqueue              int                               `json:"emptyPollsBeforeEnqueue"`
	EnqueueStallMS                       int                               `json:"enqueueStallMs"`
	ExpectedMinimumDelayMS               int                               `json:"expectedMinimumDelayMs"`
	ExpectedMaximumDelayMS               int                               `json:"expectedMaximumDelayMs"`
	ExpectedMaximumClaimDelayMS          int                               `json:"expectedMaximumClaimDelayMs"`
	ObserveAfterRecoveryMS               int                               `json:"observeAfterRecoveryMs"`
	MaximumEmptyAfterRecovery            int                               `json:"expectedMaximumEmptyClaimsAfterRecovery"`
	MaximumClaimDelayAfterLossMS         int                               `json:"expectedMaximumClaimDelayAfterLossMs"`
	Mode                                 string                            `json:"mode"`
	LocalClockLeadMS                     int                               `json:"localClockLeadMs"`
	ExpectedCancelledAfterDatabaseExpiry bool                              `json:"expectedCancelledAfterDatabaseExpiry"`
	ExpectedAbortReason                  string                            `json:"expectedAbortReason"`
	ExpectedAbortReasons                 []string                          `json:"expectedAbortReasons"`
	ExpectedAbortMessage                 string                            `json:"expectedAbortMessage"`
	ExpectedRejectedWrites               []string                          `json:"expectedRejectedWrites"`
	PortableRejectedWrites               []string                          `json:"portableRejectedWrites"`
	ExpectedRejectedWriteError           string                            `json:"expectedRejectedWriteError"`
	ExpectedState                        workerFixtureTaskState            `json:"expectedState"`
	ExpectedAfterRuns                    []workerFixtureTaskState          `json:"expectedAfterRuns"`
	ExpectedAttemptOutcome               string                            `json:"expectedAttemptOutcome"`
	ExpectedRunOutcome                   string                            `json:"expectedRunOutcome"`
	ExpectedAttemptOutcomes              []string                          `json:"expectedAttemptOutcomes"`
	Concurrency                          int                               `json:"concurrency"`
	TaskCount                            int                               `json:"taskCount"`
	SettleCheckMS                        int                               `json:"settleCheckMs"`
	ExpectedActiveAtStop                 int                               `json:"expectedActiveAtStop"`
	ExpectedSucceeded                    int                               `json:"expectedSucceeded"`
	ExpectedReady                        int                               `json:"expectedReady"`
	MaxActive                            int                               `json:"maxActive"`
	QueueRate                            workhorse.RateLimit               `json:"queueRate"`
	ExpectedHolderClaims                 int                               `json:"expectedHolderClaims"`
	ExpectedLateClaims                   int                               `json:"expectedLateClaims"`
	ExpectedActive                       int                               `json:"expectedActive"`
	RegisteredTaskType                   string                            `json:"registeredTaskType"`
	ExpectedAfterRelease                 workerFixtureTaskState            `json:"expectedAfterRelease"`
	ExpectedAttempts                     int                               `json:"expectedAttempts"`
	ExpectedReleasedPassOutcome          string                            `json:"expectedReleasedPassOutcome"`
	ExpectedReleaseEvents                int                               `json:"expectedReleaseEvents"`
	ExpectedReleaseEventsAfterNextPass   int                               `json:"expectedReleaseEventsAfterNextPass"`
	ExpectedAfterHandled                 workerFixtureTaskState            `json:"expectedAfterHandled"`
	RunMS                                int                               `json:"runMs"`
	ExpectedMinimumReleases              int                               `json:"expectedMinimumReleases"`
	ExpectedMaximumReleases              int                               `json:"expectedMaximumReleases"`
	ExpectedMinimumReleaseGapMS          float64                           `json:"expectedMinimumReleaseGapMs"`
	Payload                              any                               `json:"payload"`
	Injection                            workerFixtureInjection            `json:"injection"`
	ExpectedMinimumFailedRounds          int                               `json:"expectedMinimumFailedRounds"`
	ExpectedBusyRounds                   int                               `json:"expectedBusyRounds"`
	MaximumRetryGapMS                    float64                           `json:"maximumRetryGapMs"`
	RenewalTimeoutMS                     int                               `json:"renewalTimeoutMs"`
	ExpectedCancellations                int                               `json:"expectedCancellations"`
	ExpectedPhase                        string                            `json:"expectedPhase"`
	ExpectedClaimLimits                  []int                             `json:"expectedClaimLimits"`
	ExpectedOverlappingClaims            int                               `json:"expectedOverlappingClaims"`
	ExpectedMaximumClaimsPerTask         float64                           `json:"expectedMaximumClaimsPerTask"`
	Tier                                 string                            `json:"tier"`
	OversizedZeros                       int                               `json:"oversizedZeros"`
	FittingZeros                         int                               `json:"fittingZeros"`
	ExpectedSettled                      workerFixtureTaskState            `json:"expectedSettled"`
	ExpectedErrorNames                   map[string]string                 `json:"expectedErrorNames"`
	ExpectedFitting                      workerFixtureTaskState            `json:"expectedFitting"`
	ShutdownGraceMS                      int                               `json:"shutdownGraceMs"`
	DrainHoldMS                          int                               `json:"drainHoldMs"`
	ShutdownBehavior                     map[string]string                 `json:"shutdownBehavior"`
	HandlerResult                        string                            `json:"handlerResult"`
	ExpectedCancelled                    workerFixtureReleasedState        `json:"expectedCancelled"`
	ExpectedDrained                      workerFixtureTaskState            `json:"expectedDrained"`
}

// workerFixtureReleasedState is the state of a task a worker released, with the events it recorded.
type workerFixtureReleasedState struct {
	workerFixtureTaskState
	Events []string `json:"events"`
}

// workerFixtureInjection replaces one installed function with a raising body, so a fixture can
// fail a call the SDK makes without reaching into the SDK.
type workerFixtureInjection struct {
	Function        string   `json:"function"`
	Header          string   `json:"header"`
	ErrorCode       string   `json:"errorCode"`
	Message         string   `json:"message"`
	CounterSequence string   `json:"counterSequence"`
	Setup           []string `json:"setup"`
	Body            string   `json:"body"`
	RoundsQuery     string   `json:"roundsQuery"`
	Teardown        []string `json:"teardown"`
}

type workerFixtureTaskState struct {
	State     string `json:"state"`
	Attempt   int    `json:"attempt"`
	ErrorName string `json:"errorName"`
}

func executeWorkerSuspensionReplayFixture(t *testing.T, fixture workerRuntimeFixture) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-suspension-replay")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "go-worker-suspension-replay"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	suspensionTaskID, err := queue.Enqueue(ctx, fixture.TaskType, nil)
	if err != nil {
		t.Fatal(err)
	}
	followingTaskID, err := queue.Enqueue(ctx, fixture.FollowingTaskType, nil)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "go-suspension-replay", Concurrency: 1,
		LeaseDuration: time.Second, PollInterval: 5 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}

	order := make([]string, 0, len(fixture.ExpectedHandlerOrder))
	handlerRuns := 0
	checkpointOperations := 0
	worker.Handle(fixture.TaskType, func(
		_ context.Context,
		_ any,
		handlerContext *workhorse.HandlerContext,
	) (any, error) {
		handlerRuns++
		order = append(order, "suspension:"+strconv.Itoa(handlerContext.Task.Attempt))
		prepared, err := handlerContext.Checkpoint(fixture.CheckpointName, func() (any, error) {
			checkpointOperations++
			return map[string]any{"operation": checkpointOperations}, nil
		})
		if err != nil {
			return nil, err
		}
		if err := handlerContext.Sleep(fixture.WaitName, time.Duration(fixture.WaitMS)*time.Millisecond); err != nil {
			return nil, err
		}
		return prepared, nil
	})
	worker.Handle(fixture.FollowingTaskType, func(
		_ context.Context,
		_ any,
		handlerContext *workhorse.HandlerContext,
	) (any, error) {
		order = append(order, "following:"+strconv.Itoa(handlerContext.Task.Attempt))
		return nil, nil
	})

	if processed, err := worker.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("suspension run: processed=%t err=%v", processed, err)
	}
	if _, err := pool.Exec(
		ctx,
		"UPDATE workhorse.task_runtime SET run_at = clock_timestamp() + interval '30 seconds' WHERE task_id = $1::uuid",
		suspensionTaskID,
	); err != nil {
		t.Fatal(err)
	}
	assertWorkerFixtureTaskState(t, ctx, pool, suspensionTaskID, fixture.ExpectedAfterSuspension["suspension"])
	assertWorkerFixtureTaskState(t, ctx, pool, followingTaskID, fixture.ExpectedAfterSuspension["following"])
	var attemptsAfterSuspension int
	if err := pool.QueryRow(
		ctx,
		"SELECT count(*) FROM workhorse.attempt_history WHERE task_id = $1",
		suspensionTaskID,
	).Scan(&attemptsAfterSuspension); err != nil {
		t.Fatal(err)
	}
	if attemptsAfterSuspension != fixture.ExpectedAttemptsAfterSuspension {
		t.Fatalf(
			"expected %d attempts after suspension, received %d",
			fixture.ExpectedAttemptsAfterSuspension,
			attemptsAfterSuspension,
		)
	}
	if processed, err := worker.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("following run: processed=%t err=%v", processed, err)
	}
	assertWorkerFixtureTaskState(t, ctx, pool, suspensionTaskID, fixture.ExpectedAfterSlotRelease["suspension"])
	assertWorkerFixtureTaskState(t, ctx, pool, followingTaskID, fixture.ExpectedAfterSlotRelease["following"])
	if _, err := pool.Exec(
		ctx,
		"UPDATE workhorse.task_runtime SET run_at = clock_timestamp() - interval '1 millisecond' WHERE task_id = $1::uuid",
		suspensionTaskID,
	); err != nil {
		t.Fatal(err)
	}
	if processed, err := worker.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("replay run: processed=%t err=%v", processed, err)
	}
	assertWorkerFixtureTaskState(t, ctx, pool, suspensionTaskID, fixture.ExpectedAfterReplay["suspension"])
	assertWorkerFixtureTaskState(t, ctx, pool, followingTaskID, fixture.ExpectedAfterReplay["following"])

	if strings.Join(order, ",") != strings.Join(fixture.ExpectedHandlerOrder, ",") {
		t.Fatalf("unexpected handler order: %v", order)
	}
	if handlerRuns != fixture.ExpectedHandlerRuns {
		t.Fatalf("expected %d handler runs, received %d", fixture.ExpectedHandlerRuns, handlerRuns)
	}
	if checkpointOperations != fixture.ExpectedCheckpointOperations {
		t.Fatalf("expected %d checkpoint operations, received %d", fixture.ExpectedCheckpointOperations, checkpointOperations)
	}
	var attempts int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM workhorse.attempt_history WHERE task_id = $1", suspensionTaskID).Scan(&attempts); err != nil {
		t.Fatal(err)
	}
	if attempts != fixture.ExpectedAttemptsAfterReplay {
		t.Fatalf("expected %d retained attempts, received %d", fixture.ExpectedAttemptsAfterReplay, attempts)
	}
}

func TestHandlerContextReturnsTypedFenceErrorsForCheckpointAndWait(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-durability-stale")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "go-worker-durability-stale"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskID, err := queue.Enqueue(ctx, "durability.stale", nil)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "go-durability-stale", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}

	checkpointError := make(chan error, 1)
	waitError := make(chan error, 1)
	worker.Handle("durability.stale", func(
		_ context.Context,
		_ any,
		handlerContext *workhorse.HandlerContext,
	) (any, error) {
		var accepted bool
		if err := pool.QueryRow(
			ctx,
			"SELECT workhorse.complete_v1($1::uuid, $2::text, $3::bigint, '{}'::jsonb)",
			taskID,
			"go-durability-stale",
			handlerContext.Task.FenceToken,
		).Scan(&accepted); err != nil {
			return nil, err
		}
		if !accepted {
			return nil, errors.New("competing settlement was rejected")
		}
		_, checkpointErr := handlerContext.Checkpoint("stale-checkpoint", func() (any, error) {
			return map[string]any{"saved": false}, nil
		})
		checkpointError <- checkpointErr
		waitError <- handlerContext.Sleep("stale-wait", time.Millisecond)
		return nil, nil
	})

	processed, runError := worker.RunOnce(ctx)
	if !processed || runError != nil {
		t.Fatalf("expected the worker to survive a competing completion: processed=%t err=%v", processed, runError)
	}
	checkpointErr := <-checkpointError
	var checkpointLeaseLost *workhorse.CheckpointLeaseLostError
	if !errors.As(checkpointErr, &checkpointLeaseLost) || checkpointLeaseLost.TaskID != taskID ||
		checkpointLeaseLost.CheckpointName != "stale-checkpoint" ||
		!errors.Is(checkpointErr, workhorse.ErrLeaseLost) {
		t.Fatalf("unexpected checkpoint fence error: %#v", checkpointErr)
	}
	waitErr := <-waitError
	var waitLeaseLost *workhorse.WaitLeaseLostError
	if !errors.As(waitErr, &waitLeaseLost) || waitLeaseLost.TaskID != taskID ||
		waitLeaseLost.WaitName != "stale-wait" || !errors.Is(waitErr, workhorse.ErrLeaseLost) {
		t.Fatalf("unexpected wait fence error: %#v", waitErr)
	}
}

func TestHandlerContextReportsAndReadsLatestProgress(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-progress")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "go-worker-progress"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskID, err := queue.Enqueue(ctx, "progress.report", nil)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "go-progress-worker", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}

	worker.Handle("progress.report", func(
		_ context.Context,
		_ any,
		handlerContext *workhorse.HandlerContext,
	) (any, error) {
		initial, err := handlerContext.GetProgress()
		if err != nil || initial != nil {
			return nil, fmt.Errorf("initial progress: value=%#v err=%w", initial, err)
		}
		updated, err := handlerContext.SetProgress(map[string]any{"stage": "reading"})
		if err != nil {
			return nil, err
		}
		observed, err := handlerContext.GetProgress()
		if err != nil {
			return nil, err
		}
		if observed == nil || observed.Revision != updated.Revision || observed.TaskID != taskID {
			return nil, fmt.Errorf("unexpected cached progress: %#v", observed)
		}
		return observed.Value, nil
	})

	if processed, err := worker.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("progress run: processed=%t err=%v", processed, err)
	}
	var value []byte
	var revision int64
	if err := pool.QueryRow(
		ctx,
		"SELECT progress_value, revision FROM workhorse.task_progress WHERE task_id = $1",
		taskID,
	).Scan(&value, &revision); err != nil {
		t.Fatal(err)
	}
	if string(value) != `{"stage": "reading"}` && string(value) != `{"stage":"reading"}` {
		t.Fatalf("unexpected progress value: %s", value)
	}
	if revision != 1 {
		t.Fatalf("unexpected progress revision: %d", revision)
	}
	var state string
	var result []byte
	if err := pool.QueryRow(
		ctx,
		"SELECT state, result FROM workhorse.task_outcome WHERE task_id = $1",
		taskID,
	).Scan(&state, &result); err != nil {
		t.Fatal(err)
	}
	if state != "succeeded" || string(result) != `{"stage": "reading"}` && string(result) != `{"stage":"reading"}` {
		t.Fatalf("unexpected progress task outcome: state=%s result=%s", state, result)
	}
}

func TestHandlerContextReturnsTypedProgressFenceAndRateLimitErrors(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-progress-errors")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "go-worker-progress-errors"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskID, err := queue.Enqueue(ctx, "progress.errors", nil)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "go-progress-errors", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}

	var rateLimitError error
	var firstProgressError error
	var leaseError error
	worker.Handle("progress.errors", func(
		_ context.Context,
		_ any,
		handlerContext *workhorse.HandlerContext,
	) (any, error) {
		if _, firstProgressError = handlerContext.SetProgress(map[string]any{"step": 1}); firstProgressError != nil {
			return nil, nil
		}
		// The window must not depend on how long the first write took on a loaded runner.
		if _, err := pool.Exec(
			ctx,
			"UPDATE workhorse.task_progress SET updated_at = clock_timestamp() + interval '1 second' WHERE task_id = $1",
			taskID,
		); err != nil {
			return nil, err
		}
		_, rateLimitError = handlerContext.SetProgress(map[string]any{"step": 2})
		var accepted bool
		if err := pool.QueryRow(
			ctx,
			"SELECT workhorse.complete_v1($1::uuid, $2::text, $3::bigint, '{}'::jsonb)",
			taskID,
			"go-progress-errors",
			handlerContext.Task.FenceToken,
		).Scan(&accepted); err != nil {
			return nil, err
		}
		if !accepted {
			return nil, errors.New("competing settlement was rejected")
		}
		_, leaseError = handlerContext.SetProgress(map[string]any{"step": 3})
		return nil, nil
	})

	processed, runError := worker.RunOnce(ctx)
	if !processed || runError != nil {
		t.Fatalf("expected the worker to survive a stale settlement: processed=%t err=%v", processed, runError)
	}
	var limited *workhorse.ProgressRateLimitError
	if !errors.As(rateLimitError, &limited) || limited.TaskID != taskID || limited.RetryAfter <= 0 {
		t.Fatalf("unexpected progress errors: first=%#v rate_limit=%#v", firstProgressError, rateLimitError)
	}
	var lost *workhorse.ProgressLeaseLostError
	if !errors.As(leaseError, &lost) || lost.TaskID != taskID || !errors.Is(leaseError, workhorse.ErrLeaseLost) {
		t.Fatalf("unexpected progress fence error: %#v", leaseError)
	}
}

type scheduleWaitQueryTracer struct {
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func (tracer *scheduleWaitQueryTracer) TraceQueryStart(
	ctx context.Context,
	_ *pgx.Conn,
	data pgx.TraceQueryStartData,
) context.Context {
	if !strings.Contains(data.SQL, "schedule_wait_v1") {
		return ctx
	}
	tracer.once.Do(func() { close(tracer.started) })
	<-tracer.release
	return ctx
}

func (*scheduleWaitQueryTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func TestHandlerContextCoalescesWaitsAndCancelsOnSuspension(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-wait-coalescing")
	ctx := context.Background()
	tracer := &scheduleWaitQueryTracer{started: make(chan struct{}), release: make(chan struct{})}
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.Tracer = tracer
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "go-worker-wait-coalescing"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskID, err := queue.Enqueue(ctx, "wait.coalescing", nil)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "go-wait-coalescing", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}

	errorsSeen := make(chan error, 2)
	causes := make(chan error, 1)
	worker.Handle("wait.coalescing", func(
		handlerContext context.Context,
		_ any,
		durability *workhorse.HandlerContext,
	) (any, error) {
		go func() { errorsSeen <- durability.Sleep("shared", time.Second) }()
		<-tracer.started
		go func() { errorsSeen <- durability.Sleep("shared", time.Second) }()
		close(tracer.release)
		first, second := <-errorsSeen, <-errorsSeen
		if first != second {
			return nil, fmt.Errorf("same-name waits returned distinct errors: %v and %v", first, second)
		}
		<-handlerContext.Done()
		cause := context.Cause(handlerContext)
		if cause != first {
			return nil, fmt.Errorf("handler cancellation cause %v differs from wait error %v", cause, first)
		}
		causes <- cause
		return nil, nil
	})

	processed, err := worker.RunOnce(ctx)
	if err != nil || !processed {
		t.Fatalf("coalesced wait: processed=%t err=%v", processed, err)
	}
	if cause := <-causes; cause == nil {
		t.Fatal("scheduled wait did not cancel the handler context")
	}
	var state string
	var attempt int
	if err := pool.QueryRow(
		ctx,
		"SELECT state, current_attempt FROM workhorse.task_runtime WHERE task_id = $1",
		taskID,
	).Scan(&state, &attempt); err != nil {
		t.Fatal(err)
	}
	if state != "scheduled" || attempt != 1 {
		t.Fatalf("unexpected coalesced wait state: state=%s attempt=%d", state, attempt)
	}
}

type heartbeatQueryContextKey struct{}

type heartbeatGateTracer struct {
	release <-chan struct{}
}

func (tracer heartbeatGateTracer) TraceQueryStart(
	ctx context.Context,
	_ *pgx.Conn,
	data pgx.TraceQueryStartData,
) context.Context {
	if strings.Contains(data.SQL, "heartbeat_many_v2") {
		<-tracer.release
	}
	return ctx
}

func (heartbeatGateTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

type reconnectClaimContextKey struct{}

// notificationReconnectGateTracer holds every LISTEN after the first until the test closes
// release. It counts the empty claims whose statements start after the reconnect starts.
type notificationReconnectGateTracer struct {
	mu                   sync.Mutex
	listenCalls          int
	reconnectStarted     chan struct{}
	release              <-chan struct{}
	emptyClaimsInBackoff atomic.Int64
}

func newNotificationReconnectGateTracer(release <-chan struct{}) *notificationReconnectGateTracer {
	return &notificationReconnectGateTracer{
		reconnectStarted: make(chan struct{}, 1),
		release:          release,
	}
}

func (tracer *notificationReconnectGateTracer) TraceQueryStart(
	ctx context.Context,
	_ *pgx.Conn,
	data pgx.TraceQueryStartData,
) context.Context {
	if strings.Contains(data.SQL, "claim_many_v1") {
		tracer.mu.Lock()
		inBackoff := tracer.listenCalls > 1
		tracer.mu.Unlock()
		return context.WithValue(ctx, reconnectClaimContextKey{}, inBackoff)
	}
	if strings.TrimSpace(data.SQL) != "LISTEN workhorse_tasks" {
		return ctx
	}
	tracer.mu.Lock()
	tracer.listenCalls++
	isReconnect := tracer.listenCalls > 1
	tracer.mu.Unlock()
	if isReconnect {
		select {
		case tracer.reconnectStarted <- struct{}{}:
		default:
		}
		<-tracer.release
	}
	return ctx
}

func (tracer *notificationReconnectGateTracer) TraceQueryEnd(
	ctx context.Context,
	_ *pgx.Conn,
	data pgx.TraceQueryEndData,
) {
	inBackoff, _ := ctx.Value(reconnectClaimContextKey{}).(bool)
	if inBackoff && data.Err == nil && data.CommandTag.RowsAffected() == 0 {
		tracer.emptyClaimsInBackoff.Add(1)
	}
}

func (tracer *notificationReconnectGateTracer) waitForReconnect(t *testing.T) {
	t.Helper()
	select {
	case <-tracer.reconnectStarted:
	case <-time.After(10 * time.Second):
		t.Fatal("notification listener did not enter reconnect backoff")
	}
}

type pauseClaimQueryContextKey struct{}

// pauseClaimGateTracer holds the first claim statement that starts after the test sets holding,
// until the test calls releaseHeld. It counts the claim statements that start.
type pauseClaimGateTracer struct {
	holding     atomic.Bool
	held        chan struct{}
	release     chan struct{}
	releaseOnce sync.Once
	heldEnded   chan struct{}
	started     atomic.Int64
}

func (tracer *pauseClaimGateTracer) releaseHeld() {
	tracer.releaseOnce.Do(func() { close(tracer.release) })
}

func newPauseClaimGateTracer() *pauseClaimGateTracer {
	return &pauseClaimGateTracer{
		held:      make(chan struct{}),
		release:   make(chan struct{}),
		heldEnded: make(chan struct{}),
	}
}

func (tracer *pauseClaimGateTracer) TraceQueryStart(
	ctx context.Context,
	_ *pgx.Conn,
	data pgx.TraceQueryStartData,
) context.Context {
	if !strings.Contains(data.SQL, "claim_many_v1") {
		return ctx
	}
	held := tracer.holding.CompareAndSwap(true, false)
	if held {
		close(tracer.held)
		<-tracer.release
	}
	tracer.started.Add(1)
	return context.WithValue(ctx, pauseClaimQueryContextKey{}, held)
}

func (tracer *pauseClaimGateTracer) TraceQueryEnd(
	ctx context.Context,
	_ *pgx.Conn,
	_ pgx.TraceQueryEndData,
) {
	if held, _ := ctx.Value(pauseClaimQueryContextKey{}).(bool); held {
		close(tracer.heldEnded)
	}
}

type lockedBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (buffer *lockedBuffer) Write(contents []byte) (int, error) {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return buffer.buffer.Write(contents)
}

func (buffer *lockedBuffer) String() string {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	return buffer.buffer.String()
}

type heartbeatQueryTracer struct {
	mu    sync.Mutex
	delay time.Duration
	// delayedCalls is the number of calls the tracer delays. Zero delays every call.
	delayedCalls int
	calls        int
	active       int
	maxOverlap   int
	started      chan struct{}
}

func newHeartbeatQueryTracer(delay time.Duration) *heartbeatQueryTracer {
	return &heartbeatQueryTracer{delay: delay, started: make(chan struct{}, 16)}
}

// newFirstHeartbeatQueryTracer delays only the first heartbeat statement, so the later rounds can
// renew the lease in PostgreSQL.
func newFirstHeartbeatQueryTracer(delay time.Duration) *heartbeatQueryTracer {
	tracer := newHeartbeatQueryTracer(delay)
	tracer.delayedCalls = 1
	return tracer
}

func (tracer *heartbeatQueryTracer) TraceQueryStart(
	ctx context.Context,
	_ *pgx.Conn,
	data pgx.TraceQueryStartData,
) context.Context {
	if !strings.Contains(data.SQL, "heartbeat_many_v2") {
		return ctx
	}
	tracer.mu.Lock()
	tracer.calls++
	tracer.active++
	tracer.maxOverlap = max(tracer.maxOverlap, tracer.active)
	delay := tracer.delay
	if tracer.delayedCalls > 0 && tracer.calls > tracer.delayedCalls {
		delay = 0
	}
	tracer.mu.Unlock()
	// waitForCalls reads the counter after each signal, so a dropped signal loses no call.
	select {
	case tracer.started <- struct{}{}:
	default:
	}
	time.Sleep(delay)
	return context.WithValue(ctx, heartbeatQueryContextKey{}, true)
}

func (tracer *heartbeatQueryTracer) TraceQueryEnd(
	ctx context.Context,
	_ *pgx.Conn,
	_ pgx.TraceQueryEndData,
) {
	if ctx.Value(heartbeatQueryContextKey{}) != true {
		return
	}
	tracer.mu.Lock()
	tracer.active--
	tracer.mu.Unlock()
}

func (tracer *heartbeatQueryTracer) snapshot() (calls int, maxOverlap int) {
	tracer.mu.Lock()
	defer tracer.mu.Unlock()
	return tracer.calls, tracer.maxOverlap
}

func (tracer *heartbeatQueryTracer) waitForCalls(t *testing.T, expected int) {
	t.Helper()
	deadline := time.NewTimer(time.Second)
	defer deadline.Stop()
	for {
		calls, _ := tracer.snapshot()
		if calls >= expected {
			return
		}
		select {
		case <-tracer.started:
		case <-deadline.C:
			t.Fatalf("expected %d heartbeat calls, received %d", expected, calls)
		}
	}
}

func TestWorkerClaimsHandlesAndCompletesATask(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-complete")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-worker")
	taskID, err := queue.Enqueue(ctx, "report.generate", map[string]any{"reportId": "r-1"})
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:         "go-worker",
		WorkerID:      "go-worker-complete",
		LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("report.generate", func(_ context.Context, payload any, _ *workhorse.HandlerContext) (any, error) {
		return map[string]any{"reportId": payload.(map[string]any)["reportId"], "status": "ready"}, nil
	})

	processed, err := worker.RunOnce(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !processed {
		t.Fatal("worker did not claim the enqueued task")
	}

	var state string
	var result []byte
	if err := pool.QueryRow(
		ctx,
		"SELECT state, result FROM workhorse.task_outcome WHERE task_id = $1::uuid",
		taskID,
	).Scan(&state, &result); err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(result, &decoded); err != nil {
		t.Fatal(err)
	}
	if state != "succeeded" || decoded["reportId"] != "r-1" || decoded["status"] != "ready" {
		t.Fatalf("unexpected outcome: state=%s result=%#v", state, decoded)
	}
}

func TestContractSyncValidatesPayloadAndWorkerResult(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-contract")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-contract")
	err = queue.SyncContracts(ctx, map[string]workhorse.TaskTypeContracts{
		"contract.go": {
			CurrentVersion: "current",
			Versions: map[string]workhorse.TaskContractVersion{
				"current": {
					PayloadSchema: map[string]any{
						"type": "object", "required": []any{"name"},
						"properties": map[string]any{"name": map[string]any{"type": "string"}},
					},
					ResultSchema: map[string]any{
						"type": "object", "required": []any{"ok"},
						"properties": map[string]any{"ok": map[string]any{"const": true}},
					},
				},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := queue.Enqueue(ctx, "contract.go", map[string]any{"name": 42}); err == nil {
		t.Fatal("expected invalid payload rejection")
	}
	taskID, err := queue.Enqueue(
		ctx,
		"contract.go",
		map[string]any{"name": "accepted"},
		workhorse.EnqueueOptions{MaxAttempts: 1},
	)
	if err != nil {
		t.Fatal(err)
	}
	type contractPayload struct {
		Name string `json:"name"`
	}
	type contractResult struct {
		OK bool `json:"ok"`
	}
	structTaskID, err := queue.Enqueue(
		ctx,
		"contract.go",
		contractPayload{Name: "struct"},
		workhorse.EnqueueOptions{MaxAttempts: 1},
	)
	if err != nil {
		t.Fatal(err)
	}

	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-contract", WorkerID: "go-contract-worker", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("contract.go", func(_ context.Context, payload any, _ *workhorse.HandlerContext) (any, error) {
		if document, ok := payload.(map[string]any); ok && document["name"] == "struct" {
			return contractResult{OK: true}, nil
		}
		return map[string]any{"ok": false}, nil
	})
	for range 2 {
		processed, err := worker.RunOnce(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if !processed {
			t.Fatal("worker did not claim the contracted task")
		}
	}
	var state, structState string
	if err := pool.QueryRow(
		ctx,
		"SELECT state FROM workhorse.task_outcome WHERE task_id = $1::uuid",
		taskID,
	).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "failed" {
		t.Fatalf("expected failed outcome, received %s", state)
	}
	if err := pool.QueryRow(
		ctx,
		"SELECT state FROM workhorse.task_outcome WHERE task_id = $1::uuid",
		structTaskID,
	).Scan(&structState); err != nil {
		t.Fatal(err)
	}
	if structState != "succeeded" {
		t.Fatalf("expected struct result to succeed, received %s", structState)
	}
}

func TestWorkerRecordsFailureAndLetsPostgreSQLScheduleTheRetry(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-retry")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-worker-retry")
	taskID, err := queue.Enqueue(ctx, "delivery.retry", nil, workhorse.EnqueueOptions{
		MaxAttempts: 2,
		RetryPolicy: map[string]any{"type": "fixed", "delayMs": 25},
	})
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-worker-retry", WorkerID: "go-worker-retry", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	invocations := 0
	worker.Handle("delivery.retry", func(_ context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		invocations++
		if invocations == 1 {
			return nil, errors.New("temporary delivery failure")
		}
		return map[string]any{"delivered": true}, nil
	})

	processed, err := worker.RunOnce(ctx)
	if err != nil || !processed {
		t.Fatalf("first attempt: processed=%t err=%v", processed, err)
	}
	var state string
	var attempt int
	var runAt time.Time
	if err := pool.QueryRow(
		ctx,
		"SELECT state, current_attempt, run_at FROM workhorse.task_runtime WHERE task_id = $1::uuid",
		taskID,
	).Scan(&state, &attempt, &runAt); err != nil {
		t.Fatal(err)
	}
	if state != "scheduled" || attempt != 2 {
		t.Fatalf("PostgreSQL did not schedule the next attempt: state=%s attempt=%d", state, attempt)
	}
	if wait := time.Until(runAt.Add(10 * time.Millisecond)); wait > 0 {
		time.Sleep(wait)
	}

	processed, err = worker.RunOnce(ctx)
	if err != nil || !processed {
		t.Fatalf("second attempt: processed=%t err=%v", processed, err)
	}
	if invocations != 2 {
		t.Fatalf("expected two handler invocations, received %d", invocations)
	}
	var outcome string
	var currentAttempt int
	if err := pool.QueryRow(
		ctx,
		"SELECT state, current_attempt FROM workhorse.task_outcome WHERE task_id = $1::uuid",
		taskID,
	).Scan(&outcome, &currentAttempt); err != nil {
		t.Fatal(err)
	}
	if outcome != "succeeded" || currentAttempt != 2 {
		t.Fatalf("unexpected final outcome: state=%s attempt=%d", outcome, currentAttempt)
	}
}

func TestWorkersCannotClaimTheSameTaskConcurrently(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-exclusive")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-worker-exclusive")
	if _, err := queue.Enqueue(ctx, "exclusive", nil); err != nil {
		t.Fatal(err)
	}
	first, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-worker-exclusive", WorkerID: "go-worker-first", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	second, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-worker-exclusive", WorkerID: "go-worker-second", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	release := make(chan struct{})
	first.Handle("exclusive", func(_ context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		close(started)
		<-release
		return nil, nil
	})
	firstResult := make(chan error, 1)
	go func() {
		processed, err := first.RunOnce(ctx)
		if err == nil && !processed {
			err = errors.New("first worker did not claim the task")
		}
		firstResult <- err
	}()
	<-started

	processed, err := second.RunOnce(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if processed {
		t.Fatal("second worker claimed a task already owned by the first worker")
	}
	close(release)
	if err := <-firstResult; err != nil {
		t.Fatal(err)
	}
}

func TestWorkerRunBoundsConcurrencyAndRefillsSlots(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-concurrency")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "go-worker-concurrency"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	for sequence := range 3 {
		if _, err := queue.Enqueue(ctx, "bounded", map[string]any{"sequence": sequence}); err != nil {
			t.Fatal(err)
		}
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "bounded-worker", Concurrency: 2,
		LeaseDuration: time.Second, PollInterval: 5 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}

	started := make(chan int, 3)
	releases := []chan struct{}{make(chan struct{}), make(chan struct{}), make(chan struct{})}
	var active int
	var maximum int
	var stateMu sync.Mutex
	worker.Handle("bounded", func(_ context.Context, payload any, _ *workhorse.HandlerContext) (any, error) {
		sequence := int(payload.(map[string]any)["sequence"].(float64))
		stateMu.Lock()
		active++
		maximum = max(maximum, active)
		stateMu.Unlock()
		started <- sequence
		<-releases[sequence]
		stateMu.Lock()
		active--
		stateMu.Unlock()
		return map[string]any{"sequence": sequence}, nil
	})

	runContext, stop := context.WithCancel(ctx)
	runResult := make(chan error, 1)
	go func() { runResult <- worker.Run(runContext) }()
	first := <-started
	secondRunContext, stopSecondRun := context.WithCancel(ctx)
	secondRunResult := make(chan error, 1)
	go func() { secondRunResult <- worker.Run(secondRunContext) }()
	second := <-started
	select {
	case sequence := <-started:
		t.Fatalf("worker exceeded its concurrency bound by starting task %d", sequence)
	case <-time.After(100 * time.Millisecond):
	}
	close(releases[first])
	third := <-started
	for _, sequence := range []int{second, third} {
		close(releases[sequence])
	}
	stopSecondRun()
	if err := <-secondRunResult; err != nil {
		t.Fatalf("concurrent Run did not stop while waiting for the worker: %v", err)
	}
	stop()
	if err := <-runResult; err != nil {
		t.Fatal(err)
	}
	stateMu.Lock()
	defer stateMu.Unlock()
	if maximum != 2 || active != 0 {
		t.Fatalf("unexpected handler concurrency: maximum=%d active=%d", maximum, active)
	}
}

func TestWorkerRunRotatesClaimsAcrossQueues(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-rotation")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "busy")
	for sequence := range 3 {
		if _, err := queue.Enqueue(ctx, "rotated", map[string]any{
			"queue": "busy", "sequence": sequence,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := queue.Enqueue(ctx, "rotated", map[string]any{
		"queue": "quiet", "sequence": 3,
	}, workhorse.EnqueueOptions{Queue: "quiet"}); err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queues: []string{"busy", "quiet"}, WorkerID: "rotation-worker", Concurrency: 1,
		LeaseDuration: time.Second, PollInterval: 5 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}

	handled := make(chan string, 4)
	worker.Handle("rotated", func(_ context.Context, payload any, _ *workhorse.HandlerContext) (any, error) {
		handled <- payload.(map[string]any)["queue"].(string)
		return nil, nil
	})
	runContext, stop := context.WithCancel(ctx)
	runResult := make(chan error, 1)
	go func() { runResult <- worker.Run(runContext) }()
	order := make([]string, 0, 4)
	for range 4 {
		select {
		case queueName := <-handled:
			order = append(order, queueName)
		case <-time.After(time.Second):
			t.Fatal("worker did not process every queued task")
		}
	}
	stop()
	if err := <-runResult; err != nil {
		t.Fatal(err)
	}
	if strings.Join(order, ",") != "busy,quiet,busy,busy" {
		t.Fatalf("unexpected queue rotation: %v", order)
	}
}

func TestWorkerRunStopsClaimsAndDrainsWithinTheGracePeriod(t *testing.T) {
	defer goleak.VerifyNone(t, goleak.IgnoreCurrent())
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-drain")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	queueName := "go-worker-drain"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	for sequence := range 3 {
		if _, err := queue.Enqueue(ctx, "drain", map[string]any{"sequence": sequence}); err != nil {
			t.Fatal(err)
		}
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "drain-worker", Concurrency: 2,
		LeaseDuration: time.Second, PollInterval: 5 * time.Millisecond,
		ShutdownGracePeriod: 100 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}

	started := make(chan int, 3)
	finished := make(chan int, 3)
	releaseFirst := make(chan struct{})
	worker.Handle("drain", func(handlerContext context.Context, payload any, _ *workhorse.HandlerContext) (any, error) {
		sequence := int(payload.(map[string]any)["sequence"].(float64))
		started <- sequence
		if sequence == 0 {
			<-releaseFirst
		} else {
			<-handlerContext.Done()
		}
		finished <- sequence
		return nil, context.Cause(handlerContext)
	})

	runContext, stop := context.WithCancel(ctx)
	runResult := make(chan error, 1)
	go func() { runResult <- worker.Run(runContext) }()
	first := <-started
	second := <-started
	stop()
	select {
	case sequence := <-finished:
		t.Fatalf("handler %d was cancelled before the shutdown grace period elapsed", sequence)
	case <-time.After(50 * time.Millisecond):
	}
	close(releaseFirst)
	select {
	case sequence := <-started:
		t.Fatalf("worker claimed task %d after shutdown started", sequence)
	case <-time.After(150 * time.Millisecond):
	}
	select {
	case err := <-runResult:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("worker did not return after cancelling the remaining handler")
	}
	completed := map[int]bool{}
	for range 2 {
		select {
		case sequence := <-finished:
			completed[sequence] = true
		default:
			t.Fatal("worker returned before every claimed handler goroutine exited")
		}
	}
	if !completed[first] || !completed[second] {
		t.Fatalf("unexpected drained handlers: %v", completed)
	}
}

func TestWorkerRecordsARejectedSettlementAsALeaseLoss(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-stale")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-worker-stale")
	taskID, err := queue.Enqueue(ctx, "stale", nil)
	if err != nil {
		t.Fatal(err)
	}
	var logs lockedBuffer
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-worker-stale", WorkerID: "go-worker-stale", LeaseDuration: time.Second,
		Logger: slog.New(slog.NewTextHandler(&logs, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	release := make(chan struct{})
	worker.Handle("stale", func(_ context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		close(started)
		<-release
		return map[string]any{"source": "handler"}, nil
	})
	workerResult := make(chan error, 1)
	go func() {
		_, err := worker.RunOnce(ctx)
		workerResult <- err
	}()
	<-started

	var fence int64
	if err := pool.QueryRow(
		ctx,
		"SELECT fence_token FROM workhorse.task_runtime WHERE task_id = $1::uuid",
		taskID,
	).Scan(&fence); err != nil {
		t.Fatal(err)
	}
	var accepted bool
	if err := pool.QueryRow(
		ctx,
		"SELECT workhorse.complete_v1($1::uuid, $2::text, $3::bigint, $4::jsonb)",
		taskID,
		"go-worker-stale",
		fence,
		[]byte(`{"source":"competing-settlement"}`),
	).Scan(&accepted); err != nil {
		t.Fatal(err)
	}
	if !accepted {
		t.Fatal("fault-injection settlement was rejected")
	}
	close(release)
	if err := <-workerResult; err != nil {
		t.Fatalf("expected the worker to survive a rejected settlement, received %v", err)
	}
	if !strings.Contains(logs.String(), "workhorse.handler.outcome=lease_lost") {
		t.Fatalf("expected a lease_lost execution outcome, logged:\n%s", logs.String())
	}
	var result []byte
	if err := pool.QueryRow(
		ctx,
		"SELECT result::text FROM workhorse.task_outcome WHERE task_id = $1::uuid",
		taskID,
	).Scan(&result); err != nil {
		t.Fatal(err)
	}
	if string(result) != `{"source": "competing-settlement"}` {
		t.Fatalf("stale handler result overwrote the competing settlement: %s", result)
	}
}

func executeWorkerHeartbeatFixture(t *testing.T, fixture workerRuntimeFixture) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-heartbeat")
	ctx := context.Background()
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	// The first round is blocked for longer than its bound, so it fails. The later rounds are not
	// delayed, so they renew the lease in PostgreSQL.
	tracer := newFirstHeartbeatQueryTracer(3 * time.Duration(fixture.HeartbeatMS) * time.Millisecond)
	config.ConnConfig.Tracer = tracer
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-worker-heartbeat")
	taskID, err := queue.Enqueue(ctx, fixture.TaskType, nil)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:             "go-worker-heartbeat",
		WorkerID:          "go-worker-heartbeat",
		LeaseDuration:     time.Duration(fixture.LeaseMS) * time.Millisecond,
		HeartbeatInterval: time.Duration(fixture.HeartbeatMS) * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	release := make(chan struct{})
	// A failed check ends the test before the handler returns. The cleanup runs before pool.Close,
	// which waits for the handler's connection.
	var releaseOnce sync.Once
	releaseHandler := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(releaseHandler)
	worker.Handle(fixture.TaskType, func(_ context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		close(started)
		<-release
		return nil, nil
	})

	type workerRunResult struct {
		processed bool
		err       error
	}
	// The observer connects before the worker starts, so no connect runs while the first round is
	// blocked.
	observer := observeDatabase(t, ctx, databaseURL)
	workerResult := make(chan workerRunResult, 1)
	go func() {
		processed, err := worker.RunOnce(ctx)
		workerResult <- workerRunResult{processed: processed, err: err}
	}()
	<-started
	tracer.waitForCalls(t, 1)
	time.Sleep(2 * time.Duration(fixture.HeartbeatMS) * time.Millisecond)
	calls, _ := tracer.snapshot()
	if calls != fixture.ExpectedCallsWhileBlocked {
		t.Fatalf(
			"expected %d blocked heartbeat call, received %d",
			fixture.ExpectedCallsWhileBlocked,
			calls,
		)
	}
	tracer.waitForCalls(t, fixture.ExpectedMinimumCallsBeforeSettlement)
	// The rounds after the blocked one renew the lease until the handler returns, so a renewal after
	// any reading proves that they reach PostgreSQL.
	renewed := leaseExpiry(t, ctx, observer, taskID)
	waitForLeaseRenewal(t, ctx, observer, taskID, renewed, 5*time.Second)
	releaseHandler()
	result := <-workerResult
	processed, err := result.processed, result.err
	if err != nil || !processed {
		t.Fatalf("long-running attempt: processed=%t err=%v", processed, err)
	}
	calls, maxOverlap := tracer.snapshot()
	if calls < fixture.ExpectedMinimumCallsBeforeSettlement || maxOverlap != fixture.ExpectedMaximumOverlap {
		t.Fatalf(
			"unexpected heartbeat cadence: calls=%d minimum=%d maxOverlap=%d expectedOverlap=%d",
			calls,
			fixture.ExpectedMinimumCallsBeforeSettlement,
			maxOverlap,
			fixture.ExpectedMaximumOverlap,
		)
	}
	var state string
	if err := pool.QueryRow(
		ctx,
		"SELECT state FROM workhorse.task_outcome WHERE task_id = $1::uuid",
		taskID,
	).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "succeeded" {
		t.Fatalf("expected heartbeated attempt to succeed, received %s", state)
	}
}

func executeWorkerCancellationFixture(t *testing.T, fixture workerRuntimeFixture) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-cancel")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-worker-cancel")
	taskID, err := queue.Enqueue(ctx, fixture.TaskType, nil)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:             "go-worker-cancel",
		WorkerID:          "go-worker-cancel",
		LeaseDuration:     time.Duration(fixture.LeaseMS) * time.Millisecond,
		HeartbeatInterval: time.Duration(fixture.HeartbeatMS) * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	cause := make(chan error, 1)
	worker.Handle(fixture.TaskType, func(handlerContext context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		close(started)
		<-handlerContext.Done()
		cause <- context.Cause(handlerContext)
		return nil, nil
	})
	workerResult := make(chan error, 1)
	go func() {
		_, err := worker.RunOnce(ctx)
		workerResult <- err
	}()
	<-started
	requestedBy := "go-test"
	cancelResult, err := queue.Cancel(ctx, taskID, workhorse.CancellationRequest{
		RequestedBy: &requestedBy,
		Reason:      &fixture.CancelReason,
	})
	if err != nil {
		t.Fatal(err)
	}
	if cancelResult.Status != workhorse.CancelRequested || cancelResult.RequestedBy == nil ||
		*cancelResult.RequestedBy != "go-test" {
		t.Fatalf("unexpected cancellation result: %#v", cancelResult)
	}

	if err := <-workerResult; err != nil {
		t.Fatal(err)
	}
	observed := <-cause
	if !errors.Is(observed, workhorse.ErrCancellationRequested) {
		t.Fatalf("expected typed cancellation cause, received %v", observed)
	}
	var cancellation *workhorse.CancellationRequestedError
	if !errors.As(observed, &cancellation) || cancellation.TaskID != taskID {
		t.Fatalf("expected cancellation cause for %s, received %#v", taskID, observed)
	}
	if lifecycleCauseName(observed) != fixture.ExpectedAbortReason {
		t.Fatalf("expected %s, received %s", fixture.ExpectedAbortReason, lifecycleCauseName(observed))
	}
	assertWorkerFixtureTaskState(t, ctx, pool, taskID, fixture.ExpectedState)
	assertWorkerFixtureAttemptOutcomes(t, ctx, pool, taskID, []string{fixture.ExpectedAttemptOutcome})
}

// anchorDeadlineAtClaim starts a deadline fixture's budget inside the claim itself. claim_v1
// filters ready tasks on task_runtime.deadline_at and returns task.deadline_at, so the trigger
// rewrites both when the claim moves the row from ready to active. The worker then arms its local
// timer durationMs after the claim's own clock, and no stall between the test and the claim can
// spend the budget before the claim runs. The database is a throwaway conformance copy.
func anchorDeadlineAtClaim(t *testing.T, ctx context.Context, pool *pgxpool.Pool, durationMS int) {
	t.Helper()
	if _, err := pool.Exec(ctx, fmt.Sprintf(`
CREATE FUNCTION workhorse.test_anchor_deadline_at_claim() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'ready' AND NEW.state = 'active' THEN
    NEW.deadline_at := clock_timestamp() + (%d * interval '1 millisecond');
    UPDATE workhorse.task SET deadline_at = NEW.deadline_at WHERE id = NEW.task_id;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER test_anchor_deadline_at_claim BEFORE UPDATE ON workhorse.task_runtime
  FOR EACH ROW EXECUTE FUNCTION workhorse.test_anchor_deadline_at_claim()`, durationMS)); err != nil {
		t.Fatal(err)
	}
}

func executeWorkerExpirationFixture(t *testing.T, fixture workerRuntimeFixture) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-"+fixture.Mode)
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	queueName := "go-worker-" + fixture.Mode
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	options := workhorse.EnqueueOptions{
		MaxAttempts: fixture.MaxAttempts,
		RetryPolicy: map[string]any{"type": "fixed", "delayMs": 0},
	}
	if fixture.Mode == "deadline" {
		anchorDeadlineAtClaim(t, ctx, pool, fixture.DurationMS)
		placeholder := time.Now().UTC().Add(time.Hour)
		options.Deadline = &placeholder
	} else {
		options.ExecutionTimeoutMS = fixture.DurationMS
	}
	taskID, err := queue.Enqueue(ctx, fixture.TaskType, nil, options)
	if err != nil {
		t.Fatal(err)
	}
	// A maintenance tick could settle the expiry first and turn the next heartbeat into stale, so
	// only the worker's own request settles it here.
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:               queueName,
		WorkerID:            queueName,
		LeaseDuration:       time.Duration(fixture.LeaseMS) * time.Millisecond,
		HeartbeatInterval:   time.Duration(fixture.HeartbeatMS) * time.Millisecond,
		MaintenanceInterval: time.Hour,
	})
	if err != nil {
		t.Fatal(err)
	}
	causes := make(chan error, len(fixture.ExpectedAbortReasons))
	// Each attempt reports whether PostgreSQL's clock had reached the expiry it held when the
	// handler observed cancellation. Both times come from the database clock.
	afterExpiry := make(chan bool, len(fixture.ExpectedAbortReasons))
	worker.Handle(fixture.TaskType, func(handlerContext context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		field := "attempt_timeout_at"
		if fixture.Mode == "deadline" {
			field = "deadline_at"
		}
		var expiry time.Time
		if err := pool.QueryRow(ctx, fmt.Sprintf(
			"UPDATE workhorse.task_runtime SET %s = %s + ($2 * interval '1 millisecond') WHERE task_id = $1::uuid RETURNING %s",
			field,
			field,
			field,
		), taskID, fixture.LocalClockLeadMS).Scan(&expiry); err != nil {
			// The test reads one observation for each attempt, so a failed setup still sends one.
			causes <- fmt.Errorf("move the database expiry: %w", err)
			afterExpiry <- false
			return nil, err
		}
		<-handlerContext.Done()
		causes <- context.Cause(handlerContext)
		var after bool
		if err := pool.QueryRow(ctx, "SELECT clock_timestamp() >= $1", expiry).Scan(&after); err != nil {
			t.Errorf("read the database clock at cancellation: %v", err)
		}
		afterExpiry <- after
		return nil, nil
	})
	for _, expected := range fixture.ExpectedAfterRuns {
		result := make(chan struct {
			processed bool
			err       error
		}, 1)
		go func() {
			processed, err := worker.RunOnce(ctx)
			result <- struct {
				processed bool
				err       error
			}{processed: processed, err: err}
		}()
		run := <-result
		processed, err := run.processed, run.err
		if err != nil || !processed {
			t.Fatalf("expiration attempt: processed=%t err=%v", processed, err)
		}
		assertWorkerFixtureTaskState(t, ctx, pool, taskID, expected)
	}
	observedCauses := make([]string, 0, len(fixture.ExpectedAbortReasons))
	for range fixture.ExpectedAbortReasons {
		observedCauses = append(observedCauses, lifecycleCauseName(<-causes))
	}
	if strings.Join(observedCauses, ",") != strings.Join(fixture.ExpectedAbortReasons, ",") {
		t.Fatalf("unexpected expiration causes: %v", observedCauses)
	}
	for attempt := range fixture.ExpectedAbortReasons {
		if after := <-afterExpiry; after != fixture.ExpectedCancelledAfterDatabaseExpiry {
			t.Fatalf("attempt %d: cancelled after the database expiry = %t", attempt+1, after)
		}
	}
	assertWorkerFixtureAttemptOutcomes(t, ctx, pool, taskID, fixture.ExpectedAttemptOutcomes)
}

// TestWorkerKeepsRenewingWhileAnEarlyExpiryIsNotDue gives PostgreSQL an execution timeout 2.5
// seconds after the worker's copy, with a lease of two seconds. PostgreSQL answers not_due for longer
// than one lease, so the attempt reaches its database timeout only if renewal continues while the
// worker asks. A worker that stopped renewing would lose the lease first. The original timeout of
// 1.5 seconds gives the handler time to move the database copy before it falls due.
func TestWorkerKeepsRenewingWhileAnEarlyExpiryIsNotDue(t *testing.T) {
	executeWorkerExpirationFixture(t, workerRuntimeFixture{
		TaskType:                             "go.expiry-not-due",
		Mode:                                 "execution-timeout",
		DurationMS:                           1500,
		LocalClockLeadMS:                     2500,
		LeaseMS:                              2000,
		HeartbeatMS:                          200,
		MaxAttempts:                          1,
		ExpectedAbortReasons:                 []string{"ExecutionTimeoutError"},
		ExpectedCancelledAfterDatabaseExpiry: true,
		ExpectedAfterRuns: []workerFixtureTaskState{
			{State: "failed", Attempt: 1, ErrorName: "ExecutionTimeout"},
		},
		ExpectedAttemptOutcomes: []string{"timeout"},
	})
}

func executeWorkerLeaseLossFixture(t *testing.T, fixture workerRuntimeFixture) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-lease-loss")
	ctx := context.Background()
	heartbeatRelease := make(chan struct{})
	var heartbeatReleaseOnce sync.Once
	releaseHeartbeat := func() { heartbeatReleaseOnce.Do(func() { close(heartbeatRelease) }) }
	defer releaseHeartbeat()
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.Tracer = heartbeatGateTracer{release: heartbeatRelease}
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "go-worker-lease-loss"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskID, err := queue.Enqueue(ctx, fixture.TaskType, nil, workhorse.EnqueueOptions{
		MaxAttempts: fixture.MaxAttempts,
		RetryPolicy: map[string]any{"type": "fixed", "delayMs": 0},
	})
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:             queueName,
		WorkerID:          "lease-loss-worker",
		LeaseDuration:     time.Duration(fixture.LeaseMS) * time.Millisecond,
		HeartbeatInterval: time.Duration(fixture.HeartbeatMS) * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	cause := make(chan error, 1)
	type rejectedWriteResults struct {
		names    []string
		messages []string
	}
	rejectedWrites := make(chan rejectedWriteResults, 1)
	worker.Handle(fixture.TaskType, func(handlerContext context.Context, _ any, durability *workhorse.HandlerContext) (any, error) {
		close(started)
		<-handlerContext.Done()
		cause <- context.Cause(handlerContext)
		writes := []struct {
			name string
			run  func() error
		}{
			{name: "checkpoint", run: func() error {
				_, err := durability.Checkpoint("too-late", func() (any, error) { return map[string]any{"late": true}, nil })
				return err
			}},
			{name: "sleep", run: func() error { return durability.Sleep("too-late", time.Millisecond) }},
			{name: "sleepUntil", run: func() error { return durability.SleepUntil("too-late-until", time.Now().UTC()) }},
			{name: "waitForSignal", run: func() error {
				_, err := durability.WaitForSignal("too-late")
				return err
			}},
			{name: "waitForHuman", run: func() error {
				_, err := durability.WaitForHuman("too-late", map[string]any{"late": true})
				return err
			}},
			{name: "runChild", run: func() error {
				_, err := durability.RunChild("too-late", "protocol.child", nil)
				return err
			}},
			{name: "runChildren", run: func() error {
				_, err := durability.RunChildren([]workhorse.ChildTaskRequest{{Name: "too-late", Type: "protocol.child"}})
				return err
			}},
		}
		rejected := make([]string, 0, len(writes))
		messages := make([]string, 0, len(writes))
		for _, write := range writes {
			if err := write.run(); errors.Is(err, workhorse.ErrLeaseLost) {
				rejected = append(rejected, write.name)
				messages = append(messages, err.Error())
			}
		}
		rejectedWrites <- rejectedWriteResults{names: rejected, messages: messages}
		return map[string]any{"mustNotSettle": true}, nil
	})
	type runOnceResult struct {
		processed bool
		err       error
	}
	workerResult := make(chan runOnceResult, 1)
	go func() {
		processed, err := worker.RunOnce(ctx)
		workerResult <- runOnceResult{processed: processed, err: err}
	}()
	<-started
	var staleFence int64
	if err := pool.QueryRow(
		ctx,
		"SELECT fence_token FROM workhorse.task_runtime WHERE task_id = $1::uuid",
		taskID,
	).Scan(&staleFence); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx,
		"UPDATE workhorse.task_runtime SET expires_at = clock_timestamp() - interval '1 millisecond' WHERE task_id = $1::uuid",
		taskID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx,
		"SELECT * FROM workhorse.recover_expired_telemetry_v1($1::integer, $2::integer)",
		100,
		nil,
	); err != nil {
		t.Fatal(err)
	}
	releaseHeartbeat()

	run := <-workerResult
	if fixture.ExpectedRunOutcome != "processed" || !run.processed || run.err != nil {
		t.Fatalf(
			"expected run outcome %q, received processed=%t err=%v",
			fixture.ExpectedRunOutcome, run.processed, run.err,
		)
	}
	observed := <-cause
	if !errors.Is(observed, workhorse.ErrLeaseLost) {
		t.Fatalf("expected lease-loss cancellation cause, received %v", observed)
	}
	var leaseLoss *workhorse.LeaseLostError
	if !errors.As(observed, &leaseLoss) || leaseLoss.TaskID != taskID {
		t.Fatalf("expected lease-loss cause for %s, received %#v", taskID, observed)
	}
	if observed.Error() != fixture.ExpectedAbortMessage {
		t.Fatalf("expected lease-loss message %q, received %q", fixture.ExpectedAbortMessage, observed)
	}
	results := <-rejectedWrites
	if strings.Join(results.names, ",") != strings.Join(fixture.PortableRejectedWrites, ",") {
		t.Fatalf("durable writes did not all reject the stale fence")
	}
	for _, message := range results.messages {
		if message != fixture.ExpectedRejectedWriteError {
			t.Fatalf("expected rejected-write message %q, received %q", fixture.ExpectedRejectedWriteError, message)
		}
	}
	for _, portable := range fixture.PortableRejectedWrites {
		if !containsString(fixture.ExpectedRejectedWrites, portable) {
			t.Fatalf("portable rejected write %q is absent from expectedRejectedWrites", portable)
		}
	}
	assertWorkerFixtureTaskState(t, ctx, pool, taskID, fixture.ExpectedState)
	assertWorkerFixtureAttemptOutcomes(t, ctx, pool, taskID, []string{fixture.ExpectedAttemptOutcome})
	var accepted bool
	if err := pool.QueryRow(
		ctx,
		"SELECT workhorse.complete_v1($1::uuid, $2::text, $3::bigint, $4::jsonb)",
		taskID,
		"lease-loss-worker",
		staleFence,
		[]byte(`{"stale":true}`),
	).Scan(&accepted); err != nil {
		t.Fatal(err)
	}
	if accepted {
		t.Fatal("PostgreSQL accepted settlement under the recovered stale fence")
	}
}

func TestWorkerMaintenanceRecoversAnExpiredPeerLease(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-recovery")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "go-worker-recovery"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskID, err := queue.Enqueue(ctx, "recovered", nil, workhorse.EnqueueOptions{
		MaxAttempts: 2,
		RetryPolicy: map[string]any{"type": "fixed", "delayMs": 0},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx,
		"SELECT * FROM workhorse.claim_v1($1::text, $2::text, $3::integer)",
		queueName,
		"crashed-peer",
		100,
	); err != nil {
		t.Fatal(err)
	}
	time.Sleep(125 * time.Millisecond)

	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:             queueName,
		WorkerID:          "recovery-worker",
		LeaseDuration:     time.Second,
		HeartbeatInterval: 100 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("recovered", func(_ context.Context, _ any, _ *workhorse.HandlerContext) (any, error) { return nil, nil })
	processed, err := worker.RunOnce(ctx)
	if err != nil || !processed {
		t.Fatalf("recovered attempt: processed=%t err=%v", processed, err)
	}
	var state string
	var attempt int
	if err := pool.QueryRow(
		ctx,
		"SELECT state, current_attempt FROM workhorse.task_outcome WHERE task_id = $1::uuid",
		taskID,
	).Scan(&state, &attempt); err != nil {
		t.Fatal(err)
	}
	if state != "succeeded" || attempt != 2 {
		t.Fatalf("expected recovered second attempt, received state=%s attempt=%d", state, attempt)
	}
}

func TestWorkerRegistryDeliversRemotePauseAndDeregisters(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-registry-pause")
	ctx, cancel := context.WithCancel(context.Background())
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	claims := newPauseClaimGateTracer()
	config.ConnConfig.Tracer = claims
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	// If the test stops early, the held claim must end before pool.Close waits for its connection.
	t.Cleanup(func() {
		claims.releaseHeld()
		cancel()
	})

	queueName := "go-registry"
	workerID := "go-registry-worker"
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:              queueName,
		WorkerID:           workerID,
		PollInterval:       10 * time.Millisecond,
		RegistryInterval:   100 * time.Millisecond,
		ScheduleNamespaces: []string{"go-schedules"},
	})
	if err != nil {
		t.Fatal(err)
	}
	handled := make(chan struct{}, 1)
	worker.Handle("registered", func(_ context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		handled <- struct{}{}
		return nil, nil
	})
	runResult := make(chan error, 1)
	go func() { runResult <- worker.Run(ctx) }()

	deadline := time.Now().Add(5 * time.Second)
	registered := false
	var firstInstanceID string
	var clientProtocolVersion *int
	var sdkLanguage, sdkVersion *string
	for time.Now().Before(deadline) {
		var queues, scheduleNamespaces []string
		err = pool.QueryRow(
			ctx,
			"SELECT instance_id::text, queue_names, schedule_namespaces, client_protocol_version, sdk_language, sdk_version FROM workhorse.worker_registry WHERE worker_id = $1",
			workerID,
		).Scan(&firstInstanceID, &queues, &scheduleNamespaces, &clientProtocolVersion, &sdkLanguage, &sdkVersion)
		if err == nil {
			registered = len(queues) == 1 && queues[0] == queueName &&
				len(scheduleNamespaces) == 1 && scheduleNamespaces[0] == "go-schedules"
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !registered {
		t.Fatal("worker did not register")
	}
	// An operator retiring a protocol reads these columns to decide whether anything still speaks
	// it, so a registration that leaves them empty is evidence they must not have.
	if clientProtocolVersion == nil || *clientProtocolVersion != workhorse.ProtocolVersion {
		t.Fatalf("client protocol version = %v, want %d", clientProtocolVersion, workhorse.ProtocolVersion)
	}
	if sdkLanguage == nil || *sdkLanguage != "go" {
		t.Fatalf("sdk language = %v, want go", sdkLanguage)
	}
	if sdkVersion == nil || *sdkVersion != workhorse.Version {
		t.Fatalf("sdk version = %v, want %s", sdkVersion, workhorse.Version)
	}
	// A pause stops later claims. A claim that starts before the pause read still runs the tasks
	// it returns (SM-1796). The worker has one slot, so it has at most one claim in flight. The
	// tracer holds that claim at its statement until the worker stores the pause.
	claims.holding.Store(true)
	select {
	case <-claims.held:
	case <-time.After(10 * time.Second):
		t.Fatal("worker did not start a claim")
	}
	if _, err := pool.Exec(
		ctx,
		"SELECT * FROM workhorse.set_worker_paused_v1($1, true, $2, $3, $4)",
		workerID,
		"test",
		"remote pause",
		"pause-request",
	); err != nil {
		t.Fatal(err)
	}
	// The registry loop stores the pause after its refresh statement returns. It starts the next
	// refresh after that store. So a refresh after the pause-reading refresh proves the store.
	deadline = time.Now().Add(10 * time.Second)
	var pauseRead *time.Time
	stored := false
	for !stored && time.Now().Before(deadline) {
		var refreshedAt time.Time
		var refreshed bool
		if err := pool.QueryRow(
			ctx,
			"SELECT last_heartbeat_at, last_heartbeat_at > paused_at FROM workhorse.worker_registry WHERE worker_id = $1",
			workerID,
		).Scan(&refreshedAt, &refreshed); err != nil {
			t.Fatal(err)
		}
		if pauseRead == nil && refreshed {
			pauseRead = &refreshedAt
		} else if pauseRead != nil && refreshedAt.After(*pauseRead) {
			stored = true
			continue
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !stored {
		t.Fatal("worker did not consume the remote pause")
	}
	// The held claim finds no task. The dispatch loop reads the pause before it can start another.
	claims.releaseHeld()
	select {
	case <-claims.heldEnded:
	case <-time.After(10 * time.Second):
		t.Fatal("the claim from before the pause did not answer")
	}
	claimStarts := claims.started.Load()

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	if _, err := queue.Enqueue(ctx, "registered", nil); err != nil {
		t.Fatal(err)
	}
	select {
	case <-handled:
		t.Fatal("worker claimed while remotely paused")
	case <-time.After(250 * time.Millisecond):
	}
	if started := claims.started.Load(); started != claimStarts {
		t.Fatalf("worker started %d claims while remotely paused", started-claimStarts)
	}
	if _, err := pool.Exec(
		ctx,
		"SELECT * FROM workhorse.set_worker_paused_v1($1, false, $2, $3, $4)",
		workerID,
		"test",
		"remote resume",
		"resume-request",
	); err != nil {
		t.Fatal(err)
	}
	select {
	case <-handled:
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not resume after the remote pause cleared")
	}

	cancel()
	if err := <-runResult; err != nil {
		t.Fatal(err)
	}
	var registrations int
	if err := pool.QueryRow(
		context.Background(),
		"SELECT count(*) FROM workhorse.worker_registry WHERE worker_id = $1",
		workerID,
	).Scan(&registrations); err != nil {
		t.Fatal(err)
	}
	if registrations != 0 {
		t.Fatalf("expected graceful deregistration, received %d rows", registrations)
	}

	restartContext, stopRestart := context.WithCancel(context.Background())
	restartResult := make(chan error, 1)
	go func() { restartResult <- worker.Run(restartContext) }()
	deadline = time.Now().Add(5 * time.Second)
	var secondInstanceID string
	for time.Now().Before(deadline) {
		err = pool.QueryRow(
			restartContext,
			"SELECT instance_id::text FROM workhorse.worker_registry WHERE worker_id = $1",
			workerID,
		).Scan(&secondInstanceID)
		if err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if secondInstanceID == "" || secondInstanceID == firstInstanceID {
		t.Fatalf("expected a fresh worker instance, received first=%s second=%s", firstInstanceID, secondInstanceID)
	}
	stopRestart()
	if err := <-restartResult; err != nil {
		t.Fatal(err)
	}
	processed, err := worker.RunOnce(context.Background())
	if err != nil || processed {
		t.Fatalf("one-shot lifecycle: processed=%t err=%v", processed, err)
	}
	if err := pool.QueryRow(
		context.Background(),
		"SELECT count(*) FROM workhorse.worker_registry WHERE worker_id = $1",
		workerID,
	).Scan(&registrations); err != nil {
		t.Fatal(err)
	}
	if registrations != 0 {
		t.Fatalf("expected one-shot deregistration, received %d rows", registrations)
	}
}

func TestWorkerMaintenanceCadenceDoesNotWaitForAHandler(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-maintenance-cadence")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "go-worker-maintenance-cadence"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	peerTaskID, err := queue.Enqueue(ctx, "peer", nil, workhorse.EnqueueOptions{
		MaxAttempts: 2,
		RetryPolicy: map[string]any{"type": "fixed", "delayMs": 0},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx,
		"SELECT * FROM workhorse.claim_v1($1::text, $2::text, $3::integer)",
		queueName,
		"blocked-peer",
		5000,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := queue.Enqueue(ctx, "long-handler", nil, workhorse.EnqueueOptions{Priority: 100}); err != nil {
		t.Fatal(err)
	}

	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:               queueName,
		WorkerID:            "maintenance-worker",
		LeaseDuration:       time.Second,
		HeartbeatInterval:   100 * time.Millisecond,
		PollInterval:        5 * time.Millisecond,
		MaintenanceInterval: 100 * time.Millisecond,
		ShutdownGracePeriod: 20 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	worker.Handle("long-handler", func(handlerContext context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		close(started)
		<-handlerContext.Done()
		return nil, context.Cause(handlerContext)
	})
	runContext, stop := context.WithCancel(ctx)
	workerResult := make(chan error, 1)
	go func() { workerResult <- worker.Run(runContext) }()
	<-started
	if _, err := pool.Exec(
		ctx,
		"UPDATE workhorse.task_runtime SET expires_at = clock_timestamp() - interval '1 millisecond' WHERE task_id = $1::uuid",
		peerTaskID,
	); err != nil {
		t.Fatal(err)
	}

	deadline := time.NewTimer(time.Second)
	ticker := time.NewTicker(5 * time.Millisecond)
	recovered := false
	for !recovered {
		select {
		case <-deadline.C:
			t.Fatal("maintenance did not recover the peer while the handler was running")
		case <-ticker.C:
			var state string
			var attempt int
			if err := pool.QueryRow(
				ctx,
				"SELECT state, current_attempt FROM workhorse.task_runtime WHERE task_id = $1::uuid",
				peerTaskID,
			).Scan(&state, &attempt); err != nil {
				t.Fatal(err)
			}
			recovered = state == "ready" && attempt == 2
		}
	}
	deadline.Stop()
	ticker.Stop()
	stop()
	if err := <-workerResult; err != nil {
		t.Fatalf("expected a clean drain after recovery assertion, received %v", err)
	}
}

func TestWorkerParticipatesInSlowMaintenance(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-slow-maintenance")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(
		ctx,
		"UPDATE workhorse.maintenance_state SET last_completed_at = NULL WHERE routine_name = 'terminal_storage'",
	); err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-slow-maintenance", WorkerID: "go-slow-maintenance-worker",
	})
	if err != nil {
		t.Fatal(err)
	}
	if processed, err := worker.RunOnce(ctx); err != nil || processed {
		t.Fatalf("maintenance run: processed=%t err=%v", processed, err)
	}
	var completedAt *time.Time
	if err := pool.QueryRow(
		ctx,
		"SELECT last_completed_at FROM workhorse.maintenance_state WHERE routine_name = 'terminal_storage'",
	).Scan(&completedAt); err != nil {
		t.Fatal(err)
	}
	if completedAt == nil {
		t.Fatal("Go worker did not run terminal-storage maintenance")
	}
}

// maintenanceTimeTracer records the arguments of each run_maintenance_v1 call.
type maintenanceTimeTracer struct {
	mu        sync.Mutex
	arguments [][]any
}

func (tracer *maintenanceTimeTracer) TraceQueryStart(
	ctx context.Context,
	_ *pgx.Conn,
	data pgx.TraceQueryStartData,
) context.Context {
	if strings.Contains(data.SQL, "run_maintenance_v1") {
		tracer.mu.Lock()
		tracer.arguments = append(tracer.arguments, data.Args)
		tracer.mu.Unlock()
	}
	return ctx
}

func (*maintenanceTimeTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

// Maintenance writes shared due times and retention cutoffs, so the worker binds the text "now"
// and PostgreSQL chooses the time. A host clock that runs fast or slow cannot move them.
func TestWorkerBindsTheDatabaseClockToMaintenance(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-maintenance-time")
	ctx := context.Background()
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	tracer := &maintenanceTimeTracer{}
	config.ConnConfig.Tracer = tracer
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(
		ctx,
		"UPDATE workhorse.maintenance_state SET last_started_at = NULL, last_completed_at = NULL "+
			"WHERE routine_name = 'history_partitions'",
	); err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-maintenance-time", WorkerID: "go-maintenance-time-worker",
	})
	if err != nil {
		t.Fatal(err)
	}
	if processed, err := worker.RunOnce(ctx); err != nil || processed {
		t.Fatalf("maintenance run: processed=%t err=%v", processed, err)
	}
	tracer.mu.Lock()
	arguments := tracer.arguments
	tracer.mu.Unlock()
	if len(arguments) != 1 || len(arguments[0]) != 1 || arguments[0][0] != "now" {
		t.Fatalf("run_maintenance_v1 arguments = %#v, want one call with \"now\"", arguments)
	}
	var ahead bool
	if err := pool.QueryRow(
		ctx,
		"SELECT last_started_at > clock_timestamp() FROM workhorse.maintenance_state "+
			"WHERE routine_name = 'history_partitions' AND last_started_at IS NOT NULL",
	).Scan(&ahead); err != nil {
		t.Fatal(err)
	}
	if ahead {
		t.Fatal("history partition preparation started after the database time")
	}
}

func TestWorkerOwnershipLifecycleSupportsASingleConnectionPool(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-single-connection")
	ctx := context.Background()
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = 1
	// Keep the heartbeat on the sole connection so settlement must wait for it.
	tracer := newHeartbeatQueryTracer(150 * time.Millisecond)
	config.ConnConfig.Tracer = tracer
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "go-worker-single-connection"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskID, err := queue.Enqueue(ctx, "single-connection", nil)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:               queueName,
		WorkerID:            "single-connection-worker",
		SharedHeartbeats:    true,
		LeaseDuration:       10 * time.Second,
		HeartbeatInterval:   100 * time.Millisecond,
		PollInterval:        5 * time.Millisecond,
		MaintenanceInterval: 100 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	handlerStarted := make(chan struct{})
	releaseHandler := make(chan struct{})
	var releaseHandlerOnce sync.Once
	release := func() { releaseHandlerOnce.Do(func() { close(releaseHandler) }) }
	t.Cleanup(release)
	worker.Handle("single-connection", func(_ context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		close(handlerStarted)
		<-releaseHandler
		return map[string]any{"settled": true}, nil
	})
	workerResult := make(chan error, 1)
	go func() {
		processed, err := worker.RunOnce(ctx)
		if err == nil && !processed {
			err = errors.New("single-connection worker did not process the task")
		}
		workerResult <- err
	}()
	select {
	case <-handlerStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("single-connection worker did not start the handler")
	}
	tracer.waitForCalls(t, 1)
	release()
	select {
	case err := <-workerResult:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("single-connection worker did not settle the heartbeated task")
	}
	var settled bool
	if err := pool.QueryRow(
		ctx,
		"SELECT EXISTS (SELECT 1 FROM workhorse.task_outcome WHERE task_id = $1::uuid)",
		taskID,
	).Scan(&settled); err != nil {
		t.Fatal(err)
	}
	if !settled {
		t.Fatal("single-connection worker returned before persisting the task outcome")
	}
}

func TestWorkerNotificationsWakeClaimsAndReconnectAfterListenerLoss(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-notifications")
	ctx := context.Background()
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = 2
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "go-worker-notifications"
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:               queueName,
		WorkerID:            "notification-worker",
		SharedHeartbeats:    true,
		LeaseDuration:       time.Second,
		HeartbeatInterval:   100 * time.Millisecond,
		PollInterval:        5 * time.Second,
		MaintenanceInterval: 100 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	handled := make(chan string, 2)
	worker.Handle("notified", func(_ context.Context, payload any, _ *workhorse.HandlerContext) (any, error) {
		value := payload.(map[string]any)["value"].(string)
		handled <- value
		return nil, nil
	})
	runContext, stop := context.WithCancel(ctx)
	workerResult := make(chan error, 1)
	go func() { workerResult <- worker.Run(runContext) }()

	listenerPID := waitForNotificationListener(t, ctx, pool, 0)
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	if _, err := queue.Enqueue(ctx, "notified", map[string]any{"value": "first"}); err != nil {
		t.Fatal(err)
	}
	assertHandledBeforePoll(t, handled, "first")

	if _, err := pool.Exec(ctx, "SELECT pg_terminate_backend($1)", listenerPID); err != nil {
		t.Fatal(err)
	}
	if _, err := queue.Enqueue(ctx, "notified", map[string]any{"value": "during-reconnect"}); err != nil {
		t.Fatal(err)
	}
	waitForNotificationListener(t, ctx, pool, listenerPID)
	assertHandledBeforePoll(t, handled, "during-reconnect")

	stop()
	if err := <-workerResult; err != nil {
		t.Fatal(err)
	}
	connections := make([]*pgxpool.Conn, 0, config.MaxConns)
	for range config.MaxConns {
		connection, err := pool.Acquire(ctx)
		if err != nil {
			t.Fatal(err)
		}
		connections = append(connections, connection)
	}
	defer func() {
		for _, connection := range connections {
			connection.Release()
		}
	}()
	for _, connection := range connections {
		var listeningChannels int
		if err := connection.QueryRow(ctx, "SELECT count(*) FROM pg_listening_channels()").Scan(&listeningChannels); err != nil {
			t.Fatal(err)
		}
		if listeningChannels != 0 {
			t.Fatal("worker returned a subscribed notification connection to the caller-owned pool")
		}
	}
}

func TestWorkerPollingOnlyFallbackLogsAndClaimsOnThePollInterval(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-polling-only")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	var logs lockedBuffer
	queueName := "go-worker-polling-only"
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:               queueName,
		WorkerID:            "polling-only-worker",
		LeaseDuration:       time.Second,
		HeartbeatInterval:   100 * time.Millisecond,
		PollInterval:        50 * time.Millisecond,
		MaintenanceInterval: 100 * time.Millisecond,
		PollingOnly:         true,
		Logger:              slog.New(slog.NewTextHandler(&logs, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	handled := make(chan string, 1)
	worker.Handle("polled", func(_ context.Context, payload any, _ *workhorse.HandlerContext) (any, error) {
		handled <- payload.(map[string]any)["value"].(string)
		return nil, nil
	})
	runContext, stop := context.WithCancel(ctx)
	workerResult := make(chan error, 1)
	go func() { workerResult <- worker.Run(runContext) }()

	waitForWorkerLog(t, &logs, "notification listener disabled")
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	if _, err := queue.Enqueue(ctx, "polled", map[string]any{"value": "fallback"}); err != nil {
		t.Fatal(err)
	}
	assertHandledWithin(t, handled, "fallback", time.Second)

	stop()
	if err := <-workerResult; err != nil {
		t.Fatal(err)
	}
}

func TestWorkerPollingContinuesDuringNotificationReconnectBackoff(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-notification-backoff")
	ctx := context.Background()
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = 3
	reconnectRelease := make(chan struct{})
	var reconnectReleaseOnce sync.Once
	releaseReconnect := func() { reconnectReleaseOnce.Do(func() { close(reconnectRelease) }) }
	defer releaseReconnect()
	reconnectGate := newNotificationReconnectGateTracer(reconnectRelease)
	config.ConnConfig.Tracer = reconnectGate
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	var logs lockedBuffer
	queueName := "go-worker-notification-backoff"
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:               queueName,
		WorkerID:            "notification-backoff-worker",
		LeaseDuration:       time.Second,
		HeartbeatInterval:   100 * time.Millisecond,
		PollInterval:        5 * time.Millisecond,
		MaintenanceInterval: 100 * time.Millisecond,
		Logger:              slog.New(slog.NewTextHandler(&logs, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	handled := make(chan string, 1)
	worker.Handle("polled-during-backoff", func(_ context.Context, payload any, _ *workhorse.HandlerContext) (any, error) {
		handled <- payload.(map[string]any)["value"].(string)
		return nil, nil
	})
	runContext, stop := context.WithCancel(ctx)
	workerResult := make(chan error, 1)
	go func() { workerResult <- worker.Run(runContext) }()

	listenerPID := waitForNotificationListener(t, ctx, pool, 0)
	if _, err := pool.Exec(ctx, "SELECT pg_terminate_backend($1)", listenerPID); err != nil {
		t.Fatal(err)
	}
	waitForWorkerLog(t, &logs, "notification listener unavailable")
	reconnectGate.waitForReconnect(t)
	// The test enqueues only after two empty claims that start in the backoff. One worker slot
	// gives one claim at a time. Without polls, the worker has at most two such claims. One
	// claim can start before the listener fails, and the wake of the failure starts the other.
	// After them, only a poll can claim the task.
	emptyClaimsDeadline := time.Now().Add(30 * time.Second)
	for reconnectGate.emptyClaimsInBackoff.Load() < 2 {
		if !time.Now().Before(emptyClaimsDeadline) {
			t.Fatal("worker did not poll while the listener reconnects")
		}
		time.Sleep(time.Millisecond)
	}
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	if _, err := queue.Enqueue(ctx, "polled-during-backoff", map[string]any{"value": "backoff"}); err != nil {
		t.Fatal(err)
	}
	// While the worker does not listen, its empty-claim backoff grows toward 5 s, and a host stall
	// adds to that. The reconnect stays held, so no notification wakes the worker in this wait.
	assertHandledWithin(t, handled, "backoff", 30*time.Second)
	var replacementListeners int
	if err := pool.QueryRow(
		ctx,
		`SELECT count(*)
		 FROM pg_stat_activity
		 WHERE datname = current_database()
		   AND query = 'LISTEN workhorse_tasks'
		   AND pid <> $1`,
		listenerPID,
	).Scan(&replacementListeners); err != nil {
		t.Fatal(err)
	}
	if replacementListeners != 0 {
		t.Fatal("listener reconnected before polling covered the notification gap")
	}
	releaseReconnect()
	waitForNotificationListener(t, ctx, pool, listenerPID)
	stop()
	if err := <-workerResult; err != nil {
		t.Fatal(err)
	}
}

func waitForWorkerLog(t *testing.T, logs *lockedBuffer, message string) {
	t.Helper()
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	for !strings.Contains(logs.String(), message) {
		select {
		case <-deadline.C:
			t.Fatalf("worker did not log %q", message)
		default:
			time.Sleep(time.Millisecond)
		}
	}
}

func waitForNotificationListener(t *testing.T, ctx context.Context, pool *pgxpool.Pool, previousPID int32) int32 {
	t.Helper()
	deadline := time.NewTimer(2 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var pid int32
		err := pool.QueryRow(
			ctx,
			`SELECT pid
			 FROM pg_stat_activity
			 WHERE datname = current_database()
			   AND query = 'LISTEN workhorse_tasks'
			   AND pid <> pg_backend_pid()
			   AND pid <> $1
			 ORDER BY backend_start DESC
			 LIMIT 1`,
			previousPID,
		).Scan(&pid)
		if err == nil {
			return pid
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal(err)
		}
		select {
		case <-deadline.C:
			t.Fatal("worker did not establish its dedicated notification listener")
		case <-ticker.C:
		}
	}
}

func assertHandledBeforePoll(t *testing.T, handled <-chan string, expected string) {
	t.Helper()
	assertHandledWithin(t, handled, expected, time.Second)
}

func assertHandledWithin(t *testing.T, handled <-chan string, expected string, timeout time.Duration) {
	t.Helper()
	select {
	case actual := <-handled:
		if actual != expected {
			t.Fatalf("expected handler payload %q, received %q", expected, actual)
		}
	case <-time.After(timeout):
		t.Fatalf("notification did not wake %q before the poll interval", expected)
	}
}

type statementRecordingTracer struct {
	mu         sync.Mutex
	statements []string
}

func (tracer *statementRecordingTracer) TraceQueryStart(
	ctx context.Context,
	_ *pgx.Conn,
	data pgx.TraceQueryStartData,
) context.Context {
	tracer.mu.Lock()
	tracer.statements = append(tracer.statements, data.SQL)
	tracer.mu.Unlock()
	return ctx
}

func (*statementRecordingTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func (tracer *statementRecordingTracer) count(fragment string) int {
	tracer.mu.Lock()
	defer tracer.mu.Unlock()
	total := 0
	for _, statement := range tracer.statements {
		if strings.Contains(statement, fragment) {
			total++
		}
	}
	return total
}

func TestWorkerClaimPathLeavesPromotionToTheMaintenanceTick(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-claim-statements")
	ctx := context.Background()
	tracer := &statementRecordingTracer{}
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.Tracer = tracer
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-claim-statements")
	retryAt := time.Now().Add(-time.Second)
	if _, err := queue.Enqueue(ctx, "noop", map[string]any{}, workhorse.EnqueueOptions{RunAt: &retryAt}); err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queues: []string{"go-claim-statements", "go-claim-statements-secondary"}, WorkerID: "go-claim-statements",
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("noop", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return nil, nil
	})

	tracer.mu.Lock()
	tracer.statements = nil
	tracer.mu.Unlock()
	processed, err := worker.RunOnce(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !processed {
		t.Fatal("worker did not claim the due task")
	}
	if promotions := tracer.count("promote_v1"); promotions != 0 {
		t.Fatalf("claim path issued promote_v1 %d times; promotion belongs to tick_v1", promotions)
	}
	if ticks := tracer.count("tick_v1"); ticks != 1 {
		t.Fatalf("expected one maintenance tick, recorded %d", ticks)
	}
	if claims := tracer.count("claim_many_v1"); claims != 1 {
		t.Fatalf("expected one claim for the first queue, recorded %d", claims)
	}
}

// A rolling deployment runs old and new workers side by side, and a claim carries no task-type
// filter. The worker without the handler must hand the task back untouched: failing it would spend
// the attempt, and a task allowed one attempt would be dead-lettered without ever running. The
// release is fenced, so a worker that no longer owns the generation is refused.
func TestWorkerReleasesATaskOfAnUnregisteredTypeWithItsAttemptIntact(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-release")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-worker-release")
	taskID, err := queue.Enqueue(ctx, "delivery.only-new-workers", nil, workhorse.EnqueueOptions{
		MaxAttempts: 1,
	})
	if err != nil {
		t.Fatal(err)
	}

	oldRelease, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-worker-release", WorkerID: "go-worker-release-old", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	oldRelease.Handle("delivery.some-other-type", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		t.Error("the old release must not run a task type it does not handle")
		return nil, nil
	})
	// A pass that only handed its claim back made no progress, so it reports none. A caller
	// looping RunOnce, and Run's own fill loop, then back off instead of spinning on the task.
	processed, err := oldRelease.RunOnce(ctx)
	if err != nil || processed {
		t.Fatalf("release pass: processed=%t err=%v", processed, err)
	}

	var state string
	var attempt int
	var workerID *string
	if err := pool.QueryRow(
		ctx,
		"SELECT state, current_attempt, worker_id FROM workhorse.task_runtime WHERE task_id = $1::uuid",
		taskID,
	).Scan(&state, &attempt, &workerID); err != nil {
		t.Fatal(err)
	}
	if state != "ready" || attempt != 1 || workerID != nil {
		t.Fatalf("the release did not return the claim intact: state=%s attempt=%d worker=%v", state, attempt, workerID)
	}
	var closedAttempts, releases int
	if err := pool.QueryRow(
		ctx,
		`SELECT
		   (SELECT count(*)::integer FROM workhorse.attempt_history WHERE task_id = $1::uuid),
		   (SELECT count(*)::integer FROM workhorse.task_event
		     WHERE task_id = $1::uuid AND event_type = 'released')`,
		taskID,
	).Scan(&closedAttempts, &releases); err != nil {
		t.Fatal(err)
	}
	if closedAttempts != 0 || releases != 1 {
		t.Fatalf("unexpected history: attempts=%d releases=%d", closedAttempts, releases)
	}

	newRelease, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-worker-release", WorkerID: "go-worker-release-new", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	invocations := 0
	newRelease.Handle("delivery.only-new-workers", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		invocations++
		return map[string]any{"ran": true}, nil
	})
	processed, err = newRelease.RunOnce(ctx)
	if err != nil || !processed {
		t.Fatalf("handler pass: processed=%t err=%v", processed, err)
	}
	if invocations != 1 {
		t.Fatalf("expected one handler invocation, received %d", invocations)
	}
	var outcome string
	var finalAttempt int
	if err := pool.QueryRow(
		ctx,
		"SELECT state, current_attempt FROM workhorse.task_outcome WHERE task_id = $1::uuid",
		taskID,
	).Scan(&outcome, &finalAttempt); err != nil {
		t.Fatal(err)
	}
	if outcome != "succeeded" || finalAttempt != 1 {
		t.Fatalf("unexpected final outcome: state=%s attempt=%d", outcome, finalAttempt)
	}
}

// The release is a fenced owned transition: a worker whose generation PostgreSQL no longer
// recognizes cannot return a task another owner may already be running.
func TestReleaseOwnedRefusesAStaleFence(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "release-fence")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-release-fence")
	taskID, err := queue.Enqueue(ctx, "release.fence", nil, workhorse.EnqueueOptions{})
	if err != nil {
		t.Fatal(err)
	}
	var fence int64
	if err := pool.QueryRow(
		ctx,
		"SELECT fence_token FROM workhorse.claim_v1($1::text, $2::text, 30000)",
		"go-release-fence", "release-fence-owner",
	).Scan(&fence); err != nil {
		t.Fatal(err)
	}

	release := func(worker string, token int64) string {
		var status string
		if err := pool.QueryRow(
			ctx,
			"SELECT workhorse.release_owned_v1($1::uuid, $2::text, $3::bigint) AS status",
			taskID, worker, token,
		).Scan(&status); err != nil {
			t.Fatal(err)
		}
		return status
	}
	if status := release("release-fence-owner", fence+1); status != "stale" {
		t.Fatalf("a stale fence was accepted: %s", status)
	}
	if status := release("another-worker", fence); status != "stale" {
		t.Fatalf("a foreign worker was accepted: %s", status)
	}
	if status := release("release-fence-owner", fence); status != "released" {
		t.Fatalf("the owner's release was refused: %s", status)
	}
	if status := release("release-fence-owner", fence); status != "stale" {
		t.Fatalf("a released lease was accepted twice: %s", status)
	}
}

// pgx hands the worker a jsonb string already decoded. Every durable value that is a JSON string
// has to reach the handler unchanged, and none of them may stop Run.
func TestWorkerRunDeliversJSONStringValuesUnchanged(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-string-values")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "go-worker-string-values"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskID, err := queue.Enqueue(ctx, "strings.parent", "before")
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "go-string-worker", LeaseDuration: time.Second,
		PollInterval: 5 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}

	waiting := make(chan struct{}, 10)
	worker.Handle("strings.child", func(_ context.Context, payload any, _ *workhorse.HandlerContext) (any, error) {
		if payload != "child-input" {
			return nil, fmt.Errorf("child payload %#v", payload)
		}
		return "child-output", nil
	})
	worker.Handle("strings.parent", func(
		_ context.Context,
		payload any,
		handlerContext *workhorse.HandlerContext,
	) (any, error) {
		if payload != "before" {
			return nil, fmt.Errorf("parent payload %#v", payload)
		}
		checkpoint, err := handlerContext.Checkpoint("saved", func() (any, error) {
			return "checkpointed", nil
		})
		if err != nil {
			return nil, err
		}
		if _, err := handlerContext.SetProgress("halfway"); err != nil {
			return nil, err
		}
		progress, err := handlerContext.GetProgress()
		if err != nil {
			return nil, err
		}
		child, err := handlerContext.RunChild(
			"child", "strings.child", "child-input", workhorse.EnqueueOptions{Queue: queueName},
		)
		if err != nil {
			return nil, err
		}
		waiting <- struct{}{}
		signal, err := handlerContext.WaitForSignal("approval")
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"checkpoint": checkpoint, "progress": progress.Value, "child": child, "signal": signal,
		}, nil
	})

	runContext, stop := context.WithCancel(ctx)
	runResult := make(chan error, 1)
	go func() { runResult <- worker.Run(runContext) }()

	select {
	case <-waiting:
	case err := <-runResult:
		t.Fatalf("Run ended before the parent reached its wait: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("the parent never reached its wait")
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		delivery, err := queue.SendSignal(ctx, taskID, "approval", "approved", workhorse.ExternalWaitDelivery{
			IdempotencyKey: "string-approval", RequestedBy: "go-test",
		})
		if err != nil {
			t.Fatal(err)
		}
		if delivery.Status == workhorse.SignalDelivered {
			if delivery.Payload != "approved" {
				t.Fatalf("signal delivery returned payload %#v", delivery.Payload)
			}
			break
		}
		if delivery.Status != workhorse.SignalNotWaiting || time.Now().After(deadline) {
			t.Fatalf("unexpected signal delivery: %#v", delivery)
		}
		time.Sleep(10 * time.Millisecond)
	}

	var state string
	var result any
	for {
		if err := pool.QueryRow(
			ctx,
			"SELECT state, result FROM workhorse.task_outcome WHERE task_id = $1::uuid",
			taskID,
		).Scan(&state, &result); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal(err)
		}
		if state != "" || time.Now().After(deadline) {
			break
		}
		select {
		case err := <-runResult:
			t.Fatalf("Run ended before the parent settled: %v", err)
		case <-time.After(10 * time.Millisecond):
		}
	}
	stop()
	if err := <-runResult; err != nil {
		t.Fatalf("Run returned %v", err)
	}
	expected := map[string]any{
		"checkpoint": "checkpointed", "progress": "halfway", "child": "child-output", "signal": "approved",
	}
	if state != "succeeded" || fmt.Sprint(result) != fmt.Sprint(expected) {
		t.Fatalf("unexpected parent outcome: state=%s result=%#v", state, result)
	}
}
