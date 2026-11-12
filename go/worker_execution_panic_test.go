package workhorse_test

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

// panickingResult is a handler result whose MarshalJSON panics.
type panickingResult struct{}

func (panickingResult) MarshalJSON() ([]byte, error) { panic("the encoder failed") }

// panickingError is a handler error whose Error method panics.
type panickingError struct{}

func (panickingError) Error() string { panic("the message failed") }

// panickingLogHandler is a slog.Handler that panics on each record.
type panickingLogHandler struct{ records *atomic.Int64 }

func (panickingLogHandler) Enabled(context.Context, slog.Level) bool { return true }
func (handler panickingLogHandler) Handle(context.Context, slog.Record) error {
	handler.records.Add(1)
	panic("the logger failed")
}
func (handler panickingLogHandler) WithAttrs([]slog.Attr) slog.Handler { return handler }
func (handler panickingLogHandler) WithGroup(string) slog.Handler      { return handler }

// panicTestPool opens a pool of four connections, as a CI runner has, and a separate connection
// that the test reads the outcomes through, so the reads never wait on the pool of the worker.
func panicTestPool(t *testing.T, name string) (*pgxpool.Pool, *pgx.Conn) {
	t.Helper()
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), name)
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = 4
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	observer, err := pgx.Connect(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = observer.Close(context.Background()) })
	return pool, observer
}

