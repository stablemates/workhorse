package workhorse_test

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

// A Go Worker runs inside a caller's process, so it cannot end that process at its shutdown
// deadline the way the TypeScript and Python worker processes do. It bounds the drain instead:
// Run cancels the handlers that outlive the grace period, stops renewing their leases, and
// returns. PostgreSQL then recovers their tasks when the leases expire.

func TestWorkerReturnsWhenAHandlerIgnoresItsCancellation(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-shutdown-abandon")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "go-worker-shutdown-abandon"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	if _, err := queue.Enqueue(ctx, "stubborn", nil); err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "shutdown-abandon-worker",
		LeaseDuration: time.Second, PollInterval: 5 * time.Millisecond,
		ShutdownGracePeriod: 100 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}

	started := make(chan struct{})
	release := make(chan struct{})
	finished := make(chan struct{})
	worker.Handle("stubborn", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		close(started)
		// This handler never reads its context, which is the case the grace period has to bound.
		<-release
		close(finished)
		return nil, nil
	})

	runContext, stop := context.WithCancel(ctx)
	runResult := make(chan error, 1)
	go func() { runResult <- worker.Run(runContext) }()
	<-started
	stop()

	select {
	case err := <-runResult:
		if !errors.Is(err, workhorse.ErrShutdownIncomplete) {
			t.Fatalf("Run returned %v, want ErrShutdownIncomplete", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run never returned while a handler ignored its cancellation")
	}

	select {
	case <-finished:
		t.Fatal("the handler finished before it was released, so it was never abandoned")
	default:
	}
	close(release)
	<-finished
}

func TestWorkerWaitsForAHandlerThatHonoursItsCancellation(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-shutdown-unwind")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "go-worker-shutdown-unwind"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	if _, err := queue.Enqueue(ctx, "cooperative", nil); err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "shutdown-unwind-worker",
		LeaseDuration: time.Second, PollInterval: 5 * time.Millisecond,
		ShutdownGracePeriod: 100 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}

	started := make(chan struct{})
	finished := make(chan struct{})
	worker.Handle("cooperative", func(
		handlerContext context.Context,
		_ any,
		_ *workhorse.HandlerContext,
	) (any, error) {
		close(started)
		<-handlerContext.Done()
		close(finished)
		return nil, context.Cause(handlerContext)
	})

	runContext, stop := context.WithCancel(ctx)
	runResult := make(chan error, 1)
	go func() { runResult <- worker.Run(runContext) }()
	<-started
	stop()

	select {
	case err := <-runResult:
		if errors.Is(err, workhorse.ErrShutdownIncomplete) {
			t.Fatal("a handler that unwound on cancellation was reported as abandoned")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run never returned after the grace period")
	}
	select {
	case <-finished:
	default:
		t.Fatal("Run returned before the cancelled handler unwound")
	}
}

func TestWorkerReturnsWhenHandlersHoldEveryPoolConnection(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-shutdown-pool")
	ctx := context.Background()
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = 4
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "go-worker-shutdown-pool"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	for range 8 {
		if _, err := queue.Enqueue(ctx, "hold", nil); err != nil {
			t.Fatal(err)
		}
	}
	const gracePeriod = 200 * time.Millisecond
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "shutdown-pool-worker", Concurrency: 8,
		LeaseDuration: time.Second, PollInterval: 5 * time.Millisecond,
		ShutdownGracePeriod: gracePeriod,
	})
	if err != nil {
		t.Fatal(err)
	}
	// A failed run never cancels its handlers, so the test releases them before pool.Close waits.
	released := make(chan struct{})
	t.Cleanup(func() { close(released) })
	var acquiring atomic.Int32
	// Each handler holds a pooled connection until its context ends. There are more handlers than
	// connections, so a handler already waits for every connection the worker releases at stop.
	worker.Handle("hold", func(
		handlerContext context.Context,
		_ any,
		_ *workhorse.HandlerContext,
	) (any, error) {
		acquireContext, cancelAcquire := context.WithCancel(handlerContext)
		defer cancelAcquire()
		go func() {
			select {
			case <-released:
				cancelAcquire()
			case <-acquireContext.Done():
			}
		}()
		acquiring.Add(1)
		connection, err := pool.Acquire(acquireContext)
		if err != nil {
			return nil, err
		}
		defer connection.Release()
		select {
		case <-handlerContext.Done():
		case <-released:
		}
		return nil, context.Cause(handlerContext)
	})

	runContext, stop := context.WithCancel(ctx)
	runResult := make(chan error, 1)
	go func() { runResult <- worker.Run(runContext) }()
	deadline := time.Now().Add(5 * time.Second)
	for acquiring.Load() < 8 || pool.Stat().AcquiredConns() < config.MaxConns {
		if time.Now().After(deadline) {
			t.Fatalf("handlers never exhausted the pool: %d acquiring, %d acquired",
				acquiring.Load(), pool.Stat().AcquiredConns())
		}
		time.Sleep(5 * time.Millisecond)
	}
	// Acquire may return just before the counter is read, so let every waiter reach the pool queue.
	time.Sleep(50 * time.Millisecond)

	stopped := time.Now()
	stop()
	// The grace period, the unwind window, and a margin for the bounded deregistration.
	bound := gracePeriod + 250*time.Millisecond + 1500*time.Millisecond
	select {
	case err := <-runResult:
		if elapsed := time.Since(stopped); elapsed > bound {
			t.Fatalf("Run returned %s after stop, want within %s", elapsed, bound)
		}
		// Every handler unwinds once the deadline cancels it, so the shutdown is clean.
		if err != nil {
			t.Fatalf("Run returned %v, want nil", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run never returned while handlers held every pool connection")
	}
}
