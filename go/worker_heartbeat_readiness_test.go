package workhorse_test

import (
	"context"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

// These tests pin the startup and the claim gate of ADR 0071 (SM-1576). Inside max(I, 5 s) a worker
// reserves its heartbeat connection, then borrows one ordinary connection for the compatibility
// check. It refuses to start if either step fails. It claims no task while its pool holds no
// heartbeat connection, and it claims at once when the connection returns.

func readinessPool(t *testing.T, adapter string, maxConns int32, configure func(*pgxpool.Config)) (*pgxpool.Pool, string) {
	t.Helper()
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), adapter)
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = maxConns
	if configure != nil {
		configure(config)
	}
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool, databaseURL
}

func expectStartupRefusal(t *testing.T, err error, elapsed time.Duration, pool *pgxpool.Pool, step string) {
	t.Helper()
	if err == nil {
		t.Fatal("the worker started on a pool that could not lend its startup connections")
	}
	for _, fragment := range []string{
		pool.Config().ConnConfig.Database, "MaxConns 3", step, "startup budget of 5s", "grow the pool)",
	} {
		if !strings.Contains(err.Error(), fragment) {
			t.Fatalf("the refusal does not name %q: %v", fragment, err)
		}
	}
	if strings.Contains(err.Error(), "opt out") {
		t.Fatalf("the refusal names an option that no longer exists: %v", err)
	}
	if elapsed < 4*time.Second || elapsed > 10*time.Second {
		t.Fatalf("the refusal came after %s, want about the startup budget of 5s", elapsed)
	}
}

// Before SM-1576, Run ignored a failed reservation and then waited for the compatibility check on
// the exhausted pool until its caller gave up.
func TestRunRefusesToStartWhenThePoolCannotLendTheHeartbeatConnection(t *testing.T) {
	pool, _ := readinessPool(t, "worker-startup-heartbeat-refusal", 3, nil)
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-worker-startup-heartbeat-refusal", LeaseDuration: 3 * time.Second,
		HeartbeatInterval: time.Second, PollingOnly: true, DisableRegistry: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	holdLendableConnections(t, ctx, pool)

	started := time.Now()
	err = worker.Run(ctx)
	expectStartupRefusal(t, err, time.Since(started), pool, "the dedicated heartbeat connection")
	if ctx.Err() != nil {
		t.Fatal("Run returned only when its caller gave up")
	}
}

// The heartbeat connection takes the last free connection, so the compatibility check finds none.
func TestRunOnceRefusesToStartWhenThePoolHasNoConnectionForTheCompatibilityCheck(t *testing.T) {
	pool, _ := readinessPool(t, "worker-startup-compatibility-refusal", 3, nil)
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-worker-startup-compatibility-refusal", LeaseDuration: 3 * time.Second,
		HeartbeatInterval: time.Second, DisableRegistry: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	for range 2 {
		held, err := pool.Acquire(ctx)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(held.Release)
	}

	started := time.Now()
	_, err = worker.RunOnce(ctx)
	expectStartupRefusal(t, err, time.Since(started), pool, "a connection for the compatibility check")
	if ctx.Err() != nil {
		t.Fatal("RunOnce returned only when its caller gave up")
	}
}

// A pool that takes longer than the heartbeat interval to open a connection still lends one inside
// the startup budget. Before SM-1576, the reservation waited only one interval of 100 ms, so the
// worker started without its heartbeat connection.
func TestAWorkerOnAWarmingPoolStartsWithItsHeartbeatConnection(t *testing.T) {
	pool, databaseURL := readinessPool(t, "worker-startup-warming-pool", 4, func(config *pgxpool.Config) {
		config.BeforeConnect = func(context.Context, *pgx.ConnConfig) error {
			time.Sleep(300 * time.Millisecond)
			return nil
		}
	})
	queueName := "go-worker-startup-warming-pool"
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, LeaseDuration: 2 * time.Second, HeartbeatInterval: 100 * time.Millisecond,
		PollInterval: 20 * time.Millisecond, PollingOnly: true, DisableRegistry: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	heldAtStart := make(chan bool, 1)
	worker.Handle("warming", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		heldAtStart <- worker.HeartbeatConnectionHeldForTest()
		return nil, nil
	})
	ctx := context.Background()
	observer := observeDatabase(t, ctx, databaseURL)
	if _, err := workhorse.NewQueue(workhorse.NewPGXExecutor(observer), queueName).Enqueue(ctx, "warming", nil); err != nil {
		t.Fatal(err)
	}
	runContext, stopRun := context.WithCancel(ctx)
	defer stopRun()
	runResult := make(chan error, 1)
	go func() { runResult <- worker.Run(runContext) }()

	select {
	case held := <-heldAtStart:
		if !held {
			t.Fatal("the worker claimed a task without its heartbeat connection")
		}
	case err := <-runResult:
		t.Fatalf("the worker refused a warming pool: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("the worker on a warming pool claimed no task")
	}
	stopRun()
	if err := awaitSignal(t, runResult, "Run to return after the stop"); err != nil {
		t.Fatal(err)
	}
}