// awaitOutcomes returns the terminal outcome of each task once every task has one. It fails the
// test if Run returns first.
func awaitOutcomes(
	t *testing.T,
	observer *pgx.Conn,
	taskIDs []string,
	runResult <-chan error,
) map[string]tierOutcome {
	t.Helper()
	deadline := time.Now().Add(workerRunDeadline)
	for {
		rows, err := observer.Query(context.Background(), `SELECT task_id::text, state, current_attempt,
			coalesce(error->>'name', ''), coalesce(error->>'message', '')
			FROM workhorse.task_outcome WHERE task_id = ANY($1::uuid[])`, taskIDs)
		if err != nil {
			t.Fatal(err)
		}
		outcomes := map[string]tierOutcome{}
		for rows.Next() {
			var taskID string
			var outcome tierOutcome
			if err := rows.Scan(
				&taskID, &outcome.state, &outcome.attempt, &outcome.errorName, &outcome.errorMessage,
			); err != nil {
				t.Fatal(err)
			}
			outcomes[taskID] = outcome
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		if len(outcomes) == len(taskIDs) {
			return outcomes
		}
		select {
		case err := <-runResult:
			t.Fatalf("Run returned %v before every task settled", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("only %d of %d tasks settled in %s", len(outcomes), len(taskIDs), workerRunDeadline)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// SM-1938: user code that runs on the execution goroutine outside the handler could panic, and the
// panic ended the process. The worker now fails that attempt, or, for a logger, drops the record.
// The worker has one slot, and a second task follows the first, so the second task settles only if
// the slot returned after the panic.
func TestWorkerSettlesAPanicOutsideTheHandlerAndKeepsClaiming(t *testing.T) {
	pool, observer := panicTestPool(t, "worker-execution-panic")
	ctx := context.Background()
	for _, test := range []struct {
		name        string
		maxAttempts int
		options     func(*workhorse.WorkerOptions, *atomic.Int64)
		handler     workhorse.Handler
		want        tierOutcome
	}{
		{
			name: "result-marshal", maxAttempts: 1,
			handler: func(context.Context, any, *workhorse.HandlerContext) (any, error) {
				return panickingResult{}, nil
			},
			want: tierOutcome{
				state: "failed", attempt: 1, errorName: "HandlerPanicError",
				errorMessage: "result encoding for panicking panicked: the encoder failed",
			},
		},
		{
			name: "retry-delay", maxAttempts: 2,
			options: func(options *workhorse.WorkerOptions, calls *atomic.Int64) {
				options.RetryDelay = func(int, workhorse.ClaimedTask) *time.Duration {
					calls.Add(1)
					panic("the delay failed")
				}
			},
			handler: func(context.Context, any, *workhorse.HandlerContext) (any, error) {
				return nil, errors.New("the work failed")
			},
			// The persisted retry policy chooses the delay, so the task retries once and then fails.
			want: tierOutcome{
				state: "failed", attempt: 2, errorName: "HandlerPanicError",
				errorMessage: "RetryDelay for panicking panicked: the delay failed; " +
					"the attempt failed with: the work failed",
			},
		},
		{
			name: "error-message", maxAttempts: 1,
			handler: func(context.Context, any, *workhorse.HandlerContext) (any, error) {
				return nil, panickingError{}
			},
			want: tierOutcome{
				state: "failed", attempt: 1, errorName: "HandlerPanicError",
				errorMessage: "worker execution for panicking panicked outside the handler: the message failed",
			},
		},
		{
			name: "logger", maxAttempts: 1,
			options: func(options *workhorse.WorkerOptions, records *atomic.Int64) {
				options.Logger = slog.New(panickingLogHandler{records: records})
			},
			handler: func(context.Context, any, *workhorse.HandlerContext) (any, error) {
				return "done", nil
			},
			// The task completed in PostgreSQL before the logger panicked on its record.
			want: tierOutcome{state: "succeeded", attempt: 1},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			queueName := "go-execution-panic-" + test.name
			queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
			panickingID, err := queue.Enqueue(ctx, "panicking", nil, workhorse.EnqueueOptions{
				MaxAttempts: test.maxAttempts, RetryPolicy: map[string]any{"type": "fixed", "delayMs": 0},
			})
			if err != nil {
				t.Fatal(err)
			}
			plainID, err := queue.Enqueue(ctx, "plain", nil, workhorse.EnqueueOptions{MaxAttempts: 1})
			if err != nil {
				t.Fatal(err)
			}
			var calls atomic.Int64
			options := workhorse.WorkerOptions{
				Queue: queueName, WorkerID: queueName, Concurrency: 1,
				LeaseDuration: 5 * time.Second, PollInterval: 5 * time.Millisecond,
			}
			if test.options != nil {
				test.options(&options, &calls)
			}
			worker, err := workhorse.NewWorker(pool, options)
			if err != nil {
				t.Fatal(err)
			}
			worker.Handle("panicking", test.handler)
			worker.Handle("plain", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
				return "plain", nil
			})

			runContext, stop := context.WithCancel(ctx)
			defer stop()
			runResult := make(chan error, 1)
			go func() { runResult <- worker.Run(runContext) }()
			outcomes := awaitOutcomes(t, observer, []string{panickingID, plainID}, runResult)
			stop()
			if err := awaitSignal(t, runResult, "Run to return after the stop"); err != nil {
				t.Fatalf("Run returned %v", err)
			}
			if outcome := outcomes[panickingID]; outcome != test.want {
				t.Fatalf("the task settled as %+v, want %+v", outcome, test.want)
			}
			if outcome := outcomes[plainID]; outcome != (tierOutcome{state: "succeeded", attempt: 1}) {
				t.Fatalf("the task after the panic settled as %+v", outcome)
			}
			if test.options != nil && calls.Load() == 0 {
				t.Fatal("the code that the test made panic never ran")
			}
		})
	}
}

// SM-1938 keeps the unwind rules of ADR 0117 for a result whose MarshalJSON panics. A value that
// the handler returned before its shutdown cancellation keeps the usual result check, so the panic
// fails the attempt. A value that the handler returned after the cancellation is a result that the
// task cannot store, so the worker releases the task and charges no attempt.
func TestWorkerSettlesAResultEncodingPanicInTheShutdownWindow(t *testing.T) {
	pool, observer := panicTestPool(t, "worker-execution-panic-shutdown")
	ctx := context.Background()
	for _, test := range []struct {
		name        string
		afterCancel bool
		state       string
		attempt     int
		errorName   string
		gracePeriod time.Duration
	}{
		{name: "before-cancellation", state: "failed", attempt: 1, errorName: "HandlerPanicError",
			gracePeriod: 5 * time.Second},
		{name: "after-cancellation", afterCancel: true, state: "ready", attempt: 1,
			gracePeriod: 50 * time.Millisecond},
	} {
		t.Run(test.name, func(t *testing.T) {
			queueName := "go-execution-panic-shutdown-" + test.name
			queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
			taskID, err := queue.Enqueue(ctx, "panicking", nil, workhorse.EnqueueOptions{MaxAttempts: 1})
			if err != nil {
				t.Fatal(err)
			}
			worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
				Queue: queueName, WorkerID: queueName, LeaseDuration: 5 * time.Second,
				PollInterval: 5 * time.Millisecond, ShutdownGracePeriod: test.gracePeriod,
			})
			if err != nil {
				t.Fatal(err)
			}
			started := make(chan struct{})
			stopped := make(chan struct{})
			cancelled := make(chan bool, 1)
			worker.Handle("panicking", func(
				handlerContext context.Context,
				_ any,
				_ *workhorse.HandlerContext,
			) (any, error) {
				close(started)
				if test.afterCancel {
					<-handlerContext.Done()
				} else {
					<-stopped
				}
				cancelled <- handlerContext.Err() != nil
				return panickingResult{}, nil
			})
			runContext, stop := context.WithCancel(ctx)
			runResult := make(chan error, 1)
			go func() { runResult <- worker.Run(runContext) }()
			// SM-2010: if a wait below fails, the handler of the before-cancellation case still
			// waits on stopped. The cleanup releases it, stops the worker, and waits for Run, so
			// no handler outlives the test.
			var releaseHandler sync.Once
			release := func() { releaseHandler.Do(func() { close(stopped) }) }
			var returned bool
			t.Cleanup(func() {
				release()
				stop()
				if !returned {
					select {
					case <-runResult:
					case <-time.After(workerRunDeadline):
						t.Errorf("Run did not return within %s of the cleanup", workerRunDeadline)
					}
				}
			})
			awaitSignal(t, started, "the handler to start", stop)
			stop()
			release()
			err = awaitSignal(t, runResult, "Run to return after the stop")
			returned = true
			if err != nil && !errors.Is(err, context.Canceled) {
				t.Fatalf("Run returned %v", err)
			}
			if <-cancelled != test.afterCancel {
				t.Fatalf("the handler returned with cancelled=%t, want %t", !test.afterCancel, test.afterCancel)
			}
			var state, errorName string
			var attempt int
			if err := observer.QueryRow(ctx, `SELECT state, current_attempt, coalesce(error->>'name', '')
				FROM workhorse.task_runtime WHERE task_id = $1::uuid
				UNION ALL
				SELECT state, current_attempt, coalesce(error->>'name', '')
				FROM workhorse.task_outcome WHERE task_id = $1::uuid`, taskID).Scan(
				&state, &attempt, &errorName,
			); err != nil {
				t.Fatal(err)
			}
			if state != test.state || attempt != test.attempt || errorName != test.errorName {
				t.Fatalf("the task is %s on attempt %d with %q, want %s on attempt %d with %q",
					state, attempt, errorName, test.state, test.attempt, test.errorName)
			}
		})
	}
}

// SM-1937: Handle and HandleBatch wrote the handler map while the dispatch loop read it, so a
// registration after Run started was a data race, and the Go runtime could end the process. The
// worker now guards the map. A goroutine registers handlers in a loop for the whole run. The tasks
// are enqueued before their handler exists, so the worker claims and releases them while that loop
// writes the map. Run this test with -race.
func TestWorkerAcceptsAHandlerRegistrationWhileItRuns(t *testing.T) {
	pool, observer := panicTestPool(t, "worker-late-registration")
	ctx := context.Background()
	queueName := "go-late-registration"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskIDs, err := queue.EnqueueMany(ctx, fastRequests(queueName, "late", 8))
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: queueName, Concurrency: 2,
		LeaseDuration: 5 * time.Second, PollInterval: 5 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	runContext, stop := context.WithCancel(ctx)
	defer stop()
	runResult := make(chan error, 1)
	go func() { runResult <- worker.Run(runContext) }()
	registerLate := make(chan struct{})
	registrationsDone := make(chan struct{})
	registering := make(chan struct{})
	var stopRegistrations sync.Once
	// The registrations stop and end before the next test, also when this test fails.
	t.Cleanup(func() {
		stopRegistrations.Do(func() { close(registrationsDone) })
		<-registering
	})
	go func() {
		defer close(registering)
		for index := 0; ; index++ {
			select {
			case <-registrationsDone:
				return
			case <-registerLate:
				registerLate = nil
				worker.HandleBatch("late", workhorse.BatchHandlerOptions{MaxSize: 1},
					func(items []workhorse.BatchHandlerItem) []workhorse.BatchHandlerOutcome {
						return []workhorse.BatchHandlerOutcome{workhorse.BatchSucceeded{Result: "late"}}
					})
			default:
			}
			taskType := fmt.Sprintf("unused-%d", index%64)
			worker.Handle(taskType, func(context.Context, any, *workhorse.HandlerContext) (any, error) {
				return nil, nil
			})
			worker.HandleBatch(taskType+"-batch", workhorse.BatchHandlerOptions{MaxSize: 1},
				func(items []workhorse.BatchHandlerItem) []workhorse.BatchHandlerOutcome {
					return []workhorse.BatchHandlerOutcome{workhorse.BatchSucceeded{}}
				})
		}
	}()
	// Wait until the worker has released a task for its missing handler, so the dispatch loop read
	// the map while the registrations ran.
	deadline := time.Now().Add(workerRunDeadline)
	for {
		var released int
		if err := observer.QueryRow(ctx, `SELECT count(*) FROM workhorse.task_event
			WHERE task_id = ANY($1::uuid[]) AND event_type = 'released'`, taskIDs).Scan(&released); err != nil {
			t.Fatal(err)
		}
		if released > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the worker released no task for its missing handler")
		}
		time.Sleep(5 * time.Millisecond)
	}
	registerLate <- struct{}{}
	outcomes := awaitOutcomes(t, observer, taskIDs, runResult)
	stopRegistrations.Do(func() { close(registrationsDone) })
	awaitSignal(t, registering, "the registrations to stop")
	stop()
	if err := awaitSignal(t, runResult, "Run to return after the stop"); err != nil {
		t.Fatalf("Run returned %v", err)
	}
	for _, taskID := range taskIDs {
		// A release charges no attempt, so each task succeeds on its first attempt.
		if outcome := outcomes[taskID]; outcome != (tierOutcome{state: "succeeded", attempt: 1}) {
			t.Fatalf("task %s settled as %+v", taskID, outcome)
		}
	}
}

