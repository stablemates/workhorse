package workhorse

import (
	"sync"
	"time"
)

// EmptyWaitForTest is the empty-claim wait of a worker's dispatch loop. Deadline is the end of the
// wait, and is zero when the loop has no wait. Wakeable is set when a wake can end the wait.
type EmptyWaitForTest struct {
	Deadline time.Time
	Wakeable bool
}

// ObserveEmptyWaitForTest records the empty-claim wait each time the dispatch loop of worker
// starts to wait, and returns a function that reads the last one. Call it before the worker runs.
func ObserveEmptyWaitForTest(worker *Worker) func() EmptyWaitForTest {
	var mu sync.Mutex
	var current EmptyWaitForTest
	worker.observeEmptyWait = func(deadline time.Time, wakeable bool) {
		mu.Lock()
		current = EmptyWaitForTest{Deadline: deadline, Wakeable: wakeable}
		mu.Unlock()
	}
	return func() EmptyWaitForTest {
		mu.Lock()
		defer mu.Unlock()
		return current
	}
}
