package workhorse_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"reflect"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

type pollCadenceQueryContextKey struct{}

// pollCadenceQueryTracer holds the worker at the end of each empty claim until the test
// releases it. Counting empty polls is not enough: an uncounted poll between the count and
// the enqueue advances the backoff step, and the delay is then measured against the wrong one.
type pollCadenceQueryTracer struct {
	holding  atomic.Bool
	reached  chan struct{}
	released chan struct{}
}

func (tracer *pollCadenceQueryTracer) TraceQueryStart(
	ctx context.Context,
	_ *pgx.Conn,
	data pgx.TraceQueryStartData,
) context.Context {
	if !strings.Contains(data.SQL, "claim_many_v1") {
		return ctx
	}
	return context.WithValue(ctx, pollCadenceQueryContextKey{}, true)
}

func (tracer *pollCadenceQueryTracer) TraceQueryEnd(
	ctx context.Context,
	_ *pgx.Conn,
	_ pgx.TraceQueryEndData,
) {
	if ctx.Value(pollCadenceQueryContextKey{}) != true || !tracer.holding.Load() {
		return
	}
	tracer.reached <- struct{}{}
	<-tracer.released
}

func TestGoWorkerSatisfiesEverySharedRuntimeFixture(t *testing.T) {
	manifest := readFixture[protocolFixtureManifest](t, "manifest.json")
	assertRuntimeManifestCompatibility(t, manifest)
	fixtures := readFixture[[]workerRuntimeFixture](t, "runtime.json")
	executors := map[string]func(*testing.T, workerRuntimeFixture){
		"batch": func(t *testing.T, fixture workerRuntimeFixture) {
			executeWorkerBatchFixture(t, loadBatchRuntimeFixture(t, fixture.ID))
		},
		"suspension-replay":        executeWorkerSuspensionReplayFixture,
		"cooperative-cancellation": executeWorkerCancellationFixture,
		"expiration":               executeWorkerExpirationFixture,
		"lease-loss":               executeWorkerLeaseLossFixture,
		"heartbeat-cadence":        executeWorkerHeartbeatFixture,
		"poll-cadence":             executeWorkerPollCadenceFixture,
		"graceful-drain":           executeWorkerGracefulDrainFixture,
		"trace-propagation":        executeWorkerTracePropagationFixture,
		"budget-admission-race":    executeBudgetAdmissionRaceFixture,
		"missing-handler":          executeWorkerMissingHandlerFixture,
		"json-round-trip":          executeWorkerJSONRoundTripFixture,
		"heartbeat-failure":        executeWorkerHeartbeatFailureFixture,
		"maintenance-phase-error":  executeWorkerMaintenancePhaseErrorFixture,
	}
	coverage := make(map[string]struct{}, len(manifest.RuntimeCoverage))
	for _, fixture := range fixtures {
		fixture := fixture
		execute, ok := executors[fixture.Kind]
		if !ok {
			t.Fatalf("unsupported runtime fixture kind %q", fixture.Kind)
		}
		t.Run(fixture.ID, func(t *testing.T) {
			execute(t, fixture)
		})
		for _, capability := range fixture.Covers {
			coverage[capability] = struct{}{}
		}
	}
	actual := make([]string, 0, len(coverage))
	for capability := range coverage {
		actual = append(actual, capability)
	}
	sort.Strings(actual)
	expected := append([]string(nil), manifest.RuntimeCoverage...)
	sort.Strings(expected)
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("runtime fixture coverage differs from the manifest: expected %v, received %v", expected, actual)
	}
}

