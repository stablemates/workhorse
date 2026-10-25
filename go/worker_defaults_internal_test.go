package workhorse

import (
	"context"
	"math"
	"reflect"
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
}

func TestWorkerMeasuresTheRoutineCadenceOnTheMonotonicClock(t *testing.T) {
	// SM-1688: the cadence follows routineClock only. The wall clock does not move in this test,
	// so a worker that read the wall clock would not offer the routines again.
	worker := newDefaultWorker(t, WorkerOptions{})
	elapsed := time.Hour
	worker.routineClock = func() time.Duration { return elapsed }
	if !worker.dueForMaintenanceRoutines() {
		t.Fatal("the first pass offers the routines")
	}
	elapsed += 59 * time.Second
	if worker.dueForMaintenanceRoutines() {
		t.Fatal("a pass 59 seconds later offers nothing")
	}
	elapsed += time.Second
	if !worker.dueForMaintenanceRoutines() {
		t.Fatal("a pass one routine interval later offers the routines again")
	}
	if worker.lastRoutineOffer.Load() != int64(elapsed) {
		t.Fatalf("last offer: got %d, want the routineClock reading %d", worker.lastRoutineOffer.Load(), int64(elapsed))
	}
}

func TestWorkerRoutineClockIsMonotonic(t *testing.T) {
	// A wall reading such as UnixNano has no monotonic reading. The routine clock must keep it.
	worker := newDefaultWorker(t, WorkerOptions{})
	if got := reflect.ValueOf(worker.routineClock).Pointer(); got != reflect.ValueOf(sinceMonotonicEpoch).Pointer() {
		t.Fatal("the worker measures the routine cadence with sinceMonotonicEpoch")
	}
	if monotonicEpoch.Round(0) == monotonicEpoch {
		t.Fatal("monotonicEpoch has a monotonic reading")
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

// SM-1668 PAR-09: Go cannot tell an unset ShutdownGracePeriod from an explicit zero, so zero means
// the 25 s default. It does not refuse zero, and it does not abandon the handlers at once.
func TestWorkerReadsAZeroShutdownGraceAsTheDefault(t *testing.T) {
	for _, testCase := range []struct {
		name  string
		grace time.Duration
		want  time.Duration
	}{
		{"zero", 0, 25 * time.Second},
		{"one millisecond", time.Millisecond, time.Millisecond},
		{"one day", 24 * time.Hour, 24 * time.Hour},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			worker := newDefaultWorker(t, WorkerOptions{ShutdownGracePeriod: testCase.grace})
			if worker.shutdownGracePeriod != testCase.want {
				t.Fatalf("grace %s: got %s, want %s", testCase.grace, worker.shutdownGracePeriod, testCase.want)
			}
		})
	}
}

// SM-1778: Go refuses a grace above one day, as Ruby, the JVM, and .NET do.
func TestWorkerRefusesANegativeFractionalOrOverlongShutdownGrace(t *testing.T) {
	for _, grace := range []time.Duration{
		-time.Millisecond, time.Microsecond, 1500 * time.Microsecond,
		24*time.Hour + time.Millisecond, time.Duration(math.MaxInt64 / int64(time.Millisecond) * int64(time.Millisecond)),
	} {
		_, err := NewWorker(unconnectedPool(t), WorkerOptions{
			Queue: "defaults", WorkerID: "defaults-worker", SharedHeartbeats: true, ShutdownGracePeriod: grace,
		})
		if err == nil || err.Error() != workerShutdownGraceRangeMessage {
			t.Fatalf("grace %s: got %v, want %q", grace, err, workerShutdownGraceRangeMessage)
		}
	}
}

// SM-1668 PAR-09 (ADR 0112): register_worker_v1 takes each interval as a PostgreSQL integer, and
// its check refuses a value below 100. Every SDK accepts 100 through 2147483647 ms. Zero selects
// the default, because Go cannot tell it from an unset option.
func TestWorkerAcceptsAMaintenanceOrRegistryIntervalFrom100MsThroughTheSQLLimit(t *testing.T) {
	limit := 2147483647 * time.Millisecond
	for _, interval := range []time.Duration{100 * time.Millisecond, limit} {
		worker := newDefaultWorker(t, WorkerOptions{
			MaintenanceInterval: interval, MaintenanceRoutineInterval: interval, RegistryInterval: interval,
		})
		if worker.maintenanceInterval != interval || worker.maintenanceRoutineInterval != interval ||
			worker.registryInterval != interval {
			t.Fatalf("interval %s: got %s, %s, %s", interval,
				worker.maintenanceInterval, worker.maintenanceRoutineInterval, worker.registryInterval)
		}
	}
	worker := newDefaultWorker(t, WorkerOptions{})
	if worker.maintenanceInterval != time.Second || worker.maintenanceRoutineInterval != time.Minute ||
		worker.registryInterval != 5*time.Second {
		t.Fatalf("zero intervals: got %s, %s, %s",
			worker.maintenanceInterval, worker.maintenanceRoutineInterval, worker.registryInterval)
	}
}

