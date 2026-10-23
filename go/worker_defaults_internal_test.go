package workhorse

import (
	"context"
	"strings"
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

func TestTheDefaultHeartbeatIntervalIsAtLeastTheSmallestSupportedInterval(t *testing.T) {
	// A third of a 150 ms lease is 50 ms, below the 100 ms that every SDK supports.
	worker := newDefaultWorker(t, WorkerOptions{LeaseDuration: 150 * time.Millisecond})
	if worker.heartbeatInterval != 100*time.Millisecond {
		t.Fatalf("heartbeat interval for a 150ms lease: got %s, want 100ms", worker.heartbeatInterval)
	}
	worker = newDefaultWorker(t, WorkerOptions{LeaseDuration: 900 * time.Millisecond})
	if worker.heartbeatInterval != 300*time.Millisecond {
		t.Fatalf("heartbeat interval for a 900ms lease: got %s, want 300ms", worker.heartbeatInterval)
	}
	// The floor is not less than the smallest lease, so the default must still be shorter.
	if _, err := NewWorker(unconnectedPool(t), WorkerOptions{
		Queue: "defaults", LeaseDuration: 100 * time.Millisecond, SharedHeartbeats: true,
	}); err == nil {
		t.Fatal("a 100ms lease with the default heartbeat interval was accepted")
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

func TestWorkerWithoutALiveSubscriptionPollsOnTheShorterInterval(t *testing.T) {
	// The worker expects notifications, but its listener is not live yet or reconnects.
	worker := newDefaultWorker(t, WorkerOptions{})
	if base := worker.claimPollBase(false); base != 250*time.Millisecond {
		t.Fatalf("poll base without a live subscription: got %s, want 250ms", base)
	}
	if base := worker.claimPollBase(true); base != 5*time.Second {
		t.Fatalf("poll base with a live subscription: got %s, want 5s", base)
	}
	// An explicit interval keeps its value in both states.
	explicit := newDefaultWorker(t, WorkerOptions{PollInterval: time.Second})
	for _, listening := range []bool{false, true} {
		if base := explicit.claimPollBase(listening); base != time.Second {
			t.Fatalf("explicit poll base, listening %t: got %s, want 1s", listening, base)
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
	if override, _ := worker.retryDelayOverride(task); override != nil {
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
	if override, _ := worker.retryDelayOverride(task); override != int64(1500) {
		t.Fatalf("override: got %v, want 1500", override)
	}
	if observed != task.Attempt {
		t.Fatalf("callback saw attempt %d, want %d", observed, task.Attempt)
	}

	declining := newDefaultWorker(t, WorkerOptions{
		RetryDelay: func(int, ClaimedTask) *time.Duration { return nil },
	})
	if override, _ := declining.retryDelayOverride(task); override != nil {
		t.Fatalf("a callback that declines sends %v, want nil", override)
	}
}

func TestWorkerRefusesARetryDelayOutsideTheSQLIntegerRange(t *testing.T) {
	task := ClaimedTask{ID: "task", Attempt: 2}
	cases := []struct {
		name  string
		delay time.Duration
		want  any
	}{
		{"the limit", 2147483647 * time.Millisecond, int64(2147483647)},
		{"below the limit by less than half a millisecond", 2147483647*time.Millisecond + 499*time.Microsecond, int64(2147483647)},
		{"zero", 0, int64(0)},
		{"a fraction that rounds down", 1400 * time.Microsecond, int64(1)},
		{"a fraction that rounds up", 1500 * time.Microsecond, int64(2)},
		{"one above the limit", 2147483648 * time.Millisecond, nil},
		{"half a millisecond above the limit", 2147483647*time.Millisecond + 500*time.Microsecond, nil},
		{"a negative delay", -time.Millisecond, nil},
		{"a negative delay that rounds to zero", -time.Nanosecond, nil},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			delay := testCase.delay
			worker := newDefaultWorker(t, WorkerOptions{
				RetryDelay: func(int, ClaimedTask) *time.Duration { return &delay },
			})
			override, err := worker.retryDelayOverride(task)
			if testCase.want == nil {
				if err == nil || !strings.Contains(err.Error(), "RetryDelay") {
					t.Fatalf("override %v: got %v and err %v, want a RetryDelay error", delay, override, err)
				}
				return
			}
			if err != nil || override != testCase.want {
				t.Fatalf("override %v: got %v and err %v, want %v", delay, override, err, testCase.want)
			}
		})
	}
}
