package workhorse_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
	"go.uber.org/goleak"
)

type workerRuntimeFixture struct {
	ID                                   string `json:"id"`
	JobType                              string `json:"jobType"`
	LeaseMS                              int    `json:"leaseMs"`
	HeartbeatMS                          int    `json:"heartbeatMs"`
	DurationMS                           int    `json:"durationMs"`
	MaxAttempts                          int    `json:"maxAttempts"`
	CancelReason                         string `json:"cancelReason"`
	ExpectedCallsWhileBlocked            int    `json:"expectedCallsWhileBlocked"`
	ExpectedMinimumCallsBeforeSettlement int    `json:"expectedMinimumCallsBeforeSettlement"`
	ExpectedMaximumOverlap               int    `json:"expectedMaximumOverlap"`
}

type heartbeatQueryContextKey struct{}

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
	mu         sync.Mutex
	delay      time.Duration
	calls      int
	active     int
	maxOverlap int
	started    chan struct{}
}

func newHeartbeatQueryTracer(delay time.Duration) *heartbeatQueryTracer {
	return &heartbeatQueryTracer{delay: delay, started: make(chan struct{}, 16)}
}

func (tracer *heartbeatQueryTracer) TraceQueryStart(
	ctx context.Context,
	_ *pgx.Conn,
	data pgx.TraceQueryStartData,
) context.Context {
	if !strings.Contains(data.SQL, "heartbeat_v2") {
		return ctx
	}
	tracer.mu.Lock()
	tracer.calls++
	tracer.active++
	tracer.maxOverlap = max(tracer.maxOverlap, tracer.active)
	tracer.mu.Unlock()
	tracer.started <- struct{}{}
	time.Sleep(tracer.delay)
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

func loadWorkerRuntimeFixture(t *testing.T, id string) workerRuntimeFixture {
	t.Helper()
	contents, err := os.ReadFile("../protocol/v1/runtime.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []workerRuntimeFixture
	if err := json.Unmarshal(contents, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		if fixture.ID == id {
			return fixture
		}
	}
	t.Fatalf("runtime fixture %s was not found", id)
	return workerRuntimeFixture{}
}

func TestWorkerClaimsHandlesAndCompletesAJob(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-complete")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-worker")
	jobID, err := queue.Enqueue(ctx, "report.generate", map[string]any{"reportId": "r-1"})
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
	worker.Handle("report.generate", func(_ context.Context, payload any) (any, error) {
		return map[string]any{"reportId": payload.(map[string]any)["reportId"], "status": "ready"}, nil
	})

	processed, err := worker.RunOnce(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !processed {
		t.Fatal("worker did not claim the enqueued job")
	}

	var state string
	var result []byte
	if err := pool.QueryRow(
		ctx,
		"SELECT state, result FROM workhorse.job_outcome WHERE job_id = $1::uuid",
		jobID,
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

func TestWorkerRecordsFailureAndLetsPostgreSQLScheduleTheRetry(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-retry")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-worker-retry")
	jobID, err := queue.Enqueue(ctx, "delivery.retry", nil, workhorse.EnqueueOptions{
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
	worker.Handle("delivery.retry", func(_ context.Context, _ any) (any, error) {
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
		"SELECT state, current_attempt, run_at FROM workhorse.job_runtime WHERE job_id = $1::uuid",
		jobID,
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
		"SELECT state, current_attempt FROM workhorse.job_outcome WHERE job_id = $1::uuid",
		jobID,
	).Scan(&outcome, &currentAttempt); err != nil {
		t.Fatal(err)
	}
	if outcome != "succeeded" || currentAttempt != 2 {
		t.Fatalf("unexpected final outcome: state=%s attempt=%d", outcome, currentAttempt)
	}
}

func TestWorkersCannotClaimTheSameJobConcurrently(t *testing.T) {
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
	first.Handle("exclusive", func(_ context.Context, _ any) (any, error) {
		close(started)
		<-release
		return nil, nil
	})
	firstResult := make(chan error, 1)
	go func() {
		processed, err := first.RunOnce(ctx)
		if err == nil && !processed {
			err = errors.New("first worker did not claim the job")
		}
		firstResult <- err
	}()
	<-started

	processed, err := second.RunOnce(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if processed {
		t.Fatal("second worker claimed a job already owned by the first worker")
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
	worker.Handle("bounded", func(_ context.Context, payload any) (any, error) {
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
		t.Fatalf("worker exceeded its concurrency bound by starting job %d", sequence)
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
	worker.Handle("rotated", func(_ context.Context, payload any) (any, error) {
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
			t.Fatal("worker did not process every queued job")
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
	worker.Handle("drain", func(handlerContext context.Context, payload any) (any, error) {
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
		t.Fatalf("worker claimed job %d after shutdown started", sequence)
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

func TestWorkerSurfacesRejectedSettlementAsTypedStaleLease(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-stale")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-worker-stale")
	jobID, err := queue.Enqueue(ctx, "stale", nil)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-worker-stale", WorkerID: "go-worker-stale", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	release := make(chan struct{})
	worker.Handle("stale", func(_ context.Context, _ any) (any, error) {
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
		"SELECT fence_token FROM workhorse.job_runtime WHERE job_id = $1::uuid",
		jobID,
	).Scan(&fence); err != nil {
		t.Fatal(err)
	}
	var accepted bool
	if err := pool.QueryRow(
		ctx,
		"SELECT workhorse.complete_v1($1::uuid, $2::text, $3::bigint, $4::jsonb)",
		jobID,
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
	err = <-workerResult
	if !errors.Is(err, workhorse.ErrStaleLease) {
		t.Fatalf("expected errors.Is stale lease match, received %v", err)
	}
	var stale *workhorse.StaleLeaseError
	if !errors.As(err, &stale) || stale.JobID != jobID {
		t.Fatalf("expected typed stale lease for %s, received %#v", jobID, err)
	}
}

func TestWorkerHeartbeatsKeepALongRunningAttemptOwned(t *testing.T) {
	fixture := loadWorkerRuntimeFixture(t, "heartbeats-never-overlap")
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-heartbeat")
	ctx := context.Background()
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	tracer := newHeartbeatQueryTracer(3 * time.Duration(fixture.HeartbeatMS) * time.Millisecond)
	config.ConnConfig.Tracer = tracer
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-worker-heartbeat")
	jobID, err := queue.Enqueue(ctx, fixture.JobType, nil)
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
	worker.Handle(fixture.JobType, func(_ context.Context, _ any) (any, error) {
		close(started)
		<-release
		return nil, nil
	})

	type workerRunResult struct {
		processed bool
		err       error
	}
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
	close(release)
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
		"SELECT state FROM workhorse.job_outcome WHERE job_id = $1::uuid",
		jobID,
	).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "succeeded" {
		t.Fatalf("expected heartbeated attempt to succeed, received %s", state)
	}
}

func TestWorkerDeliversTypedCancellationAndAcknowledgesIt(t *testing.T) {
	fixture := loadWorkerRuntimeFixture(t, "cooperative-cancellation-reaches-handler")
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-cancel")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-worker-cancel")
	jobID, err := queue.Enqueue(ctx, fixture.JobType, nil)
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
	worker.Handle(fixture.JobType, func(handlerContext context.Context, _ any) (any, error) {
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
	if _, err := pool.Exec(
		ctx,
		"SELECT * FROM workhorse.cancel_v1($1::uuid, $2::text, $3::text)",
		jobID,
		"go-test",
		fixture.CancelReason,
	); err != nil {
		t.Fatal(err)
	}

	if err := <-workerResult; err != nil {
		t.Fatal(err)
	}
	observed := <-cause
	if !errors.Is(observed, workhorse.ErrCancellationRequested) {
		t.Fatalf("expected typed cancellation cause, received %v", observed)
	}
	var cancellation *workhorse.CancellationRequestedError
	if !errors.As(observed, &cancellation) || cancellation.JobID != jobID {
		t.Fatalf("expected cancellation cause for %s, received %#v", jobID, observed)
	}
	var state string
	if err := pool.QueryRow(
		ctx,
		"SELECT state FROM workhorse.job_outcome WHERE job_id = $1::uuid",
		jobID,
	).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "canceled" {
		t.Fatalf("expected cancellation acknowledgement, received %s", state)
	}
}

func TestWorkerDeliversDistinctDeadlineAndExecutionTimeoutCauses(t *testing.T) {
	tests := []struct {
		name       string
		fixtureID  string
		options    func(time.Time) workhorse.EnqueueOptions
		matches    error
		assertType func(*testing.T, string, error)
	}{
		{
			name:      "deadline",
			fixtureID: "deadline-settles-after-early-local-timer",
			options: func(now time.Time) workhorse.EnqueueOptions {
				deadline := now.Add(150 * time.Millisecond)
				return workhorse.EnqueueOptions{Deadline: &deadline, MaxAttempts: 2}
			},
			matches: workhorse.ErrDeadlineExceeded,
			assertType: func(t *testing.T, jobID string, cause error) {
				var typed *workhorse.DeadlineExceededError
				if !errors.As(cause, &typed) || typed.JobID != jobID {
					t.Fatalf("expected deadline cause for %s, received %#v", jobID, cause)
				}
			},
		},
		{
			name:      "execution-timeout",
			fixtureID: "execution-timeout-settles-after-early-local-timer",
			options: func(_ time.Time) workhorse.EnqueueOptions {
				return workhorse.EnqueueOptions{ExecutionTimeoutMS: 150, MaxAttempts: 1}
			},
			matches: workhorse.ErrExecutionTimeout,
			assertType: func(t *testing.T, jobID string, cause error) {
				var typed *workhorse.ExecutionTimeoutError
				if !errors.As(cause, &typed) || typed.JobID != jobID || typed.Attempt != 1 {
					t.Fatalf("expected execution-timeout cause for %s, received %#v", jobID, cause)
				}
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := loadWorkerRuntimeFixture(t, test.fixtureID)
			databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-"+test.name)
			ctx := context.Background()
			pool, err := pgxpool.New(ctx, databaseURL)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(pool.Close)
			queueName := "go-worker-" + test.name
			queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
			options := test.options(time.Now().UTC())
			if test.name == "deadline" {
				deadline := time.Now().UTC().Add(time.Duration(fixture.DurationMS) * time.Millisecond)
				options.Deadline = &deadline
			} else {
				options.ExecutionTimeoutMS = fixture.DurationMS
				options.RetryPolicy = map[string]any{"type": "fixed", "delayMs": 0}
			}
			options.MaxAttempts = fixture.MaxAttempts
			jobID, err := queue.Enqueue(ctx, fixture.JobType, nil, options)
			if err != nil {
				t.Fatal(err)
			}
			worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
				Queue:             queueName,
				WorkerID:          queueName,
				LeaseDuration:     time.Duration(fixture.LeaseMS) * time.Millisecond,
				HeartbeatInterval: time.Duration(fixture.HeartbeatMS) * time.Millisecond,
			})
			if err != nil {
				t.Fatal(err)
			}
			cause := make(chan error, 1)
			hasDeadline := make(chan bool, 1)
			worker.Handle(fixture.JobType, func(handlerContext context.Context, _ any) (any, error) {
				_, ok := handlerContext.Deadline()
				hasDeadline <- ok
				<-handlerContext.Done()
				cause <- context.Cause(handlerContext)
				return nil, nil
			})
			processed, err := worker.RunOnce(ctx)
			if err != nil || !processed {
				t.Fatalf("expiration attempt: processed=%t err=%v", processed, err)
			}
			if !<-hasDeadline {
				t.Fatal("expected expiration to be exposed as a context deadline")
			}
			observed := <-cause
			if !errors.Is(observed, test.matches) {
				t.Fatalf("expected %v, received %v", test.matches, observed)
			}
			test.assertType(t, jobID, observed)
			if test.name == "deadline" {
				var state string
				var attempt int
				if err := pool.QueryRow(
					ctx,
					"SELECT state, current_attempt FROM workhorse.job_outcome WHERE job_id = $1::uuid",
					jobID,
				).Scan(&state, &attempt); err != nil {
					t.Fatal(err)
				}
				if state != "failed" || attempt != 1 {
					t.Fatalf("expected deadline settlement, received state=%s attempt=%d", state, attempt)
				}
			} else {
				var state string
				var attempt int
				if err := pool.QueryRow(
					ctx,
					"SELECT state, current_attempt FROM workhorse.job_runtime WHERE job_id = $1::uuid",
					jobID,
				).Scan(&state, &attempt); err != nil {
					t.Fatal(err)
				}
				if state != "ready" || attempt != 2 {
					t.Fatalf("expected timeout retry settlement, received state=%s attempt=%d", state, attempt)
				}
			}
		})
	}
}

func TestWorkerCancelsHandlerWithLeaseLossAfterFenceRecovery(t *testing.T) {
	fixture := loadWorkerRuntimeFixture(t, "lease-loss-fences-handler-writes")
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-lease-loss")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "go-worker-lease-loss"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	jobID, err := queue.Enqueue(ctx, fixture.JobType, nil, workhorse.EnqueueOptions{
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
	worker.Handle(fixture.JobType, func(handlerContext context.Context, _ any) (any, error) {
		close(started)
		<-handlerContext.Done()
		cause <- context.Cause(handlerContext)
		return map[string]any{"mustNotSettle": true}, nil
	})
	workerResult := make(chan error, 1)
	go func() {
		_, err := worker.RunOnce(ctx)
		workerResult <- err
	}()
	<-started
	var staleFence int64
	if err := pool.QueryRow(
		ctx,
		"SELECT fence_token FROM workhorse.job_runtime WHERE job_id = $1::uuid",
		jobID,
	).Scan(&staleFence); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx,
		"UPDATE workhorse.job_runtime SET expires_at = clock_timestamp() - interval '1 millisecond' WHERE job_id = $1::uuid",
		jobID,
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

	err = <-workerResult
	if !errors.Is(err, workhorse.ErrStaleLease) {
		t.Fatalf("expected stale settlement refusal, received %v", err)
	}
	observed := <-cause
	if !errors.Is(observed, workhorse.ErrLeaseLost) {
		t.Fatalf("expected lease-loss cancellation cause, received %v", observed)
	}
	var leaseLoss *workhorse.LeaseLostError
	if !errors.As(observed, &leaseLoss) || leaseLoss.JobID != jobID {
		t.Fatalf("expected lease-loss cause for %s, received %#v", jobID, observed)
	}
	var state string
	var attempt int
	if err := pool.QueryRow(
		ctx,
		"SELECT state, current_attempt FROM workhorse.job_runtime WHERE job_id = $1::uuid",
		jobID,
	).Scan(&state, &attempt); err != nil {
		t.Fatal(err)
	}
	if state != "ready" || attempt != 2 {
		t.Fatalf("expected recovered fence on attempt two, received state=%s attempt=%d", state, attempt)
	}
	var accepted bool
	if err := pool.QueryRow(
		ctx,
		"SELECT workhorse.complete_v1($1::uuid, $2::text, $3::bigint, $4::jsonb)",
		jobID,
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
	jobID, err := queue.Enqueue(ctx, "recovered", nil, workhorse.EnqueueOptions{
		MaxAttempts: 2,
		RetryPolicy: map[string]any{"type": "fixed", "delayMs": 0},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx,
		"SELECT * FROM workhorse.claim_v3($1::text, $2::text, $3::integer)",
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
		HeartbeatInterval: 20 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("recovered", func(_ context.Context, _ any) (any, error) { return nil, nil })
	processed, err := worker.RunOnce(ctx)
	if err != nil || !processed {
		t.Fatalf("recovered attempt: processed=%t err=%v", processed, err)
	}
	var state string
	var attempt int
	if err := pool.QueryRow(
		ctx,
		"SELECT state, current_attempt FROM workhorse.job_outcome WHERE job_id = $1::uuid",
		jobID,
	).Scan(&state, &attempt); err != nil {
		t.Fatal(err)
	}
	if state != "succeeded" || attempt != 2 {
		t.Fatalf("expected recovered second attempt, received state=%s attempt=%d", state, attempt)
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
	peerJobID, err := queue.Enqueue(ctx, "peer", nil, workhorse.EnqueueOptions{
		MaxAttempts: 2,
		RetryPolicy: map[string]any{"type": "fixed", "delayMs": 0},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx,
		"SELECT * FROM workhorse.claim_v3($1::text, $2::text, $3::integer)",
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
		HeartbeatInterval:   20 * time.Millisecond,
		PollInterval:        5 * time.Millisecond,
		MaintenanceInterval: 20 * time.Millisecond,
		ShutdownGracePeriod: 20 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	worker.Handle("long-handler", func(handlerContext context.Context, _ any) (any, error) {
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
		"UPDATE workhorse.job_runtime SET expires_at = clock_timestamp() - interval '1 millisecond' WHERE job_id = $1::uuid",
		peerJobID,
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
				"SELECT state, current_attempt FROM workhorse.job_runtime WHERE job_id = $1::uuid",
				peerJobID,
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

func TestWorkerOwnershipLifecycleSupportsASingleConnectionPool(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-single-connection")
	ctx := context.Background()
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "go-worker-single-connection"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	jobID, err := queue.Enqueue(ctx, "single-connection", nil)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:               queueName,
		WorkerID:            "single-connection-worker",
		LeaseDuration:       100 * time.Millisecond,
		HeartbeatInterval:   20 * time.Millisecond,
		PollInterval:        5 * time.Millisecond,
		MaintenanceInterval: 20 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("single-connection", func(_ context.Context, _ any) (any, error) {
		time.Sleep(250 * time.Millisecond)
		return map[string]any{"settled": true}, nil
	})
	runContext, stop := context.WithCancel(ctx)
	workerResult := make(chan error, 1)
	go func() { workerResult <- worker.Run(runContext) }()

	deadline := time.NewTimer(time.Second)
	ticker := time.NewTicker(5 * time.Millisecond)
	settled := false
	for !settled {
		select {
		case <-deadline.C:
			t.Fatal("single-connection worker did not settle the heartbeated job")
		case <-ticker.C:
			if err := pool.QueryRow(
				ctx,
				"SELECT EXISTS (SELECT 1 FROM workhorse.job_outcome WHERE job_id = $1::uuid)",
				jobID,
			).Scan(&settled); err != nil {
				t.Fatal(err)
			}
		}
	}
	deadline.Stop()
	ticker.Stop()
	stop()
	if err := <-workerResult; err != nil && !errors.Is(err, context.Canceled) {
		t.Fatal(err)
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
		LeaseDuration:       time.Second,
		HeartbeatInterval:   20 * time.Millisecond,
		PollInterval:        5 * time.Second,
		MaintenanceInterval: 20 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	handled := make(chan string, 2)
	worker.Handle("notified", func(_ context.Context, payload any) (any, error) {
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
		HeartbeatInterval:   20 * time.Millisecond,
		PollInterval:        50 * time.Millisecond,
		MaintenanceInterval: 20 * time.Millisecond,
		PollingOnly:         true,
		Logger:              slog.New(slog.NewTextHandler(&logs, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	handled := make(chan string, 1)
	worker.Handle("polled", func(_ context.Context, payload any) (any, error) {
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
	config.MaxConns = 2
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
		HeartbeatInterval:   20 * time.Millisecond,
		PollInterval:        5 * time.Millisecond,
		MaintenanceInterval: 20 * time.Millisecond,
		Logger:              slog.New(slog.NewTextHandler(&logs, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	handled := make(chan string, 1)
	worker.Handle("polled-during-backoff", func(_ context.Context, payload any) (any, error) {
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
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	if _, err := queue.Enqueue(ctx, "polled-during-backoff", map[string]any{"value": "backoff"}); err != nil {
		t.Fatal(err)
	}
	assertHandledWithin(t, handled, "backoff", 75*time.Millisecond)
	var replacementListeners int
	if err := pool.QueryRow(
		ctx,
		`SELECT count(*)
		 FROM pg_stat_activity
		 WHERE datname = current_database()
		   AND query = 'LISTEN workhorse_jobs'
		   AND pid <> $1`,
		listenerPID,
	).Scan(&replacementListeners); err != nil {
		t.Fatal(err)
	}
	if replacementListeners != 0 {
		t.Fatal("listener reconnected before polling covered the notification gap")
	}
	waitForNotificationListener(t, ctx, pool, listenerPID)
	stop()
	if err := <-workerResult; err != nil {
		t.Fatal(err)
	}
}

func waitForWorkerLog(t *testing.T, logs *lockedBuffer, message string) {
	t.Helper()
	deadline := time.NewTimer(time.Second)
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
			   AND query = 'LISTEN workhorse_jobs'
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