func TestWorkerRefusesAMaintenanceOrRegistryIntervalOutsideTheRange(t *testing.T) {
	refused := []time.Duration{
		time.Millisecond, 99 * time.Millisecond, 2147483648 * time.Millisecond,
		-time.Millisecond, 100*time.Millisecond + time.Microsecond,
	}
	for _, testCase := range []struct {
		option  string
		message string
		set     func(*WorkerOptions, time.Duration)
	}{
		{"MaintenanceInterval", workerMaintenanceRangeMessage,
			func(options *WorkerOptions, value time.Duration) { options.MaintenanceInterval = value }},
		{"MaintenanceRoutineInterval", workerRoutineIntervalRangeMessage,
			func(options *WorkerOptions, value time.Duration) { options.MaintenanceRoutineInterval = value }},
		{"RegistryInterval", workerRegistryRangeMessage,
			func(options *WorkerOptions, value time.Duration) { options.RegistryInterval = value }},
	} {
		for _, value := range refused {
			options := WorkerOptions{Queue: "defaults", WorkerID: "defaults-worker", SharedHeartbeats: true}
			testCase.set(&options, value)
			if _, err := NewWorker(unconnectedPool(t), options); err == nil || err.Error() != testCase.message {
				t.Errorf("%s %s: got %v, want %q", testCase.option, value, err, testCase.message)
			}
		}
	}
}

// SM-1778 (ADR 0112): every SDK accepts an explicit poll interval from 1 through 2147483647 whole
// milliseconds. Zero selects the default, because Go cannot tell it from an unset option.
func TestWorkerAcceptsAPollIntervalFrom1MsThroughTheSQLLimit(t *testing.T) {
	for _, testCase := range []struct {
		poll time.Duration
		want time.Duration
	}{
		{0, 5 * time.Second},
		{time.Millisecond, time.Millisecond},
		{2147483647 * time.Millisecond, 2147483647 * time.Millisecond},
	} {
		worker := newDefaultWorker(t, WorkerOptions{PollInterval: testCase.poll})
		if worker.pollInterval != testCase.want {
			t.Fatalf("poll %s: got %s, want %s", testCase.poll, worker.pollInterval, testCase.want)
		}
	}
}

func TestWorkerRefusesAPollIntervalOutsideTheRange(t *testing.T) {
	for _, poll := range []time.Duration{
		-time.Millisecond, time.Nanosecond, 500 * time.Microsecond, 1500 * time.Microsecond,
		2147483648 * time.Millisecond, time.Duration(math.MaxInt64),
	} {
		_, err := NewWorker(unconnectedPool(t), WorkerOptions{
			Queue: "defaults", WorkerID: "defaults-worker", SharedHeartbeats: true, PollInterval: poll,
		})
		if err == nil || err.Error() != workerPollRangeMessage {
			t.Fatalf("poll %s: got %v, want %q", poll, err, workerPollRangeMessage)
		}
	}
}

// SM-1668 PAR-09 (ADR 0112): with a live subscription, an explicit PollInterval is the fallback
// interval, so the 5 s cap does not apply. Without one, the cap applies before the ±10% jitter.
func TestWorkerCapsAnExplicitPollIntervalOnlyWhileItPolls(t *testing.T) {
	worker := newDefaultWorker(t, WorkerOptions{PollInterval: 30 * time.Second})
	for range 50 {
		listening := workerPollDelay(worker.claimPollBase(true), 4, false)
		if listening < 27*time.Second || listening > 33*time.Second {
			t.Fatalf("explicit 30s poll while listening waited %s, want 27s to 33s", listening)
		}
		polling := workerPollDelay(worker.claimPollBase(false), 4, true)
		if polling < 4500*time.Millisecond || polling > 5500*time.Millisecond {
			t.Fatalf("explicit 30s poll while polling waited %s, want 4.5s to 5.5s", polling)
		}
	}
}
