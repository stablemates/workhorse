package workhorse_test

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

// statementPanicTracer is a pgx tracer of the caller that panics once, at the start of a statement
// whose SQL contains statement, after it has let skip such statements pass.
type statementPanicTracer struct {
	statement string
	skip      int64
	seen      atomic.Int64
	panicked  atomic.Bool
}

func (tracer *statementPanicTracer) TraceQueryStart(
	ctx context.Context,
	_ *pgx.Conn,
	data pgx.TraceQueryStartData,
) context.Context {
	if strings.Contains(data.SQL, tracer.statement) && tracer.seen.Add(1) == tracer.skip+1 {
		tracer.panicked.Store(true)
		panic("the query tracer failed")
	}
	return ctx
}

func (*statementPanicTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

// queryPanicPool opens a pool of four connections whose tracer is tracer, and a separate
// connection that reads the outcomes.
func queryPanicPool(t *testing.T, name string, tracer pgx.QueryTracer) (*pgxpool.Pool, *pgx.Conn) {
	t.Helper()
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), name)
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = 4
	config.ConnConfig.Tracer = tracer
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

// stopRun stops a run and returns its result. It fails the test if Run does not return in time.
func stopRun(t *testing.T, stop context.CancelFunc, runResult <-chan error) error {
	t.Helper()
	stop()
	select {
	case err := <-runResult:
		return err
	case <-time.After(workerRunDeadline):
		t.Fatalf("Run did not return within %s of the stop", workerRunDeadline)
		return nil
	}
}

// requireQueryPanicOrStop fails the test unless err is the end of a stop or the error of the
// recovered panic.
func requireQueryPanicOrStop(t *testing.T, err error) {
	t.Helper()
	if err == nil || errors.Is(err, context.Canceled) {
		return
	}
	if !strings.Contains(err.Error(), "panicked outside Workhorse: the query tracer failed") {
		t.Fatalf("Run returned %v", err)
	}
}

// SM-2010: a tracer panic in complete_many_and_claim_v1 ran on a completion flush goroutine,
// which did not recover it, so the process ended. The statement now fails with the panic as its
// error. Each entry of the chunk gets that answer, so each execution ends and Run returns at the
// stop. The grace period is longer than the wait for Run, so an entry without an answer fails the
// test instead of the grace period ending it.
func TestWorkerAnswersEachCompletionEntryWhenTheQueryTracerPanics(t *testing.T) {
	tracer := &statementPanicTracer{statement: "workhorse.complete_many_and_claim_v1("}
	pool, observer := queryPanicPool(t, "worker-completion-tracer-panic", tracer)
	ctx := context.Background()
	queueName := "go-completion-tracer-panic"
	makeFastQueue(t, pool, queueName)
	taskIDs, err := workhorse.NewQueue(workhorse.NewPGXExecutor(observer), queueName).EnqueueMany(
		ctx, fastRequests(queueName, "square", 12),
	)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: queueName, Concurrency: 3, PollingOnly: true,
		LeaseDuration: 5 * time.Second, PollInterval: 5 * time.Millisecond,
		ShutdownGracePeriod: 2 * workerRunDeadline,
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("square", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return "done", nil
	})
	runContext, stop := context.WithCancel(ctx)
	runResult := make(chan error, 1)
	go func() { runResult <- worker.Run(runContext) }()
	deadline := time.Now().Add(workerRunDeadline)
	for !tracer.panicked.Load() && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if !tracer.panicked.Load() {
		t.Fatal("the query tracer never panicked")
	}
	requireQueryPanicOrStop(t, stopRun(t, stop, runResult))
	var settled int
	if err := observer.QueryRow(ctx, `SELECT count(*) FROM workhorse.fast_task_outcome
		WHERE task_id = ANY($1::uuid[])`, taskIDs).Scan(&settled); err != nil {
		t.Fatal(err)
	}
	if settled == len(taskIDs) {
		t.Fatal("every task settled, so no chunk met the panic")
	}
}

// SM-2010: a tracer panic in expire_owned ran on the expiry goroutine of the ownership supervisor,
// which did not recover it, so the process ended. The request now fails with the panic as its
// error. The worker logs the failed request, keeps the handler running, and asks again. The second
// request settles the deadline, and Run returns at the stop.
func TestWorkerAsksAgainWhenTheQueryTracerPanicsInAnExpiryRequest(t *testing.T) {
	tracer := &statementPanicTracer{statement: "workhorse.expire_owned_telemetry_v1("}
	pool, observer := queryPanicPool(t, "worker-expiry-tracer-panic", tracer)
	ctx := context.Background()
	queueName := "go-expiry-tracer-panic"
	deadline := time.Now().Add(300 * time.Millisecond)
	taskID, err := workhorse.NewQueue(workhorse.NewPGXExecutor(observer), queueName).Enqueue(
		ctx, "deadline", nil, workhorse.EnqueueOptions{MaxAttempts: 1, Deadline: &deadline},
	)
	if err != nil {
		t.Fatal(err)
	}
	var logs lockedBuffer
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: queueName, PollingOnly: true, PollInterval: 5 * time.Millisecond,
		Logger: slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelWarn})),
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("deadline", func(handlerContext context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		<-handlerContext.Done()
		return nil, context.Cause(handlerContext)
	})
	runContext, stop := context.WithCancel(ctx)
	runResult := make(chan error, 1)
	go func() { runResult <- worker.Run(runContext) }()
	outcome := awaitOutcomes(t, observer, []string{taskID}, runResult)[taskID]
	requireQueryPanicOrStop(t, stopRun(t, stop, runResult))
	if !tracer.panicked.Load() {
		t.Fatal("the query tracer never panicked")
	}
	if outcome.state != "failed" || outcome.errorName != "DeadlineExceeded" {
		t.Fatalf("the task is %s with %q, want failed with DeadlineExceeded", outcome.state, outcome.errorName)
	}
	records := jsonLogRecords(t, logs.String(), "workhorse.worker.expiration_request_failed")
	if len(records) != 1 || records[0]["error.type"] != "*workhorse.queryPanicError" {
		t.Fatalf("got %v, want one record with error.type *workhorse.queryPanicError", records)
	}
}