// When the heartbeat connection returns, the worker claims at once. A polling-only worker waits up to
// 5 s between empty claims, so a claim within 2 s of the return comes from the wake, not the poll.
func TestAWorkerWithoutItsHeartbeatConnectionClaimsWhenTheConnectionReturns(t *testing.T) {
	pool, databaseURL := readinessPool(t, "worker-heartbeat-gate-recovery", 4, nil)
	queueName := "go-worker-heartbeat-gate-recovery"
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, LeaseDuration: 3 * time.Second, HeartbeatInterval: 200 * time.Millisecond,
		PollInterval: time.Minute, MaintenanceInterval: time.Minute, PollingOnly: true, DisableRegistry: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	type start struct {
		at   time.Time
		held bool
	}
	starts := make(chan start, 1)
	worker.Handle("gated", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		starts <- start{at: time.Now(), held: worker.HeartbeatConnectionHeldForTest()}
		return nil, nil
	})
	ctx := context.Background()
	observer := observeDatabase(t, ctx, databaseURL)
	runContext, stopRun := context.WithCancel(ctx)
	defer stopRun()
	runResult := make(chan error, 1)
	go func() { runResult <- worker.Run(runContext) }()
	// The first claim finds nothing, so the next poll is about 5 s away.
	deadline := time.Now().Add(5 * time.Second)
	for !worker.HeartbeatConnectionHeldForTest() {
		if time.Now().After(deadline) {
			t.Fatal("the worker did not reserve its heartbeat connection")
		}
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(300 * time.Millisecond)

	// The test holds every other connection, then takes the heartbeat connection, so the worker
	// cannot acquire a replacement.
	releaseLendable := holdLendableConnections(t, ctx, pool)
	taken := worker.TakeHeartbeatConnectionForTest()
	if taken == nil {
		t.Fatal("the worker held no heartbeat connection")
	}
	// The held connections also stop every claim, so this test cannot show the gate during the
	// outage. The unit tests of the dispatch loop show it. This test shows that the task starts only
	// with the heartbeat connection, and that the return of the connection wakes the claim.
	if _, err := workhorse.NewQueue(workhorse.NewPGXExecutor(observer), queueName).Enqueue(ctx, "gated", nil); err != nil {
		t.Fatal(err)
	}
	time.Sleep(500 * time.Millisecond)

	returned := time.Now()
	taken.Release()
	releaseLendable()
	select {
	case started := <-starts:
		if !started.held {
			t.Fatal("the worker claimed a task without its heartbeat connection")
		}
		if delay := started.at.Sub(returned); delay > 2*time.Second {
			t.Fatalf("the first claim came %s after the connection returned", delay)
		}
	case err := <-runResult:
		t.Fatalf("Run returned while it waited for its heartbeat connection: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("the worker did not claim after its heartbeat connection returned")
	}
	stopRun()
	if err := awaitSignal(t, runResult, "Run to return after the stop"); err != nil {
		t.Fatal(err)
	}
}

// blockedConnectPool returns a pool whose connects wait until the test calls release, the number of
// connects that started, and a channel that receives each start.
func blockedConnectPool(t *testing.T, adapter string) (*pgxpool.Pool, *atomic.Int32, func(), <-chan struct{}) {
	t.Helper()
	var connects atomic.Int32
	release := make(chan struct{})
	started := make(chan struct{}, 16)
	pool, _ := readinessPool(t, adapter, 4, func(config *pgxpool.Config) {
		config.BeforeConnect = func(context.Context, *pgx.ConnConfig) error {
			connects.Add(1)
			started <- struct{}{}
			<-release
			return nil
		}
	})
	var once sync.Once
	closeRelease := func() { once.Do(func() { close(release) }) }
	t.Cleanup(closeRelease)
	return pool, &connects, closeRelease, started
}

// SM-1576: rounds that wait for a heartbeat connection and time out start no further acquisition.
// One connect serves every waiter, and the connection it opens becomes the heartbeat connection.
func TestRepeatedWaiterTimeoutsStartOneHeartbeatConnect(t *testing.T) {
	pool, connects, release, started := blockedConnectPool(t, "heartbeat-single-acquisition")
	connection := workhorse.NewHeartbeatConnectionForTest(pool)
	t.Cleanup(connection.Release)
	ctx := context.Background()

	for range 4 {
		if err := connection.QueryRound(ctx, 50*time.Millisecond, "SELECT 1"); err == nil {
			t.Fatal("a round finished while the connect was blocked")
		}
	}
	awaitSignal(t, started, "the blocked connect to start")
	// The delay between two failed attempts is at most one second, so a second connect would have
	// started by now if a waiter's deadline ended the first.
	time.Sleep(1500 * time.Millisecond)
	if count := connects.Load(); count != 1 {
		t.Fatalf("connects = %d after four waiter timeouts, want 1", count)
	}
	release()
	deadline := time.Now().Add(5 * time.Second)
	for !connection.Held() {
		if time.Now().After(deadline) {
			t.Fatal("the connect did not become the heartbeat connection")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if err := connection.QueryRound(ctx, 2*time.Second, "SELECT 1"); err != nil {
		t.Fatal(err)
	}
	if count := connects.Load(); count != 1 {
		t.Fatalf("connects = %d, want 1", count)
	}
}

// SM-1576: the last holder releases while the one connect is still blocked. The acquisition stops,
// and the pool adopts the connection when the connect ends.
func TestAReleaseDuringAPendingConnectLeavesTheConnectionToThePool(t *testing.T) {
	pool, connects, release, started := blockedConnectPool(t, "heartbeat-acquisition-release")
	connection := workhorse.NewHeartbeatConnectionForTest(pool)
	if err := connection.QueryRound(context.Background(), 50*time.Millisecond, "SELECT 1"); err == nil {
		t.Fatal("a round finished while the connect was blocked")
	}
	awaitSignal(t, started, "the blocked connect to start")
	connection.Release()
	release()
	deadline := time.Now().Add(5 * time.Second)
	for {
		stat := pool.Stat()
		if stat.IdleConns() == 1 && stat.AcquiredConns() == 0 && stat.ConstructingConns() == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("pool idle %d, acquired %d, constructing %d after the release",
				stat.IdleConns(), stat.AcquiredConns(), stat.ConstructingConns())
		}
		time.Sleep(5 * time.Millisecond)
	}
	if connection.Held() || connects.Load() != 1 {
		t.Fatalf("held %t, connects %d; want the connection in the pool after one connect",
			connection.Held(), connects.Load())
	}
}

// stalledListen holds every LISTEN statement until release closes.
type stalledListen struct {
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (tracer *stalledListen) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if strings.HasPrefix(strings.TrimSpace(data.SQL), "LISTEN") {
		tracer.once.Do(func() { close(tracer.entered) })
		<-tracer.release
	}
	return ctx
}

func (*stalledListen) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

// SM-1576 (the JVM review): a stalled LISTEN holds one connection of a pool of 3, but it cannot use
// the startup budget. A second worker on the pool still starts, and both workers claim by polling.
func TestAStalledListenerDoesNotKeepAWorkerFromStarting(t *testing.T) {
	tracer := &stalledListen{entered: make(chan struct{}), release: make(chan struct{})}
	var releaseOnce sync.Once
	releaseListen := func() { releaseOnce.Do(func() { close(tracer.release) }) }
	pool, databaseURL := readinessPool(t, "worker-stalled-listener", 3, func(config *pgxpool.Config) {
		config.ConnConfig.Tracer = tracer
	})
	// Cleanups run in reverse order, so this one runs before pool.Close. A failed assertion then
	// releases the blocked LISTEN, and pool.Close does not wait for its connection forever.
	t.Cleanup(releaseListen)
	ctx := context.Background()
	observer := observeDatabase(t, ctx, databaseURL)
	ran := make(chan string, 2)
	runContext, stopRun := context.WithCancel(ctx)
	defer stopRun()
	results := make(chan error, 2)
	start := func(queueName string) {
		worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
			Queue: queueName, LeaseDuration: 3 * time.Second, HeartbeatInterval: time.Second,
			PollInterval: 50 * time.Millisecond, DisableRegistry: true,
		})
		if err != nil {
			t.Fatal(err)
		}
		worker.Handle("stalled-listener", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
			ran <- queueName
			return nil, nil
		})
		go func() { results <- worker.Run(runContext) }()
	}
	start("go-stalled-listener-first")
	select {
	case <-tracer.entered:
	case <-time.After(10 * time.Second):
		t.Fatal("the listener did not send LISTEN")
	}
	start("go-stalled-listener-second")
	for _, queueName := range []string{"go-stalled-listener-first", "go-stalled-listener-second"} {
		if _, err := workhorse.NewQueue(workhorse.NewPGXExecutor(observer), queueName).Enqueue(ctx, "stalled-listener", nil); err != nil {
			t.Fatal(err)
		}
	}
	seen := map[string]bool{}
	for len(seen) < 2 {
		select {
		case queueName := <-ran:
			seen[queueName] = true
		case err := <-results:
			t.Fatalf("a worker stopped while the listener stalled: %v", err)
		case <-time.After(15 * time.Second):
			t.Fatalf("the workers ran %v while the listener stalled", seen)
		}
	}
	releaseListen()
	stopRun()
	for range 2 {
		if err := awaitSignal(t, results, "each Run to return after the stop"); err != nil {
			t.Fatal(err)
		}
	}
}