func executeWorkerTracePropagationFixture(t *testing.T, fixture workerRuntimeFixture) {
	exporter := tracetest.NewInMemoryExporter()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	previousProvider := otel.GetTracerProvider()
	previousPropagator := otel.GetTextMapPropagator()
	otel.SetTracerProvider(provider)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() {
		otel.SetTracerProvider(previousProvider)
		otel.SetTextMapPropagator(previousPropagator)
		_ = provider.Shutdown(context.Background())
	})

	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-trace-propagation")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "runtime-" + fixture.ID
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	traceCtx, caller := provider.Tracer("runtime-fixture").Start(ctx, "caller")
	taskID, err := queue.Enqueue(traceCtx, fixture.TaskType, map[string]any{})
	caller.End()
	if err != nil {
		t.Fatal(err)
	}
	var stored []byte
	if err := pool.QueryRow(
		ctx,
		"SELECT trace_context FROM workhorse.task WHERE id = $1::uuid",
		taskID,
	).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	var carrier map[string]string
	if err := json.Unmarshal(stored, &carrier); err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(carrier["traceparent"], "-")
	if len(parts) != 4 {
		t.Fatalf("stored traceparent is invalid: %q", carrier["traceparent"])
	}

	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "go-" + fixture.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle(fixture.TaskType, func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return nil, nil
	})
	worked, err := worker.RunOnce(ctx)
	if err != nil || !worked {
		t.Fatalf("RunOnce() = %v, %v", worked, err)
	}
	for _, span := range exporter.GetSpans() {
		if span.Name != "workhorse.handler" {
			continue
		}
		if span.SpanContext.TraceID() != caller.SpanContext().TraceID() {
			t.Fatalf("handler trace %s does not match caller trace %s", span.SpanContext.TraceID(), caller.SpanContext().TraceID())
		}
		if span.Parent.SpanID().String() != parts[2] {
			t.Fatalf("handler parent %s does not match stored span %s", span.Parent.SpanID(), parts[2])
		}
		return
	}
	t.Fatal("worker did not export a workhorse.handler span")
}

func executeWorkerPollCadenceFixture(t *testing.T, fixture workerRuntimeFixture) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-poll-cadence-fixture")
	ctx := context.Background()
	tracer := &pollCadenceQueryTracer{
		reached:  make(chan struct{}),
		released: make(chan struct{}),
	}
	tracer.holding.Store(true)
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.Tracer = tracer
	// The enqueue runs while a held poll still owns its connection.
	config.MaxConns = 8
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "runtime-" + fixture.ID
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "go-" + fixture.ID,
		PollInterval:    time.Duration(fixture.PollMS) * time.Millisecond,
		DisableRegistry: true, PollingOnly: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	handled := make(chan time.Time, 1)
	worker.Handle(fixture.TaskType, func(_ context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		handled <- time.Now()
		return nil, nil
	})
	runContext, stop := context.WithCancel(ctx)
	runResult := make(chan error, 1)
	go func() { runResult <- worker.Run(runContext) }()
	// The worker is held at the end of every empty poll, so the enqueue happens against a
	// known backoff step and no further poll can advance it. The task is committed before the
	// last poll is released, and the delay is measured from that commit.
	pollTimeout := time.Duration(fixture.ExpectedMaximumDelayMS+1000) * time.Millisecond
	var enqueuedAt time.Time
	for poll := 1; poll <= fixture.EmptyPollsBeforeEnqueue; poll++ {
		select {
		case <-tracer.reached:
		case <-time.After(pollTimeout):
			stop()
			t.Fatalf("worker did not complete empty poll %d before the backoff check", poll)
		}
		if poll == fixture.EmptyPollsBeforeEnqueue {
			// A stall longer than one backoff step. A held worker cannot advance past the
			// pinned step, so this changes nothing; an unheld one fails on every run.
			time.Sleep(time.Duration(fixture.EnqueueStallMS) * time.Millisecond)
			if _, err := queue.Enqueue(ctx, fixture.TaskType, map[string]any{}); err != nil {
				stop()
				t.Fatal(err)
			}
			enqueuedAt = time.Now()
			tracer.holding.Store(false)
		}
		tracer.released <- struct{}{}
	}
	select {
	case handledAt := <-handled:
		delay := handledAt.Sub(enqueuedAt)
		if delay < time.Duration(fixture.ExpectedMinimumDelayMS)*time.Millisecond ||
			delay > time.Duration(fixture.ExpectedMaximumDelayMS)*time.Millisecond {
			t.Fatalf("poll delay %s fell outside fixture bounds", delay)
		}
	case <-time.After(time.Duration(fixture.ExpectedMaximumDelayMS+1000) * time.Millisecond):
		stop()
		t.Fatal("worker did not claim after the polling backoff")
	}
	stop()
	if err := <-runResult; err != nil {
		t.Fatal(err)
	}
}