// SM-2010: the Run goroutine and the heartbeat, maintenance, registry, claim, and listener
// goroutines also query without a recover of their own. A tracer panic in each of their statements
// now fails that statement, and the process continues. The registry case first lets the
// registration of the Run goroutine pass, so the panic comes on the registry goroutine.
func TestWorkerGoroutinesSurviveAQueryTracerPanic(t *testing.T) {
	for _, test := range []struct {
		name      string
		statement string
		skip      int64
		// atStop is a statement that the worker sends only after the stop.
		atStop bool
		// startup is a statement whose panic is a startup failure, so the task never runs.
		startup bool
	}{
		// The Run goroutine sends these statements itself.
		{name: "compatibility check", statement: "FROM workhorse.protocol_version", startup: true},
		{name: "first registration", statement: "workhorse.register_worker_v1("},
		{name: "deregistration", statement: "workhorse.deregister_worker_v2(", atStop: true},
		// The handler waits for the panic, so a heartbeat round runs while the task is active.
		{name: "heartbeat", statement: "workhorse.heartbeat_many_v2("},
		{name: "maintenance", statement: "workhorse.tick_v1("},
		// Run registers once on its own goroutine before the registry goroutine starts.
		{name: "registry", statement: "workhorse.register_worker_v1(", skip: 1},
		{name: "claim", statement: "workhorse.claim_many_v1("},
		{name: "listener", statement: "LISTEN workhorse_tasks"},
	} {
		t.Run(test.name, func(t *testing.T) {
			tracer := &statementPanicTracer{statement: test.statement, skip: test.skip}
			pool, observer := queryPanicPool(t, "worker-goroutine-tracer-panic-"+test.name, tracer)
			ctx := context.Background()
			queueName := "go-goroutine-tracer-panic-" + test.name
			if _, err := workhorse.NewQueue(workhorse.NewPGXExecutor(observer), queueName).Enqueue(
				ctx, "waiting", nil, workhorse.EnqueueOptions{},
			); err != nil {
				t.Fatal(err)
			}
			worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
				Queue: queueName, WorkerID: queueName, PollingOnly: test.name != "listener",
				PollInterval: 5 * time.Millisecond, LeaseDuration: 3 * time.Second,
				HeartbeatInterval: 100 * time.Millisecond, MaintenanceInterval: 100 * time.Millisecond,
				RegistryInterval: 100 * time.Millisecond, ShutdownGracePeriod: time.Second,
			})
			if err != nil {
				t.Fatal(err)
			}
			started := make(chan struct{})
			var startOnce sync.Once
			worker.Handle("waiting", func(handlerContext context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
				startOnce.Do(func() { close(started) })
				for !tracer.panicked.Load() && handlerContext.Err() == nil {
					time.Sleep(5 * time.Millisecond)
				}
				return "done", nil
			})
			runContext, stop := context.WithCancel(ctx)
			runResult := make(chan error, 1)
			go func() { runResult <- worker.Run(runContext) }()
			if test.startup {
				select {
				case err := <-runResult:
					if err == nil || !strings.Contains(err.Error(), "panicked outside Workhorse") {
						t.Fatalf("Run returned %v, want the startup failure of the panic", err)
					}
				case <-time.After(workerRunDeadline):
					stop()
					t.Fatal("Run did not return after the panic of its startup check")
				}
				stop()
				return
			}
			if test.atStop {
				// The worker deregisters only a registration that it made, so the run must start.
				awaitSignal(t, started, "the handler to start", stop)
			}
			deadline := time.Now().Add(workerRunDeadline)
			for !test.atStop && !tracer.panicked.Load() && time.Now().Before(deadline) {
				time.Sleep(5 * time.Millisecond)
			}
			if !test.atStop && !tracer.panicked.Load() {
				t.Fatal("the query tracer never panicked")
			}
			requireQueryPanicOrStop(t, stopRun(t, stop, runResult))
			if !tracer.panicked.Load() {
				t.Fatal("the query tracer never panicked")
			}
		})
	}
}

// SM-2010: Workhorse calls the BeforeClose hook of the pool directly, so a panic of the hook is a
// panic of the application, whatever its package. closeAndRemove calls the hook through
// recoverCallerHook, which drops that panic.
func TestRecoverCallerHookDropsEachPanicOfTheHook(t *testing.T) {
	for name, hook := range map[string]func(string){
		"explicit panic": func(string) { panic("the BeforeClose hook failed") },
		"runtime error": func(connection string) {
			var connections []string
			_ = connections[len(connection)]
		},
	} {
		called := false
		workhorse.RecoverCallerHookForTest(func(connection string) {
			called = true
			hook(connection)
		}, "connection")
		if !called {
			t.Errorf("%s: recoverCallerHook did not call the hook", name)
		}
	}
}
