package workhorse_test

import (
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

// SM-1057: workers on one pool share one notification listener, as they share one heartbeat
// connection. When each worker held its own listener, two workers on a three-connection pool held
// every connection between them and neither could claim.
func TestWorkersOnOnePoolShareOneNotificationListener(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-shared-listener")
	ctx := context.Background()
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = 3
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	operator, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(operator.Close)

	lease := time.Second
	handled := make(chan string, 8)
	startWorker := func(queueName string) (context.CancelFunc, <-chan error) {
		worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
			Queue: queueName, WorkerID: queueName + "-worker", LeaseDuration: lease,
			HeartbeatInterval: lease / 5,
		})
		if err != nil {
			t.Fatal(err)
		}
		worker.Handle("quick", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
			handled <- queueName
			return nil, nil
		})
		// A handler that outlives its lease succeeds only while the shared heartbeat renews it.
		worker.Handle("slow", func(ctx context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
			select {
			case <-time.After(3 * lease):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			handled <- queueName
			return nil, nil
		})
		runContext, stop := context.WithCancel(ctx)
		result := make(chan error, 1)
		go func() { result <- worker.Run(runContext) }()
		return stop, result
	}
	stopFirst, firstResult := startWorker("go-shared-listener-a")
	stopSecond, secondResult := startWorker("go-shared-listener-b")
	t.Cleanup(func() {
		stopFirst()
		stopSecond()
		<-firstResult
		<-secondResult
	})

	enqueue := func(queueName, taskType string) string {
		t.Helper()
		taskID, err := workhorse.NewQueue(workhorse.NewPGXExecutor(operator), queueName).Enqueue(ctx, taskType, nil)
		if err != nil {
			t.Fatal(err)
		}
		return taskID
	}
	expectHandled := func(want string, within time.Duration) {
		t.Helper()
		select {
		case got := <-handled:
			if got != want {
				t.Fatalf("handled a task from %s, want %s", got, want)
			}
		case <-time.After(within):
			t.Fatalf("no worker handled the task on %s within %s", want, within)
		}
	}

	// The handler signals before the fenced completion write, so each task's outcome proves that
	// its worker completed it.
	expectSucceeded := func(taskID, description string) {
		t.Helper()
		var state string
		deadline := time.Now().Add(5 * time.Second)
		for {
			err := operator.QueryRow(ctx, "SELECT state FROM workhorse.task_outcome WHERE task_id = $1", taskID).Scan(&state)
			if err == nil || time.Now().After(deadline) {
				break
			}
			time.Sleep(20 * time.Millisecond)
		}
		if state != "succeeded" {
			t.Fatalf("%s ended %q, want succeeded", description, state)
		}
	}

	firstID := enqueue("go-shared-listener-a", "quick")
	expectHandled("go-shared-listener-a", 10*time.Second)
	secondID := enqueue("go-shared-listener-b", "quick")
	expectHandled("go-shared-listener-b", 10*time.Second)
	expectSucceeded(firstID, "the first worker's task")
	expectSucceeded(secondID, "the second worker's task")

	// Stopping one worker ends only its subscription.
	stopFirst()
	select {
	case err := <-firstResult:
		// Cleanup receives from firstResult again, so replace the drained channel before a failure.
		firstResult = closedResult()
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the first worker did not stop")
	}

	// The default poll interval with a listener is longer than this wait, so only a notification
	// wakes the second worker this fast.
	time.Sleep(200 * time.Millisecond)
	notifiedID := enqueue("go-shared-listener-b", "quick")
	expectHandled("go-shared-listener-b", 2*time.Second)
	expectSucceeded(notifiedID, "the task the notification woke the second worker for")

	slowID := enqueue("go-shared-listener-b", "slow")
	expectHandled("go-shared-listener-b", 10*lease)
	expectSucceeded(slowID, "the task that outlived its lease")
}

// SM-1057: the last worker to leave a pool's listener stops it, and the listener sends UNLISTEN
// after that worker has left. A failed UNLISTEN still reaches that worker's logger.
func TestLastWorkerLogsAFailedUnlisten(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-failed-unlisten")
	ctx := context.Background()
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.Tracer = breakConnectionOnUnlisten{}
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	var logs lockedBuffer
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-failed-unlisten", WorkerID: "go-failed-unlisten-worker",
		Logger: slog.New(slog.NewTextHandler(&logs, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	runContext, stop := context.WithCancel(ctx)
	defer stop()
	result := make(chan error, 1)
	go func() { result <- worker.Run(runContext) }()

	waitForNotificationListener(t, ctx, pool, 0)
	stop()
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	if contents := logs.String(); !strings.Contains(contents, "notification listener unavailable") {
		t.Fatalf("the last worker did not log the failed UNLISTEN; its log was:\n%s", contents)
	}
}

// breakConnectionOnUnlisten closes a connection's socket as it starts to send UNLISTEN, so the
// statement fails.
type breakConnectionOnUnlisten struct{}

func (breakConnectionOnUnlisten) TraceQueryStart(
	ctx context.Context,
	connection *pgx.Conn,
	data pgx.TraceQueryStartData,
) context.Context {
	if strings.HasPrefix(data.SQL, "UNLISTEN") {
		_ = connection.PgConn().Conn().Close()
	}
	return ctx
}

func (breakConnectionOnUnlisten) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func closedResult() <-chan error {
	result := make(chan error, 1)
	result <- nil
	return result
}