// blockedResult is a handler result whose MarshalJSON waits for resume and then panics.
type blockedResult struct {
	entered chan struct{}
	resume  chan struct{}
}

func (value blockedResult) MarshalJSON() ([]byte, error) {
	close(value.entered)
	<-value.resume
	panic("the encoder failed after the stop")
}

// executionContextLogger sends the context of the handler started record, which is the execution
// context of the attempt.
type executionContextLogger struct{ contexts chan context.Context }

func (executionContextLogger) Enabled(context.Context, slog.Level) bool { return true }
func (logger executionContextLogger) Handle(ctx context.Context, record slog.Record) error {
	record.Attrs(func(attribute slog.Attr) bool {
		if attribute.Key == "event.name" && attribute.Value.String() == "workhorse.handler.started" {
			select {
			case logger.contexts <- ctx:
			default:
			}
		}
		return true
	})
	return nil
}
func (logger executionContextLogger) WithAttrs([]slog.Attr) slog.Handler { return logger }
func (logger executionContextLogger) WithGroup(string) slog.Handler      { return logger }

// SM-1938: the stop can cancel the execution context while MarshalJSON or RetryDelay runs, after
// the handler returned. The worker then wrote the failure on the cancelled context, so the write
// failed, the task stayed active, and no attempt record held the panic. The failure now uses the
// unwind window, as a failure that the worker reads after the deadline does (ADR 0117).
func TestWorkerFailsAPanicThatComesAfterTheStopCancelledTheSettlement(t *testing.T) {
	for _, mode := range []string{"Run", "RunOnce"} {
		for _, source := range []string{"result-marshal", "retry-delay"} {
			t.Run(mode+"/"+source, func(t *testing.T) {
				pool, observer := panicTestPool(t, "worker-panic-after-stop-"+mode+"-"+source)
				ctx := context.Background()
				queueName := "go-panic-after-stop"
				queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
				taskID, err := queue.Enqueue(ctx, "panicking", nil, workhorse.EnqueueOptions{MaxAttempts: 1})
				if err != nil {
					t.Fatal(err)
				}
				entered, resume := make(chan struct{}), make(chan struct{})
				executionContexts := make(chan context.Context, 1)
				options := workhorse.WorkerOptions{
					Queue: queueName, WorkerID: queueName, LeaseDuration: 5 * time.Second,
					ShutdownGracePeriod: 50 * time.Millisecond, PollInterval: 5 * time.Millisecond,
					Logger: slog.New(executionContextLogger{contexts: executionContexts}),
				}
				if source == "retry-delay" {
					options.RetryDelay = func(int, workhorse.ClaimedTask) *time.Duration {
						close(entered)
						<-resume
						panic("the delay failed after the stop")
					}
				}
				worker, err := workhorse.NewWorker(pool, options)
				if err != nil {
					t.Fatal(err)
				}
				worker.Handle("panicking", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
					if source == "result-marshal" {
						return blockedResult{entered: entered, resume: resume}, nil
					}
					return nil, errors.New("the work failed before the stop")
				})
				runContext, stop := context.WithCancel(ctx)
				defer stop()
				runResult := make(chan error, 1)
				// The cleanup releases the callback and waits for the worker, also when the test fails, so
				// the pool can close.
				var releaseOnce, returnOnce sync.Once
				releaseCallback := func() { releaseOnce.Do(func() { close(resume) }) }
				awaitReturn := func() { returnOnce.Do(func() { awaitSignal(t, runResult, mode+" to return") }) }
				t.Cleanup(func() {
					releaseCallback()
					stop()
					awaitReturn()
				})
				go func() {
					if mode == "Run" {
						runResult <- worker.Run(runContext)
						return
					}
					_, err := worker.RunOnce(runContext)
					runResult <- err
				}()
				awaitSignal(t, entered, "the callback to start", stop)
				stop()
				if mode == "Run" {
					// Run cancels the execution context at the end of the shutdown grace.
					executionContext := awaitSignal(t, executionContexts, "the execution context")
					awaitSignal(t, executionContext.Done(), "the cancellation at the end of the grace")
				}
				releaseCallback()
				awaitReturn()
				var state, errorName string
				var records int
				if err := observer.QueryRow(ctx, `SELECT state, coalesce(error->>'name', ''),
					(SELECT count(*) FROM workhorse.attempt_history WHERE task_id = $1::uuid)
					FROM workhorse.task_runtime WHERE task_id = $1::uuid
					UNION ALL
					SELECT state, coalesce(error->>'name', ''),
					(SELECT count(*) FROM workhorse.attempt_history WHERE task_id = $1::uuid)
					FROM workhorse.task_outcome WHERE task_id = $1::uuid`, taskID).Scan(
					&state, &errorName, &records,
				); err != nil {
					t.Fatal(err)
				}
				if state != "failed" || errorName != "HandlerPanicError" || records != 1 {
					t.Fatalf("the task is %s with %q and %d attempt records, "+
						"want failed with HandlerPanicError and one record", state, errorName, records)
				}
			})
		}
	}
}