func assertRuntimeManifestCompatibility(t *testing.T, manifest protocolFixtureManifest) {
	t.Helper()
	if manifest.FormatVersion != 1 {
		t.Fatalf("unsupported runtime fixture format %d", manifest.FormatVersion)
	}
	if manifest.ProtocolVersion != workhorse.ProtocolVersion {
		t.Fatalf("fixture protocol %d differs from Go protocol %d", manifest.ProtocolVersion, workhorse.ProtocolVersion)
	}
	installed := manifest.Schema.InstalledVersion
	if err := workhorse.CheckCompatibility(&installed, manifest.ProtocolVersion, []int{manifest.ProtocolVersion}); err != nil {
		t.Fatalf("runtime fixture manifest is incompatible: %v", err)
	}
	if installed < manifest.Schema.MinimumVersion || installed > manifest.Schema.MaximumVersion ||
		manifest.ProtocolVersion < manifest.SupportedClientProtocol.MinimumVersion ||
		manifest.ProtocolVersion > manifest.SupportedClientProtocol.MaximumVersion {
		t.Fatal("runtime fixture manifest declares incompatible schema or client bounds")
	}
}

func executeWorkerGracefulDrainFixture(t *testing.T, fixture workerRuntimeFixture) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-graceful-drain-fixture")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "runtime-" + fixture.ID
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskIDs := make([]string, 0, fixture.TaskCount)
	for sequence := range fixture.TaskCount {
		taskID, err := queue.Enqueue(ctx, fixture.TaskType, map[string]any{"sequence": sequence})
		if err != nil {
			t.Fatal(err)
		}
		taskIDs = append(taskIDs, taskID)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "go-" + fixture.ID, Concurrency: fixture.Concurrency,
		LeaseDuration: time.Second, PollInterval: 5 * time.Millisecond,
		ShutdownGracePeriod: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{}, fixture.TaskCount)
	release := make(chan struct{})
	worker.Handle(fixture.TaskType, func(_ context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		started <- struct{}{}
		<-release
		return nil, nil
	})
	runContext, stop := context.WithCancel(ctx)
	runResult := make(chan error, 1)
	go func() { runResult <- worker.Run(runContext) }()
	for range fixture.ExpectedActiveAtStop {
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			t.Fatal("worker did not fill its active slots")
		}
	}
	stop()
	select {
	case <-runResult:
		t.Fatal("worker returned before active handlers drained")
	case <-time.After(time.Duration(fixture.SettleCheckMS) * time.Millisecond):
	}
	close(release)
	if err := <-runResult; err != nil {
		t.Fatal(err)
	}
	states := map[string]int{}
	for _, taskID := range taskIDs {
		state := workerFixtureTaskStateFor(t, ctx, pool, taskID)
		states[state.State]++
	}
	if states["succeeded"] != fixture.ExpectedSucceeded || states["ready"] != fixture.ExpectedReady {
		t.Fatalf("unexpected drained states: %v", states)
	}
}

func assertWorkerFixtureTaskState(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	taskID string,
	expected workerFixtureTaskState,
) {
	t.Helper()
	actual := workerFixtureTaskStateFor(t, ctx, pool, taskID)
	if actual.State != expected.State || actual.Attempt != expected.Attempt ||
		(expected.ErrorName != "" && actual.ErrorName != expected.ErrorName) {
		t.Fatalf("expected task state %#v, received %#v", expected, actual)
	}
}

