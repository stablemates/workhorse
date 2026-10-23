package workhorse_test

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

// workerRunDeadline bounds a test run of Worker.Run. A run that reaches it fails the test instead of
// waiting for the go test timeout.
const workerRunDeadline = time.Minute

// runWorkerWithDeadline runs worker until runContext ends. If runContext does not end within
// workerRunDeadline, it stops the worker and fails the test with waitingFor. Use it when a handler
// call or a later condition stops the worker.
func runWorkerWithDeadline(
	t *testing.T,
	worker *workhorse.Worker,
	runContext context.Context,
	stop context.CancelFunc,
	waitingFor string,
) {
	t.Helper()
	var expired atomic.Bool
	deadline := time.AfterFunc(workerRunDeadline, func() {
		expired.Store(true)
		stop()
	})
	err := worker.Run(runContext)
	deadline.Stop()
	if expired.Load() {
		t.Fatalf("the test stopped the worker after %s: %s", workerRunDeadline, waitingFor)
	}
	if err != nil {
		t.Fatal(err)
	}
}

// stopWhenTasksSettle calls stop when every task in taskIDs has an outcome row, or ends when
// runContext ends. Wait on the result before the pool closes.
func stopWhenTasksSettle(
	runContext context.Context,
	stop context.CancelFunc,
	pool *pgxpool.Pool,
	taskIDs map[string]string,
) *sync.WaitGroup {
	ids := make([]string, 0, len(taskIDs))
	for _, id := range taskIDs {
		ids = append(ids, id)
	}
	var watcher sync.WaitGroup
	watcher.Add(1)
	go func() {
		defer watcher.Done()
		for runContext.Err() == nil {
			var settled int
			err := pool.QueryRow(
				runContext,
				"SELECT count(*) FROM workhorse.task_outcome WHERE task_id = ANY($1::uuid[])",
				ids,
			).Scan(&settled)
			if err == nil && settled == len(ids) {
				stop()
				return
			}
			select {
			case <-runContext.Done():
			case <-time.After(10 * time.Millisecond):
			}
		}
	}()
	return &watcher
}