// A cancellation request can win the fence while MarshalJSON or RetryDelay runs, and the stop can
// then cancel the execution context. fail_v1 answers cancel_requested, and the worker must
// acknowledge the request in the unwind window too. Before, the acknowledgement ran on the
// cancelled context, so the task stayed active until lease recovery.
func TestWorkerAcknowledgesACancellationThatWinsAFailureAfterTheStop(t *testing.T) {
	for _, tier := range []workhorse.QueueTier{workhorse.QueueTierFull, workhorse.QueueTierFast} {
		for _, batch := range []bool{false, true} {
			for _, mode := range []string{"Run", "RunOnce"} {
				for _, source := range []string{"result-marshal", "retry-delay"} {
					kind := "single"
					if batch {
						kind = "batch"
					}
					name := string(tier) + "/" + kind + "/" + mode + "/" + source
					t.Run(name, func(t *testing.T) {
						testCancellationThatWinsAFailureAfterTheStop(t, tier, batch, mode, source)
					})
				}
			}
		}
	}
}

func testCancellationThatWinsAFailureAfterTheStop(
	t *testing.T,
	tier workhorse.QueueTier,
	batch bool,
	mode string,
	source string,
) {
	pool, observer := panicTestPool(t, "worker-cancel-after-stop-"+mode+"-"+source)
	ctx := context.Background()
	queueName := "go-cancel-after-stop"
	executor := workhorse.NewPGXExecutor(pool)
	audit := workhorse.AdminAudit{Actor: "panic-test", Reason: "SM-1938", RequestID: "SM-1938"}
	if _, err := workhorse.NewAdmin(executor).SetQueueTier(ctx, queueName, tier, audit); err != nil {
		t.Fatal(err)
	}
	queue := workhorse.NewQueue(executor, queueName)
	taskID, err := queue.Enqueue(ctx, "panicking", nil, workhorse.EnqueueOptions{MaxAttempts: 1})
	if err != nil {
		t.Fatal(err)
	}
	entered, resume := make(chan struct{}), make(chan struct{})
	executionContexts := make(chan context.Context, 1)
	options := workhorse.WorkerOptions{
		Queue: queueName, WorkerID: queueName, LeaseDuration: 5 * time.Second,
		ShutdownGracePeriod: 50 * time.Millisecond, PollInterval: 5 * time.Millisecond,
		Logger: slog.New(executionContextLogger{contexts: executionContexts}),
	}
	if source == "retry-delay" {
		options.RetryDelay = func(int, workhorse.ClaimedTask) *time.Duration {
			close(entered)
			<-resume
			panic("the delay failed after the stop")
		}
	}
	worker, err := workhorse.NewWorker(pool, options)
	if err != nil {
		t.Fatal(err)
	}
	outcome := func() (any, error) {
		if source == "result-marshal" {
			return blockedResult{entered: entered, resume: resume}, nil
		}
		return nil, errors.New("the work failed before the stop")
	}
	if batch {
		worker.HandleBatch("panicking", workhorse.BatchHandlerOptions{MaxSize: 1},
			func([]workhorse.BatchHandlerItem) []workhorse.BatchHandlerOutcome {
				value, err := outcome()
				if err != nil {
					return []workhorse.BatchHandlerOutcome{workhorse.BatchFailed{Error: err}}
				}
				return []workhorse.BatchHandlerOutcome{workhorse.BatchSucceeded{Result: value}}
			})
	} else {
		worker.Handle("panicking", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
			return outcome()
		})
	}
	runContext, stop := context.WithCancel(ctx)
	defer stop()
	runResult := make(chan error, 1)
	// The cleanup releases the callback and waits for the worker, also when the test fails, so
	// the pool can close.
	var releaseOnce, returnOnce sync.Once
	releaseCallback := func() { releaseOnce.Do(func() { close(resume) }) }
	awaitReturn := func() { returnOnce.Do(func() { awaitSignal(t, runResult, mode+" to return") }) }
	t.Cleanup(func() {
		releaseCallback()
		stop()
		awaitReturn()
	})
	go func() {
		if mode == "Run" {
			runResult <- worker.Run(runContext)
			return
		}
		_, err := worker.RunOnce(runContext)
		runResult <- err
	}()
	awaitSignal(t, entered, "the callback to start", stop)
	cancelled, err := queue.Cancel(ctx, taskID, workhorse.CancellationRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if cancelled.Status != workhorse.CancelRequested {
		t.Fatalf("the cancellation returned %+v, want a request", cancelled)
	}
	stop()
	if mode == "Run" {
		executionContext := awaitSignal(t, executionContexts, "the execution context")
		awaitSignal(t, executionContext.Done(), "the cancellation at the end of the grace")
	}
	releaseCallback()
	awaitReturn()
	var state string
	if err := observer.QueryRow(ctx, `SELECT state FROM workhorse.task_runtime WHERE task_id = $1::uuid
		UNION ALL SELECT state FROM workhorse.task_outcome WHERE task_id = $1::uuid
		UNION ALL SELECT state FROM workhorse.fast_task_runtime WHERE task_id = $1::uuid
		UNION ALL SELECT state FROM workhorse.fast_task_outcome WHERE task_id = $1::uuid`, taskID).Scan(
		&state,
	); err != nil {
		t.Fatal(err)
	}
	if state != "canceled" {
		t.Fatalf("the task is %s, want canceled", state)
	}
}