func workerFixtureTaskStateFor(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	taskID string,
) workerFixtureTaskState {
	t.Helper()
	var state workerFixtureTaskState
	if err := pool.QueryRow(ctx, `SELECT state, current_attempt, coalesce(error->>'name', '')
		FROM workhorse.task_runtime WHERE task_id = $1::uuid
		UNION ALL
		SELECT state, current_attempt, coalesce(error->>'name', '')
		FROM workhorse.task_outcome WHERE task_id = $1::uuid`, taskID).Scan(
		&state.State,
		&state.Attempt,
		&state.ErrorName,
	); err != nil {
		t.Fatal(err)
	}
	return state
}

func assertWorkerFixtureAttemptOutcomes(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	taskID string,
	expected []string,
) {
	t.Helper()
	rows, err := pool.Query(ctx, `SELECT outcome FROM workhorse.attempt_history
		WHERE task_id = $1::uuid ORDER BY attempt`, taskID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	actual := make([]string, 0, len(expected))
	for rows.Next() {
		var outcome string
		if err := rows.Scan(&outcome); err != nil {
			t.Fatal(err)
		}
		actual = append(actual, outcome)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("expected attempt outcomes %v, received %v", expected, actual)
	}
}

func lifecycleCauseName(err error) string {
	var cancellation *workhorse.CancellationRequestedError
	var deadline *workhorse.DeadlineExceededError
	var timeout *workhorse.ExecutionTimeoutError
	var leaseLost *workhorse.LeaseLostError
	switch {
	case errors.As(err, &cancellation):
		return "CancellationRequestedError"
	case errors.As(err, &deadline):
		return "DeadlineExceededError"
	case errors.As(err, &timeout):
		return "ExecutionTimeoutError"
	case errors.As(err, &leaseLost):
		return "LeaseLostError"
	default:
		return fmt.Sprintf("%T", err)
	}
}

func containsString(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

const budgetRaceClaimStatement = "SELECT * FROM workhorse.claim_v1($1::text, $2::text, $3::integer)"

// executeBudgetAdmissionRaceFixture commits a budgeted task on one queue while that queue's
// claim is already past its first read, and holds a second claim of the same budget open on
// another queue until the first claim has admitted or started waiting. The first claim's queue
// carries a rate policy so a test session can park it on the queue's token-bucket row, which
// every claim locks after it has sampled its ready rows.
func executeBudgetAdmissionRaceFixture(t *testing.T, fixture workerRuntimeFixture) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "budget-admission-race-fixture")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	name := "runtime-" + fixture.ID
	budget := name
	lateQueue := name + "-late"
	holderQueue := name + "-holder"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), name)
	maxActive := fixture.MaxActive
	if _, err := queue.SyncBudgets(ctx, name, []workhorse.BudgetDefinition{
		{Name: budget, MaxActive: &maxActive},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := queue.SyncRateLimitPolicies(ctx, name, []workhorse.RateLimitPolicyDefinition{
		{Queue: lateQueue, Rate: fixture.QueueRate},
	}); err != nil {
		t.Fatal(err)
	}
	// One unbudgeted start creates the late queue's token-bucket row for the blocker to lock.
	if _, err := queue.Enqueue(ctx, fixture.TaskType, map[string]any{"role": "bucket"}, workhorse.EnqueueOptions{
		Queue: lateQueue,
	}); err != nil {
		t.Fatal(err)
	}
	if started := countBudgetRaceClaims(t, ctx, pool, lateQueue, name+"-bucket", fixture.LeaseMS); started != 1 {
		t.Fatal("the late queue did not admit its unbudgeted start")
	}
	if _, err := queue.Enqueue(ctx, fixture.TaskType, map[string]any{"role": "holder"}, workhorse.EnqueueOptions{
		Queue: holderQueue, Budget: budget,
	}); err != nil {
		t.Fatal(err)
	}

	blocker := acquireBudgetRaceConnection(t, ctx, pool)
	late := acquireBudgetRaceConnection(t, ctx, pool)
	holder := acquireBudgetRaceConnection(t, ctx, pool)
	var lateClaim chan budgetRaceClaimResult
	defer func() {
		_, _ = blocker.Exec(ctx, "ROLLBACK")
		_, _ = holder.Exec(ctx, "ROLLBACK")
		if lateClaim != nil {
			<-lateClaim
		}
		blocker.Release()
		late.Release()
		holder.Release()
	}()

	var latePID uint32
	if err := late.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&latePID); err != nil {
		t.Fatal(err)
	}
	if _, err := blocker.Exec(ctx, "BEGIN"); err != nil {
		t.Fatal(err)
	}
	if _, err := blocker.Exec(ctx, `SELECT 1 FROM workhorse.rate_limit_bucket
		WHERE queue_name = $1 AND bucket_scope = 'queue' FOR UPDATE`, lateQueue); err != nil {
		t.Fatal(err)
	}

	lateClaim = make(chan budgetRaceClaimResult, 1)
	var lateSettled atomic.Bool
	go func() {
		claims, err := countClaimRows(ctx, late.Conn(), lateQueue, name+"-late", fixture.LeaseMS)
		lateSettled.Store(true)
		lateClaim <- budgetRaceClaimResult{claims: claims, err: err}
	}()
	waitForBudgetRace(t, name+": the late claim never reached the bucket row", func() bool {
		return backendWaitsOnLock(t, ctx, pool, latePID, nil)
	})

	if _, err := queue.Enqueue(ctx, fixture.TaskType, map[string]any{"role": "late"}, workhorse.EnqueueOptions{
		Queue: lateQueue, Budget: budget,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := holder.Exec(ctx, "BEGIN"); err != nil {
		t.Fatal(err)
	}
	holderClaims, err := countClaimRows(ctx, holder.Conn(), holderQueue, name+"-holder", fixture.LeaseMS)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := blocker.Exec(ctx, "COMMIT"); err != nil {
		t.Fatal(err)
	}
	advisory := "advisory"
	waitForBudgetRace(t, name+": the late claim neither finished nor waited for the budget", func() bool {
		return lateSettled.Load() || backendWaitsOnLock(t, ctx, pool, latePID, &advisory)
	})
	if _, err := holder.Exec(ctx, "COMMIT"); err != nil {
		t.Fatal(err)
	}
	result := <-lateClaim
	lateClaim = nil
	if result.err != nil {
		t.Fatal(result.err)
	}

	var active int
	if err := pool.QueryRow(ctx, `SELECT count(*)::integer FROM workhorse.task_runtime
		WHERE state = 'active' AND budget_name = $1`, budget).Scan(&active); err != nil {
		t.Fatal(err)
	}
	if holderClaims != fixture.ExpectedHolderClaims || result.claims != fixture.ExpectedLateClaims ||
		active != fixture.ExpectedActive {
		t.Fatalf(
			"budget admission race: expected holder=%d late=%d active=%d, received holder=%d late=%d active=%d",
			fixture.ExpectedHolderClaims, fixture.ExpectedLateClaims, fixture.ExpectedActive,
			holderClaims, result.claims, active,
		)
	}
}

type budgetRaceClaimResult struct {
	claims int
	err    error
}

func acquireBudgetRaceConnection(t *testing.T, ctx context.Context, pool *pgxpool.Pool) *pgxpool.Conn {
	t.Helper()
	connection, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return connection
}

func countBudgetRaceClaims(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	queueName string,
	workerID string,
	leaseMS int,
) int {
	t.Helper()
	connection := acquireBudgetRaceConnection(t, ctx, pool)
	defer connection.Release()
	claims, err := countClaimRows(ctx, connection.Conn(), queueName, workerID, leaseMS)
	if err != nil {
		t.Fatal(err)
	}
	return claims
}

func countClaimRows(ctx context.Context, connection *pgx.Conn, queueName string, workerID string, leaseMS int) (int, error) {
	rows, err := connection.Query(ctx, budgetRaceClaimStatement, queueName, workerID, leaseMS)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	claims := 0
	for rows.Next() {
		claims++
	}
	return claims, rows.Err()
}

// backendWaitsOnLock reports whether a backend waits on a heavyweight lock, optionally of one kind.
func backendWaitsOnLock(t *testing.T, ctx context.Context, pool *pgxpool.Pool, pid uint32, lock *string) bool {
	t.Helper()
	var waiting bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM pg_stat_activity
		 WHERE pid = $1 AND wait_event_type = 'Lock' AND ($2::text IS NULL OR wait_event = $2)
	)`, int32(pid), lock).Scan(&waiting); err != nil {
		t.Fatal(err)
	}
	return waiting
}

func waitForBudgetRace(t *testing.T, message string, predicate func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if predicate() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal(message)
}

// withInjectedFunctionFailure replaces one installed function with a raising body for the duration
// of observe, and restores the definition the database reports afterwards.
func withInjectedFunctionFailure(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	injection workerFixtureInjection,
	observe func(failedCalls func() int),
) {
	t.Helper()
	var original string
	if err := pool.QueryRow(
		ctx,
		"SELECT pg_get_functiondef($1::regprocedure)",
		injection.Function,
	).Scan(&original); err != nil {
		t.Fatal(err)
	}
	count := ""
	if injection.CounterSequence != "" {
		if _, err := pool.Exec(
			ctx,
			fmt.Sprintf("CREATE SEQUENCE %s MINVALUE 0 START 0", injection.CounterSequence),
		); err != nil {
			t.Fatal(err)
		}
		// The exception rolls the call back, so only a sequence carries the count out of it.
		count = fmt.Sprintf("PERFORM nextval('%s');", injection.CounterSequence)
	}
	if _, err := pool.Exec(ctx, fmt.Sprintf(
		`CREATE OR REPLACE FUNCTION %s LANGUAGE plpgsql AS $injected$
		 BEGIN
		   %s
		   RAISE EXCEPTION '%s' USING ERRCODE = '%s';
		 END;
		 $injected$`,
		injection.Header, count, injection.Message, injection.ErrorCode,
	)); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := pool.Exec(context.WithoutCancel(ctx), original); err != nil {
			t.Error(err)
		}
		if injection.CounterSequence != "" {
			if _, err := pool.Exec(
				context.WithoutCancel(ctx),
				fmt.Sprintf("DROP SEQUENCE IF EXISTS %s", injection.CounterSequence),
			); err != nil {
				t.Error(err)
			}
		}
	}()
	observe(func() int {
		if injection.CounterSequence == "" {
			return 0
		}
		var calls int
		if err := pool.QueryRow(
			ctx,
			fmt.Sprintf("SELECT last_value::integer FROM %s", injection.CounterSequence),
		).Scan(&calls); err != nil {
			t.Fatal(err)
		}
		return calls
	})
}

// decodeFixtureJSON re-reads a fixture value with the standard decoder, so numbers arrive as the
// float64 an SDK payload carries rather than the json.Number the fixture reader keeps.
func decodeFixtureJSON(t *testing.T, value any) any {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var decoded any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	return decoded
}

func releaseEvidenceFor(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	taskID string,
) (attempts int, releases int) {
	t.Helper()
	if err := pool.QueryRow(ctx, `SELECT
		(SELECT count(*)::integer FROM workhorse.attempt_history WHERE task_id = $1::uuid),
		(SELECT count(*)::integer FROM workhorse.task_event
		   WHERE task_id = $1::uuid AND event_type = 'released')`, taskID).
		Scan(&attempts, &releases); err != nil {
		t.Fatal(err)
	}
	return attempts, releases
}

func executeWorkerMissingHandlerFixture(t *testing.T, fixture workerRuntimeFixture) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-missing-handler")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "runtime-" + fixture.ID
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskID, err := queue.Enqueue(ctx, fixture.TaskType, map[string]any{"index": 1})
	if err != nil {
		t.Fatal(err)
	}
	older, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "go-" + fixture.ID + "-older",
		LeaseDuration: time.Duration(fixture.LeaseMS) * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	older.Handle(fixture.RegisteredTaskType, func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return nil, nil
	})
	runContext, stop := context.WithCancel(ctx)
	runResult := make(chan error, 1)
	go func() { runResult <- older.Run(runContext) }()
	deadline := time.Now().Add(time.Duration(fixture.ReleaseTimeoutMS) * time.Millisecond)
	for {
		_, releases := releaseEvidenceFor(t, ctx, pool, taskID)
		if releases > 0 {
			break
		}
		if time.Now().After(deadline) {
			stop()
			<-runResult
			t.Fatal("the worker released no claim it had no handler for")
		}
		time.Sleep(5 * time.Millisecond)
	}
	stop()
	if err := <-runResult; err != nil {
		t.Fatal(err)
	}
	assertWorkerFixtureTaskState(t, ctx, pool, taskID, fixture.ExpectedAfterRelease)

	attempts, releases := releaseEvidenceFor(t, ctx, pool, taskID)
	// The refusal belongs to no attempt, so the task keeps the attempt it was enqueued with.
	if attempts != fixture.ExpectedAttempts || releases < fixture.ExpectedMinimumReleaseEvents {
		t.Fatalf("released task carried attempts=%d releases=%d", attempts, releases)
	}

	newer, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "go-" + fixture.ID + "-newer",
		LeaseDuration: time.Duration(fixture.LeaseMS) * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	handled := make(chan any, 1)
	newer.Handle(fixture.TaskType, func(_ context.Context, payload any, _ *workhorse.HandlerContext) (any, error) {
		handled <- payload
		return nil, nil
	})
	if processed, err := newer.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("the registered worker did not handle the released task: processed=%t err=%v", processed, err)
	}
	if received := <-handled; !reflect.DeepEqual(received, map[string]any{"index": float64(1)}) {
		t.Fatalf("unexpected payload %#v", received)
	}
	assertWorkerFixtureTaskState(t, ctx, pool, taskID, fixture.ExpectedAfterHandled)
}

func executeWorkerJSONRoundTripFixture(t *testing.T, fixture workerRuntimeFixture) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-json-round-trip")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	// The fixture reader keeps numbers as json.Number, and the SDK hands the handler float64, so
	// the expectation is normalized through the same decoding the SDK uses.
	payload := decodeFixtureJSON(t, fixture.Payload)
	queueName := "runtime-" + fixture.ID
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskID, err := queue.Enqueue(ctx, fixture.TaskType, fixture.Payload)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "go-" + fixture.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	received := make(chan any, 1)
	worker.Handle(fixture.TaskType, func(_ context.Context, payload any, _ *workhorse.HandlerContext) (any, error) {
		received <- payload
		return payload, nil
	})
	if processed, err := worker.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("worker did not process the round-trip task: processed=%t err=%v", processed, err)
	}
	if handled := <-received; !reflect.DeepEqual(handled, payload) {
		t.Fatalf("the handler received %#v, expected %#v", handled, payload)
	}

	var storedPayload, storedResult []byte
	if err := pool.QueryRow(ctx, `SELECT task.payload, outcome.result
		FROM workhorse.task task
		JOIN workhorse.task_outcome outcome ON outcome.task_id = task.id
		WHERE task.id = $1::uuid`, taskID).Scan(&storedPayload, &storedResult); err != nil {
		t.Fatal(err)
	}
	for label, stored := range map[string][]byte{"payload": storedPayload, "result": storedResult} {
		var decoded any
		if err := json.Unmarshal(stored, &decoded); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(decoded, payload) {
			t.Fatalf("the stored %s is %#v, expected %#v", label, decoded, payload)
		}
	}
	assertWorkerFixtureTaskState(t, ctx, pool, taskID, fixture.ExpectedState)
	assertWorkerFixtureAttemptOutcomes(t, ctx, pool, taskID, []string{fixture.ExpectedAttemptOutcome})
}

func executeWorkerHeartbeatFailureFixture(t *testing.T, fixture workerRuntimeFixture) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-heartbeat-failure")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	observer := observeDatabase(t, ctx, databaseURL)

	queueName := "runtime-" + fixture.ID
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskID, err := queue.Enqueue(ctx, fixture.TaskType, nil)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "go-" + fixture.ID,
		LeaseDuration:     time.Duration(fixture.LeaseMS) * time.Millisecond,
		HeartbeatInterval: time.Duration(fixture.HeartbeatMS) * time.Millisecond,
		PollInterval:      5 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	release := make(chan struct{})
	cancellations := make(chan struct{}, 1)
	worker.Handle(fixture.TaskType, func(handlerContext context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		close(started)
		<-release
		if handlerContext.Err() != nil {
			cancellations <- struct{}{}
		}
		return nil, nil
	})
	workerResult := make(chan error, 1)
	go func() {
		processed, err := worker.RunOnce(ctx)
		if err == nil && !processed {
			err = errors.New("the worker did not process the heartbeat-failure task")
		}
		workerResult <- err
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("the worker did not start the handler")
	}
	within := time.Duration(fixture.RenewalTimeoutMS) * time.Millisecond
	renewed := waitForLeaseRenewal(t, ctx, observer, taskID, leaseExpiry(t, ctx, observer, taskID), within)

	withInjectedFunctionFailure(t, ctx, pool, fixture.Injection, func(failedCalls func() int) {
		deadline := time.Now().Add(within)
		for failedCalls() < fixture.ExpectedMinimumFailedRounds {
			if time.Now().After(deadline) {
				t.Fatalf("only %d heartbeat rounds failed", failedCalls())
			}
			time.Sleep(5 * time.Millisecond)
		}
		renewed = leaseExpiry(t, ctx, observer, taskID)
	})
	// Once the rounds answer again the lease renews, so the failures cost the attempt nothing.
	waitForLeaseRenewal(t, ctx, observer, taskID, renewed, within)

	close(release)
	if err := <-workerResult; err != nil {
		t.Fatal(err)
	}
	if len(cancellations) != fixture.ExpectedCancellations {
		t.Fatalf("a failed heartbeat round cancelled %d handlers", len(cancellations))
	}
	assertWorkerFixtureTaskState(t, ctx, pool, taskID, fixture.ExpectedState)
	assertWorkerFixtureAttemptOutcomes(t, ctx, pool, taskID, []string{fixture.ExpectedAttemptOutcome})
}

func executeWorkerMaintenancePhaseErrorFixture(t *testing.T, fixture workerRuntimeFixture) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-maintenance-phase-error")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "runtime-" + fixture.ID
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	var logs lockedBuffer
	// tick_v1 catches a phase failure and returns it as data, so a raising promote_v1 models a
	// lock timeout inside the promote phase.
	withInjectedFunctionFailure(t, ctx, pool, fixture.Injection, func(func() int) {
		var phase string
		var phaseError []byte
		if err := pool.QueryRow(ctx, `SELECT phase, error FROM workhorse.tick_v1()
			WHERE phase = $1`, fixture.ExpectedPhase).Scan(&phase, &phaseError); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(phaseError), fixture.Injection.Message) {
			t.Fatalf("the %s phase reported %s", phase, string(phaseError))
		}

		taskID, err := queue.Enqueue(ctx, fixture.TaskType, nil)
		if err != nil {
			t.Fatal(err)
		}
		worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
			Queue: queueName, WorkerID: "go-" + fixture.ID,
			MaintenanceInterval: 100 * time.Millisecond,
			Logger:              slog.New(slog.NewTextHandler(&logs, nil)),
		})
		if err != nil {
			t.Fatal(err)
		}
		worker.Handle(fixture.TaskType, func(context.Context, any, *workhorse.HandlerContext) (any, error) {
			return nil, nil
		})
		// The failing phase runs on this pass, and the pass still claims and settles the task.
		if processed, err := worker.RunOnce(ctx); err != nil || !processed {
			t.Fatalf("a maintenance phase error stopped the pass: processed=%t err=%v", processed, err)
		}
		if !strings.Contains(logs.String(), fixture.Injection.Message) {
			t.Fatalf("the worker logged no phase failure: %s", logs.String())
		}
		assertWorkerFixtureTaskState(t, ctx, pool, taskID, fixture.ExpectedState)
	})
}
