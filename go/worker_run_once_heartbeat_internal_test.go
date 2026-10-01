package workhorse

import (
	"context"
	"runtime"
	"testing"
)

// These tests check that RunOnce reserves the heartbeat connection only while it holds the run
// permit, so a concurrent or following invocation cannot release a reservation another one uses.

func newReservingWorker(t *testing.T) *Worker {
	t.Helper()
	worker, err := NewWorker(unconnectedPool(t), WorkerOptions{Queue: "run-once", WorkerID: "run-once-worker"})
	if err != nil {
		t.Fatal(err)
	}
	return worker
}

func heartbeatHolders(worker *Worker) int {
	heldHeartbeatConnections.mu.Lock()
	defer heldHeartbeatConnections.mu.Unlock()
	shared, ok := heldHeartbeatConnections.held[worker.pool]
	if !ok {
		return 0
	}
	return shared.holders
}

func reservedHeartbeatLease(worker *Worker) *heartbeatConnectionLease {
	worker.heartbeatMu.Lock()
	defer worker.heartbeatMu.Unlock()
	return worker.heartbeatLease
}

func TestCanceledRunOnceKeepsTheActiveInvocationsHeartbeatReservation(t *testing.T) {
	worker := newReservingWorker(t)
	// The test stands in for an active invocation: it holds the run permit and the reservation.
	releaseRun, err := worker.acquireRun(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer releaseRun()
	worker.holdHeartbeats(context.Background())
	defer worker.releaseHeartbeatConnection()
	active := reservedHeartbeatLease(worker)

	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := worker.RunOnce(canceled); err == nil {
		t.Fatal("a canceled RunOnce waiting behind an active invocation returned no error")
	}

	if lease := reservedHeartbeatLease(worker); lease != active {
		t.Fatalf("the canceled RunOnce replaced the active reservation %p with %p", active, lease)
	}
	if active.released {
		t.Fatal("the canceled RunOnce released the active invocation's heartbeat reservation")
	}
	if holders := heartbeatHolders(worker); holders != 1 {
		t.Fatalf("heartbeat holders = %d, want 1", holders)
	}
}

func TestRunOnceReleasesItsReservationBeforeTheNextInvocationRuns(t *testing.T) {
	worker := newReservingWorker(t)
	// An unbuffered permit hands the run straight from one holder to the next, so the test, standing
	// in for the next invocation, observes the reservation at the moment it takes over.
	worker.runPermit = make(chan struct{})
	result := make(chan error, 1)
	go func() {
		// The pool cannot connect, so the invocation fails after it reserves and tears down.
		_, err := worker.RunOnce(context.Background())
		result <- err
	}()
	worker.runPermit <- struct{}{}
	// The test takes the permit only while it holds the reservation lock, so an invocation that
	// returned the permit first cannot release its reservation before the test looks.
	var lease *heartbeatConnectionLease
	for taken := false; !taken; {
		worker.heartbeatMu.Lock()
		select {
		case <-worker.runPermit:
			lease, taken = worker.heartbeatLease, true
		default:
		}
		worker.heartbeatMu.Unlock()
		runtime.Gosched()
	}
	if lease != nil {
		t.Fatal("the next invocation took the run permit while the previous one still held its reservation")
	}
	if err := <-result; err == nil {
		t.Fatal("RunOnce against an unreachable pool returned no error")
	}
	if holders := heartbeatHolders(worker); holders != 0 {
		t.Fatalf("heartbeat holders = %d after the invocation, want 0", holders)
	}
}