// A panic in the Error method of a handler error comes while the worker writes the failure. The
// worker must renew the lease until it has written the panic, as it does for a usual settlement.
// Before, the lease renewal stopped first, so a slow write could pass the lease and lose the
// panic. RetryDelay runs again inside the panic settlement. There it waits until the observer
// sees a later heartbeat of the task, or until three leases have passed.
func TestWorkerRenewsTheLeaseWhileItSettlesAPanic(t *testing.T) {
	pool, observer := panicTestPool(t, "worker-panic-renewal")
	ctx := context.Background()
	queueName := "go-panic-renewal"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskID, err := queue.Enqueue(ctx, "panicking", nil, workhorse.EnqueueOptions{MaxAttempts: 1})
	if err != nil {
		t.Fatal(err)
	}
	const lease = time.Second
	var calls atomic.Int64
	renewed := make(chan bool, 1)
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: queueName, LeaseDuration: lease,
		PollInterval: 5 * time.Millisecond,
		RetryDelay: func(int, workhorse.ClaimedTask) *time.Duration {
			if calls.Add(1) != 2 {
				return nil
			}
			// The second call is inside the settlement of the panic.
			// A task that left task_runtime has no heartbeat, so it reads as no renewal.
			heartbeat := func() time.Time {
				var at time.Time
				if err := observer.QueryRow(ctx, `SELECT coalesce(heartbeat_at, '-infinity')
					FROM workhorse.task_runtime WHERE task_id = $1::uuid`, taskID).Scan(&at); err != nil {
					return time.Time{}
				}
				return at
			}
			first := heartbeat()
			deadline := time.Now().Add(3 * lease)
			for time.Now().Before(deadline) {
				if heartbeat().After(first) {
					renewed <- true
					return nil
				}
				time.Sleep(10 * time.Millisecond)
			}
			renewed <- false
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("panicking", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return nil, panickingError{}
	})
	runContext, stop := context.WithCancel(ctx)
	defer stop()
	runResult := make(chan error, 1)
	go func() { runResult <- worker.Run(runContext) }()
	if !awaitSignal(t, renewed, "the settlement of the panic", stop) {
		t.Error("the worker did not renew the lease while it settled the panic")
	}
	outcomes := awaitOutcomes(t, observer, []string{taskID}, runResult)
	stop()
	if err := awaitSignal(t, runResult, "Run to return after the stop"); err != nil {
		t.Fatalf("Run returned %v", err)
	}
	want := tierOutcome{
		state: "failed", attempt: 1, errorName: "HandlerPanicError",
		errorMessage: "worker execution for panicking panicked outside the handler: the message failed",
	}
	if outcome := outcomes[taskID]; outcome != want {
		t.Fatalf("the task settled as %+v, want %+v", outcome, want)
	}
}
