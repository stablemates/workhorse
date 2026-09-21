package workhorse

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// unconnectedPool builds a pool that never opens a connection. Resolving defaults reads the
// options a caller passed and never reaches PostgreSQL.
func unconnectedPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool, err := pgxpool.New(context.Background(), "postgres://workhorse@127.0.0.1:1/workhorse")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// docs/parity.md publishes one runtime default per setting for the three SDKs. These tests assert
// what a Go worker resolves when the caller configures nothing, so a published value cannot outlive
// the behaviour it describes.

func newDefaultWorker(t *testing.T, options WorkerOptions) *Worker {
	t.Helper()
	options.Queue = "defaults"
	options.WorkerID = "defaults-worker"
	options.SharedHeartbeats = true
	worker, err := NewWorker(unconnectedPool(t), options)
	if err != nil {
		t.Fatal(err)
	}
	return worker
}

func TestWorkerResolvesThePublishedDefaults(t *testing.T) {
	worker := newDefaultWorker(t, WorkerOptions{})
	for _, expectation := range []struct {
		setting string
		actual  time.Duration
		want    time.Duration
	}{
		{"lease duration", worker.leaseDuration, 30 * time.Second},
		{"heartbeat interval", worker.heartbeatInterval, 10 * time.Second},
		{"claim poll interval, subscription live", worker.pollInterval, 5 * time.Second},
		{"maintenance tick interval", worker.maintenanceInterval, time.Second},
		{"maintenance routine offer interval", worker.maintenanceRoutineInterval, time.Minute},
		{"registry interval", worker.registryInterval, 5 * time.Second},
		{"shutdown grace", worker.shutdownGracePeriod, 25 * time.Second},
	} {
		if expectation.actual != expectation.want {
			t.Errorf("%s: got %s, want %s", expectation.setting, expectation.actual, expectation.want)
		}
	}
	if worker.concurrency != 1 {
		t.Errorf("concurrency: got %d, want 1", worker.concurrency)
	}
	if worker.retryDelay != nil {
		t.Error("a worker with no options sends no retry delay override")
	}
}

func TestWorkerWithoutNotificationsPollsOnTheShorterInterval(t *testing.T) {
	// A worker that cannot subscribe claims on the poll interval alone, so it starts short and
	// backs off toward the ceiling the two other SDKs share.
	worker := newDefaultWorker(t, WorkerOptions{PollingOnly: true})
	if worker.pollInterval != 250*time.Millisecond {
		t.Fatalf("polling-only poll interval: got %s, want 250ms", worker.pollInterval)
	}
	if delay := workerPollDelay(worker.pollInterval, 0, true); delay > 275*time.Millisecond {
		t.Fatalf("first empty claim waited %s", delay)
	}
	if delay := workerPollDelay(worker.pollInterval, 30, true); delay < 4500*time.Millisecond {
		t.Fatalf("backoff reached %s, want the 5s ceiling", delay)
	}
}

func TestWorkerHoldsTheClaimIntervalFlatWhileItListens(t *testing.T) {
	worker := newDefaultWorker(t, WorkerOptions{})
	for _, empty := range []int{0, 1, 10} {
		delay := workerPollDelay(worker.pollInterval, empty, false)
		if delay < 4500*time.Millisecond || delay > 5500*time.Millisecond {
			t.Fatalf("%d empty claims while listening waited %s, want about 5s", empty, delay)
		}
	}
}

func TestWorkerOffersMaintenanceRoutinesOnTheirOwnCadence(t *testing.T) {
	// The tick runs every second to bound dispatch latency. ADR 0011 puts the slow routines on a
	// minute, because PostgreSQL owns the global due decision.
	worker := newDefaultWorker(t, WorkerOptions{})
	if !worker.dueForMaintenanceRoutines() {
		t.Fatal("the first pass offers the routines")
	}
	if worker.dueForMaintenanceRoutines() {
		t.Fatal("a pass inside the routine interval offers nothing")
	}
	worker.lastRoutineOffer.Store(time.Now().Add(-2 * time.Minute).UnixNano())
	if !worker.dueForMaintenanceRoutines() {
		t.Fatal("a pass after the routine interval offers the routines again")
	}
}

func TestWorkerRejectsAnUnusableMaintenanceRoutineInterval(t *testing.T) {
	if _, err := NewWorker(unconnectedPool(t), WorkerOptions{
		Queue:                      "defaults",
		WorkerID:                   "defaults-worker",
		SharedHeartbeats:           true,
		MaintenanceRoutineInterval: 500 * time.Microsecond,
	}); err == nil {
		t.Fatal("expected a sub-millisecond routine interval to be rejected")
	}
}

func TestWorkerSendsTheRetryDelayOverrideInMilliseconds(t *testing.T) {
	task := ClaimedTask{ID: "task", Attempt: 2}
	worker := newDefaultWorker(t, WorkerOptions{})
	if override := worker.retryDelayOverride(task); override != nil {
		t.Fatalf("a worker without the option sends %v, want nil", override)
	}

	var observed int
	delay := 1500 * time.Millisecond
	worker = newDefaultWorker(t, WorkerOptions{
		RetryDelay: func(attempt int, _ ClaimedTask) *time.Duration {
			observed = attempt
			return &delay
		},
	})
	if override := worker.retryDelayOverride(task); override != int64(1500) {
		t.Fatalf("override: got %v, want 1500", override)
	}
	if observed != task.Attempt {
		t.Fatalf("callback saw attempt %d, want %d", observed, task.Attempt)
	}

	declining := newDefaultWorker(t, WorkerOptions{
		RetryDelay: func(int, ClaimedTask) *time.Duration { return nil },
	})
	if override := declining.retryDelayOverride(task); override != nil {
		t.Fatalf("a callback that declines sends %v, want nil", override)
	}
}
