package workhorse_test

import (
	"context"
	"errors"
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
