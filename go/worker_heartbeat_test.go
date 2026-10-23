package workhorse_test

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

// observeDatabase opens one connection outside the worker's pool, so a test can read task state
// while every pooled connection is held.
func observeDatabase(t *testing.T, ctx context.Context, databaseURL string) *pgx.Conn {
	t.Helper()
	observer, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = observer.Close(context.Background()) })
	return observer
}

func leaseExpiry(t *testing.T, ctx context.Context, observer *pgx.Conn, taskID string) time.Time {
	t.Helper()
	var expiresAt *time.Time
	if err := observer.QueryRow(
		ctx,
		"SELECT expires_at FROM workhorse.task_runtime WHERE task_id = $1::uuid",
		taskID,
	).Scan(&expiresAt); err != nil {
		t.Fatal(err)
	}
	if expiresAt == nil {
		t.Fatal("claimed task has no lease expiry")
	}
	return *expiresAt
}

// starvedLeaseExpiry reads the lease like leaseExpiry, but reports a missing task_runtime row
// instead of failing on it. A starved completion cannot delete that row, so its absence names the
// cause: the completion found a connection the test should have held.
func starvedLeaseExpiry(t *testing.T, ctx context.Context, observer *pgx.Conn, taskID string) (time.Time, bool) {
	t.Helper()
	var expiresAt *time.Time
	err := observer.QueryRow(
		ctx,
		"SELECT expires_at FROM workhorse.task_runtime WHERE task_id = $1::uuid",
		taskID,
	).Scan(&expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return time.Time{}, false
	}
	if err != nil {
		t.Fatal(err)
	}
	if expiresAt == nil {
		t.Fatal("claimed task has no lease expiry")
	}
	return *expiresAt, true
}

// waitForLeaseRenewal waits until the lease expiry moves past previous, which only an accepted
// heartbeat does.
func waitForLeaseRenewal(
	t *testing.T,
	ctx context.Context,
	observer *pgx.Conn,
	taskID string,
	previous time.Time,
	within time.Duration,
) time.Time {
	t.Helper()
	deadline := time.Now().Add(within)
	for {
		expiresAt := leaseExpiry(t, ctx, observer, taskID)
		if expiresAt.After(previous) {
			return expiresAt
		}
		if time.Now().After(deadline) {
			t.Fatalf("lease was not renewed within %s", within)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// holdLendableConnections takes every connection the pool can still lend and keeps them until the
// returned release runs or the test ends. A timed-out acquire is not proof of exhaustion: pgxpool
// keeps dialing after the caller gives up and lends that connection to the next caller. So the
// loop counts the pool instead, and the cleanup releases the connections before the pool closes.
func holdLendableConnections(t *testing.T, ctx context.Context, pool *pgxpool.Pool) func() {
	t.Helper()
	var held []*pgxpool.Conn
	release := func() {
		for _, connection := range held {
			connection.Release()
		}
		held = nil
	}
	t.Cleanup(release)
	for pool.Stat().AcquiredConns() < pool.Config().MaxConns {
		// The wait only bounds a hang. A stalled host can take many seconds to dial a connection.
		acquireContext, cancel := context.WithTimeout(ctx, 30*time.Second)
		connection, err := pool.Acquire(acquireContext)
		cancel()
		if err != nil {
			t.Fatalf("the starving test could not take a lendable connection: %v", err)
		}
		held = append(held, connection)
	}
	if len(held) == 0 {
		t.Fatal("the pool lent no connection to the starving test")
	}
	if stat := pool.Stat(); stat.IdleConns() != 0 || stat.ConstructingConns() != 0 {
		t.Fatalf(
			"the starved pool still has %d idle and %d constructing connections",
			stat.IdleConns(), stat.ConstructingConns(),
		)
	}
	return release
}

// releaseOnce closes a handler's release channel at most once, and closes it at cleanup when a
// failed assertion returned first, so a blocked handler cannot keep its connection from the pool.
func releaseOnce(t *testing.T) (<-chan struct{}, func()) {
	release := make(chan struct{})
	var once sync.Once
	closeRelease := func() { once.Do(func() { close(release) }) }
	t.Cleanup(closeRelease)
	return release, closeRelease
}

// reservedHeartbeatInterval gives each round a bound of 375 ms. An interval of 20 ms gives a bound of
// 20 ms, and on a loaded host the statement timeout ends rounds. A failed round discards the
// reserved connection. The test holds every other pooled connection. Thus no later round can renew
// the lease.
const reservedHeartbeatInterval = 500 * time.Millisecond

// reservedRenewalWait is how long the test waits for each renewal. It is shorter than the lease of
// 5 s, so a missed renewal fails the test before the lease expires.
const reservedRenewalWait = 4 * time.Second

// TestWorkerHeartbeatsRenewWhileHandlersHoldEveryOtherPooledConnection pins the reservation: a
// heartbeat never queues behind handlers, because its connection left the pool before they ran.
func TestWorkerHeartbeatsRenewWhileHandlersHoldEveryOtherPooledConnection(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-reserved-heartbeat")
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
	observer := observeDatabase(t, ctx, databaseURL)

	queueName := "go-worker-reserved-heartbeat"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskID, err := queue.Enqueue(ctx, "reserved-heartbeat", nil)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:               queueName,
		WorkerID:            "reserved-heartbeat-worker",
		LeaseDuration:       5 * time.Second,
		HeartbeatInterval:   reservedHeartbeatInterval,
		PollInterval:        5 * time.Millisecond,
		MaintenanceInterval: 20 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	release, releaseHandler := releaseOnce(t)
	worker.Handle("reserved-heartbeat", func(_ context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		close(started)
		<-release
		return nil, nil
	})
	workerResult := make(chan error, 1)
	go func() {
		processed, err := worker.RunOnce(ctx)
		if err == nil && !processed {
			err = errors.New("worker did not process the reserved-heartbeat task")
		}
		workerResult <- err
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not start the handler")
	}

	// Take every connection the pool can still lend. The reservation left before the handler ran,
	// so the heartbeat round does not compete for these.
	releaseHeld := holdLendableConnections(t, ctx, pool)
	expiresAt := leaseExpiry(t, ctx, observer, taskID)
	renewed := waitForLeaseRenewal(t, ctx, observer, taskID, expiresAt, reservedRenewalWait)
	waitForLeaseRenewal(t, ctx, observer, taskID, renewed, reservedRenewalWait)
	releaseHeld()

	releaseHandler()
	select {
	case err := <-workerResult:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not settle the starved task")
	}
	var state string
	if err := observer.QueryRow(
		ctx,
		"SELECT state FROM workhorse.task_outcome WHERE task_id = $1::uuid",
		taskID,
	).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "succeeded" {
		t.Fatalf("expected the starved attempt to succeed, received %s", state)
	}
}

// TestWorkerKeepsTheLeaseUntilTheCompletionIsWritten pins renewal through finalization: a
// completion that waits longer than a whole lease for a pooled connection still settles the task
// under the fence it was claimed with. A cancellation that arrives during that wait still ends the
// attempt with one terminal transition, written by recovery once the refused renewal lets the lease lapse.
//
// The starvation holds only while every heartbeat round renews in time. On a loaded host that
// precondition can break in two ways. A round can overrun its bound and discard the reserved
// connection, and the waiting completion then takes the freed slot. Or the worker can send a round
// that does not renew within a whole lease, and the lease watchdog then ends the renewal. That
// attempt cannot test the starved finalization, so the test makes a new attempt. A watchdog with no
// round sent during the lease is the defect this test catches, so it fails at once.
func TestWorkerKeepsTheLeaseUntilTheCompletionIsWritten(t *testing.T) {
	for _, test := range []struct {
		name      string
		cancel    bool
		wantState string
	}{
		{name: "completes under the claimed fence", wantState: "succeeded"},
		{name: "settles a cancellation requested during finalization", cancel: true, wantState: "canceled"},
	} {
		t.Run(test.name, func(t *testing.T) {
			held, breaks := repeatStarvedFinalization(
				delayedFinalizationAttempts, delayedFinalizationSpacing, t.Logf, time.Sleep,
				func(attempt int) (string, bool) {
					return assertDelayedFinalization(t, attempt, test.cancel, test.wantState)
				},
			)
			if held == 0 {
				t.Fatalf(
					"the starvation precondition broke in each of %d attempts, so no attempt tested the starved finalization: %s",
					delayedFinalizationAttempts, strings.Join(breaks, "; "),
				)
			}
			t.Logf("the starved finalization held in attempt %d of %d", held, delayedFinalizationAttempts)
		})
	}
}

// delayedFinalizationAttempts is the most attempts assertDelayedFinalization gets to keep the
// starvation precondition intact.
const delayedFinalizationAttempts = 5

// delayedFinalizationSpacing is the wait before attempt 2. The wait doubles before each later
// attempt: 5 s, 10 s, 20 s, then 40 s.
const delayedFinalizationSpacing = 5 * time.Second

// The names of the two ways the starvation precondition breaks.
const (
	heartbeatRoundFailedBreak = "a heartbeat round failed"
	leaseWatchdogBreak        = "the lease watchdog fired after a round"
)

// repeatStarvedFinalization runs attempt until one attempt holds or limit attempts broke. It returns
// the attempt that held, or 0, and the break of each broken attempt. Before attempt 2 it waits
// spacing. A stall can last longer than one attempt, so the wait doubles before each later attempt.
func repeatStarvedFinalization(
	limit int,
	spacing time.Duration,
	logf func(string, ...any),
	sleep func(time.Duration),
	attempt func(int) (broke string, held bool),
) (int, []string) {
	var breaks []string
	for number := 1; number <= limit; number++ {
		broke, held := attempt(number)
		if held {
			return number, breaks
		}
		breaks = append(breaks, "attempt "+strconv.Itoa(number)+": "+broke)
		if number == limit {
			break
		}
		wait := spacing << (number - 1)
		logf("attempt %d: %s, so the test makes a new attempt in %s", number, broke, wait)
		sleep(wait)
	}
	return 0, breaks
}

// starvationCheck is what one attempt observed when its starvation check failed.
type starvationCheck struct {
	cancel bool
	// leased is true if the task_runtime row still exists.
	leased      bool
	roundFailed bool
	// watchdogAt is the time of the lease watchdog record. It is zero if the worker logged none.
	watchdogAt time.Time
	// renewedAt is the database time of the last accepted renewal. PostgreSQL samples it inside the
	// heartbeat statement, so the accepted round started before it and every later round after it.
	renewedAt   time.Time
	roundStarts []time.Time
}

type starvationVerdict int

const (
	starvationBroke starvationVerdict = iota
	watchdogWithoutRound
	completionWhileStarved
	renewalStopped
)

// classifyStarvation decides what a failed starvation check means. A failed round breaks the
// precondition. Without a cancellation, a watchdog also breaks it if a round started after the last
// accepted renewal and by the watchdog record. A cancellation refuses renewal, so its watchdog is
// expected and breaks nothing. Every other result is a failure of the test.
func classifyStarvation(check starvationCheck) (starvationVerdict, string) {
	switch {
	case check.roundFailed:
		return starvationBroke, heartbeatRoundFailedBreak
	case check.cancel || !check.leased:
		return completionWhileStarved, ""
	case check.watchdogAt.IsZero():
		return renewalStopped, ""
	}
	for _, start := range check.roundStarts {
		if start.After(check.renewedAt) && !start.After(check.watchdogAt) {
			return starvationBroke, leaseWatchdogBreak
		}
	}
	return watchdogWithoutRound, ""
}

// assertDelayedFinalization runs one attempt of the starved finalization. If the starvation check
// failed after the precondition broke, it returns held false and the name of the break. The
// precondition breaks when a heartbeat round fails, or, without a cancellation, when the lease
// watchdog fires after the worker sent a round during that lease. Any other failed check fails the
// test.
func assertDelayedFinalization(t *testing.T, attempt int, cancel bool, wantState string) (broke string, held bool) {
	databaseURL := createConformanceDatabase(
		t, testDatabaseURL(t), "worker-finalization-lease-"+strconv.Itoa(attempt),
	)
	ctx := context.Background()
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = 3
	rounds := &heartbeatRoundRecorder{}
	config.ConnConfig.Tracer = rounds
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	observer := observeDatabase(t, ctx, databaseURL)
	operator, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(operator.Close)

	queueName := "go-worker-finalization-lease"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(operator), queueName)
	taskID, err := queue.Enqueue(ctx, "finalization-lease", nil)
	if err != nil {
		t.Fatal(err)
	}
	// A heartbeat round is bounded by the interval, and a round that overruns discards the reserved
	// connection. The completion is already waiting on the pool and would take that freed slot. So
	// the interval must leave a loaded runner room to finish a round, and the log tells the test when
	// a round did not finish.
	const lease = time.Second
	logs := newWorkerLogRecorder()
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:             queueName,
		WorkerID:          "finalization-lease-worker",
		LeaseDuration:     lease,
		HeartbeatInterval: 200 * time.Millisecond,
		PollInterval:      5 * time.Millisecond,
		Logger:            slog.New(logs),
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	release, releaseHandler := releaseOnce(t)
	worker.Handle("finalization-lease", func(_ context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		close(started)
		<-release
		return map[string]any{"settled": true}, nil
	})
	workerResult := make(chan error, 1)
	go func() {
		processed, err := worker.RunOnce(ctx)
		if err == nil && !processed {
			err = errors.New("worker did not process the finalization-lease task")
		}
		workerResult <- err
	}()
	// The liveness waits only bound a hang. A stalled host can take many seconds to claim or settle.
	select {
	case <-started:
	case <-time.After(30 * time.Second):
		t.Fatalf("attempt %d of %d: worker did not start the handler", attempt, delayedFinalizationAttempts)
	}
	var claimedFence int64
	if err := observer.QueryRow(
		ctx,
		"SELECT fence_token FROM workhorse.task_runtime WHERE task_id = $1::uuid",
		taskID,
	).Scan(&claimedFence); err != nil {
		t.Fatal(err)
	}

	// Hold every connection the pool can still lend, then let the handler return. The completion
	// queues behind them for several leases while only the reserved heartbeat can renew.
	releaseHeld := holdLendableConnections(t, ctx, pool)
	expiresAt := leaseExpiry(t, ctx, observer, taskID)
	releaseHandler()
	var cancelError error
	if cancel {
		_, cancelError = queue.Cancel(ctx, taskID, workhorse.CancellationRequest{})
	}
	time.Sleep(3 * lease)
	renewed, leased := starvedLeaseExpiry(t, ctx, observer, taskID)
	releaseHeld()
	if cancelError != nil {
		t.Fatal(cancelError)
	}
	starved := leased && (cancel || renewed.After(expiresAt.Add(lease)))
	// The worker logs a failed round just after it discards the connection. So the log can come after
	// the completion that took the freed slot.
	if !starved {
		check := starvationCheck{
			cancel:      cancel,
			leased:      leased,
			roundFailed: logs.waitFor(heartbeatRoundFailedMessage, time.Second),
			roundStarts: rounds.snapshot(),
		}
		if leased {
			check.renewedAt = renewed.Add(-lease)
		}
		if watchdogAt, fired := logs.eventTime(leaseWatchdogEvent); fired {
			check.watchdogAt = watchdogAt
		}
		verdict, name := classifyStarvation(check)
		switch verdict {
		case starvationBroke:
			broke = name
		case watchdogWithoutRound:
			t.Fatalf(
				"attempt %d of %d: the lease watchdog fired at %s, but the worker sent no heartbeat round after the renewal at %s\nworker log:\n%s",
				attempt, delayedFinalizationAttempts, check.watchdogAt, check.renewedAt, logs.text(),
			)
		case completionWhileStarved:
			t.Fatalf(
				"attempt %d of %d: the completion was written while the pool was starved: task %s has no task_runtime row\nworker log:\n%s",
				attempt, delayedFinalizationAttempts, taskID, logs.text(),
			)
		default:
			t.Fatalf(
				"attempt %d of %d: lease stopped renewing during finalization: claimed until %s, now until %s\nworker log:\n%s",
				attempt, delayedFinalizationAttempts, expiresAt, renewed, logs.text(),
			)
		}
	}

	select {
	case err := <-workerResult:
		if err != nil {
			t.Fatalf("attempt %d of %d: %v", attempt, delayedFinalizationAttempts, err)
		}
	case <-time.After(30 * time.Second):
		t.Fatalf("attempt %d of %d: worker did not settle the delayed completion", attempt, delayedFinalizationAttempts)
	}
	if !starved {
		// PostgreSQL writes a completion only under the live lease and the claimed fence. A
		// cancellation can end either way, because the completion can take the freed slot before the
		// refused renewal lets the lease lapse.
		if !leased && !cancel {
			assertFinalizationOutcome(t, ctx, observer, taskID, attempt, "succeeded", claimedFence)
		}
		return broke, false
	}
	if cancel {
		// Cancellation refuses renewal, so the starved acknowledgement finds the lease gone. Lease
		// recovery then settles the requested cancellation under the claimed fence.
		if _, err := observer.Exec(ctx, "SELECT workhorse.recover_expired_v1()"); err != nil {
			t.Fatal(err)
		}
	}
	assertFinalizationOutcome(t, ctx, observer, taskID, attempt, wantState, claimedFence)
	return "", true
}

// assertFinalizationOutcome checks that the first attempt of the task ended in wantState under the
// claimed fence. testAttempt is the attempt of the test, not of the task.
func assertFinalizationOutcome(
	t *testing.T,
	ctx context.Context,
	observer *pgx.Conn,
	taskID string,
	testAttempt int,
	wantState string,
	claimedFence int64,
) {
	t.Helper()
	var state string
	var fence int64
	var attempt int
	if err := observer.QueryRow(
		ctx,
		"SELECT state, fence_token, current_attempt FROM workhorse.task_outcome WHERE task_id = $1::uuid",
		taskID,
	).Scan(&state, &fence, &attempt); err != nil {
		t.Fatalf("test attempt %d of %d: %v", testAttempt, delayedFinalizationAttempts, err)
	}
	if state != wantState || fence != claimedFence || attempt != 1 {
		t.Fatalf(
			"test attempt %d of %d: expected the delayed finalization to end %s under fence %d on attempt 1, received %s under fence %d on attempt %d",
			testAttempt, delayedFinalizationAttempts, wantState, claimedFence, state, fence, attempt,
		)
	}
}

// heartbeatRoundFailedMessage is the exact message of the record a worker logs for a failed
// heartbeat round.
const heartbeatRoundFailedMessage = "heartbeat round failed; retrying"

// workerLogRecorder is a slog.Handler that counts the records of each exact message. It also keeps
// the text of every record, so a test can print the whole log on a failure.
type workerLogRecorder struct {
	state   *workerLogState
	handler slog.Handler
}

type workerLogState struct {
	mu       sync.Mutex
	messages map[string]int
	// events keeps the time of the first record of each event.name value.
	events map[string]time.Time
	buffer lockedBuffer
}

func newWorkerLogRecorder() *workerLogRecorder {
	state := &workerLogState{messages: make(map[string]int), events: make(map[string]time.Time)}
	return &workerLogRecorder{state: state, handler: slog.NewTextHandler(&state.buffer, nil)}
}

func (recorder *workerLogRecorder) Enabled(ctx context.Context, level slog.Level) bool {
	return recorder.handler.Enabled(ctx, level)
}

func (recorder *workerLogRecorder) Handle(ctx context.Context, record slog.Record) error {
	recorder.state.mu.Lock()
	recorder.state.messages[record.Message]++
	record.Attrs(func(attribute slog.Attr) bool {
		if attribute.Key != "event.name" {
			return true
		}
		if _, seen := recorder.state.events[attribute.Value.String()]; !seen {
			recorder.state.events[attribute.Value.String()] = record.Time
		}
		return false
	})
	recorder.state.mu.Unlock()
	return recorder.handler.Handle(ctx, record)
}

func (recorder *workerLogRecorder) WithAttrs(attributes []slog.Attr) slog.Handler {
	return &workerLogRecorder{state: recorder.state, handler: recorder.handler.WithAttrs(attributes)}
}

func (recorder *workerLogRecorder) WithGroup(name string) slog.Handler {
	return &workerLogRecorder{state: recorder.state, handler: recorder.handler.WithGroup(name)}
}

// waitFor reports whether the worker logs a record with exactly message within the given time.
func (recorder *workerLogRecorder) waitFor(message string, within time.Duration) bool {
	deadline := time.Now().Add(within)
	for {
		recorder.state.mu.Lock()
		count := recorder.state.messages[message]
		recorder.state.mu.Unlock()
		if count > 0 {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(time.Millisecond)
	}
}

// eventTime returns the time of the first record whose event.name is exactly event.
func (recorder *workerLogRecorder) eventTime(event string) (time.Time, bool) {
	recorder.state.mu.Lock()
	defer recorder.state.mu.Unlock()
	at, ok := recorder.state.events[event]
	return at, ok
}

func (recorder *workerLogRecorder) text() string {
	return recorder.state.buffer.String()
}

// leaseWatchdogEvent is the event.name of the record a worker logs when no heartbeat was accepted
// within the task lease.
const leaseWatchdogEvent = "workhorse.task.lease_expired"

// heartbeatRoundRecorder is a pgx tracer that keeps the start time of each heartbeat statement. A
// test uses it to find whether the worker tried to renew after a renewal.
type heartbeatRoundRecorder struct {
	mu     sync.Mutex
	starts []time.Time
}

func (recorder *heartbeatRoundRecorder) TraceQueryStart(
	ctx context.Context,
	_ *pgx.Conn,
	data pgx.TraceQueryStartData,
) context.Context {
	if strings.Contains(data.SQL, "heartbeat_many_v2") {
		recorder.mu.Lock()
		recorder.starts = append(recorder.starts, time.Now())
		recorder.mu.Unlock()
	}
	return ctx
}

func (*heartbeatRoundRecorder) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

// snapshot returns the start time of each heartbeat statement so far.
func (recorder *heartbeatRoundRecorder) snapshot() []time.Time {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	return append([]time.Time(nil), recorder.starts...)
}

// TestClassifyStarvation pins which failed starvation checks give the test a new attempt.
func TestClassifyStarvation(t *testing.T) {
	renewedAt := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	watchdogAt := renewedAt.Add(time.Second)
	// The accepted round starts before PostgreSQL samples the renewal time.
	acceptedRound := renewedAt.Add(-20 * time.Millisecond)
	laterRound := renewedAt.Add(200 * time.Millisecond)
	for _, test := range []struct {
		name        string
		check       starvationCheck
		wantVerdict starvationVerdict
		wantBreak   string
	}{
		{
			name:        "a failed round breaks the precondition",
			check:       starvationCheck{leased: true, roundFailed: true},
			wantVerdict: starvationBroke,
			wantBreak:   heartbeatRoundFailedBreak,
		},
		{
			name:        "a failed round breaks it during a cancellation",
			check:       starvationCheck{cancel: true, roundFailed: true},
			wantVerdict: starvationBroke,
			wantBreak:   heartbeatRoundFailedBreak,
		},
		{
			name: "a watchdog after a later round breaks the precondition",
			check: starvationCheck{
				leased: true, watchdogAt: watchdogAt, renewedAt: renewedAt,
				roundStarts: []time.Time{acceptedRound, laterRound},
			},
			wantVerdict: starvationBroke,
			wantBreak:   leaseWatchdogBreak,
		},
		{
			name: "the accepted round alone does not excuse a watchdog",
			check: starvationCheck{
				leased: true, watchdogAt: watchdogAt, renewedAt: renewedAt,
				roundStarts: []time.Time{acceptedRound},
			},
			wantVerdict: watchdogWithoutRound,
		},
		{
			name: "a round after the watchdog does not excuse it",
			check: starvationCheck{
				leased: true, watchdogAt: watchdogAt, renewedAt: renewedAt,
				roundStarts: []time.Time{acceptedRound, watchdogAt.Add(time.Millisecond)},
			},
			wantVerdict: watchdogWithoutRound,
		},
		{
			name: "a watchdog does not excuse an early completion",
			check: starvationCheck{
				watchdogAt: watchdogAt, roundStarts: []time.Time{laterRound},
			},
			wantVerdict: completionWhileStarved,
		},
		{
			name: "a cancellation watchdog does not excuse an early completion",
			check: starvationCheck{
				cancel: true, watchdogAt: watchdogAt, roundStarts: []time.Time{laterRound},
			},
			wantVerdict: completionWhileStarved,
		},
		{
			name:        "a lease that stopped renewing with no record fails",
			check:       starvationCheck{leased: true, renewedAt: renewedAt, roundStarts: []time.Time{laterRound}},
			wantVerdict: renewalStopped,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			verdict, broke := classifyStarvation(test.check)
			if verdict != test.wantVerdict || broke != test.wantBreak {
				t.Fatalf("received verdict %d and break %q, want verdict %d and break %q",
					verdict, broke, test.wantVerdict, test.wantBreak)
			}
		})
	}
}

// TestRepeatStarvedFinalizationStopsAtTheLimit pins the attempt limit, the doubled waits, and the
// break of each attempt.
func TestRepeatStarvedFinalizationStopsAtTheLimit(t *testing.T) {
	var waits []time.Duration
	held, breaks := repeatStarvedFinalization(
		5, 5*time.Second, t.Logf, func(wait time.Duration) { waits = append(waits, wait) },
		func(int) (string, bool) { return heartbeatRoundFailedBreak, false },
	)
	if held != 0 || len(breaks) != 5 {
		t.Fatalf("expected no attempt to hold and 5 breaks, received %d and %q", held, breaks)
	}
	if breaks[4] != "attempt 5: "+heartbeatRoundFailedBreak {
		t.Fatalf("unexpected last break %q", breaks[4])
	}
	want := []time.Duration{5 * time.Second, 10 * time.Second, 20 * time.Second, 40 * time.Second}
	if len(waits) != len(want) {
		t.Fatalf("expected waits %v, received %v", want, waits)
	}
	for index := range want {
		if waits[index] != want[index] {
			t.Fatalf("expected waits %v, received %v", want, waits)
		}
	}

	waits = nil
	held, breaks = repeatStarvedFinalization(
		5, 5*time.Second, t.Logf, func(wait time.Duration) { waits = append(waits, wait) },
		func(attempt int) (string, bool) { return leaseWatchdogBreak, attempt == 3 },
	)
	if held != 3 || len(breaks) != 2 || len(waits) != 2 {
		t.Fatalf("expected attempt 3 to hold after 2 breaks and 2 waits, received %d, %q, and %v", held, breaks, waits)
	}
}

// TestNewWorkerRefusesAPoolThatCannotLendAHeartbeatConnection pins the construction refusal and its
// opt-out, so an operator learns about the risk instead of inheriting it silently.
func TestNewWorkerRefusesAPoolThatCannotLendAHeartbeatConnection(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-heartbeat-capacity")
	ctx := context.Background()
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = 2
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	if _, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-worker-heartbeat-capacity",
	}); err == nil {
		t.Fatal("expected a pool of 2 connections to refuse a worker")
	} else {
		for _, fragment := range []string{"MaxConns", "2", "SharedHeartbeats"} {
			if !strings.Contains(err.Error(), fragment) {
				t.Fatalf("refusal does not name %q: %v", fragment, err)
			}
		}
	}
	if _, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:            "go-worker-heartbeat-capacity",
		SharedHeartbeats: true,
	}); err != nil {
		t.Fatalf("expected the opt-out to run on a pool of 2 connections: %v", err)
	}
}

// retryLeaseDuration is the lease of the retry test. It is many heartbeat intervals long, so a few
// rounds that the load ends do not let the lease expire.
const retryLeaseDuration = 10 * time.Second

// retryRenewalWait is how long the retry test waits for each event: one renewal, or the failed
// round. Each wait is shorter than retryLeaseDuration, so a single missed renewal fails the test
// before the lease that it measures expires.
const retryRenewalWait = 8 * time.Second

// TestWorkerRetriesAFailedHeartbeatRoundAndKeepsTasksRunning pins the retry: a round that fails is
// unknown, not a lease loss, so the handler keeps running and the next round renews the lease.
//
// The test uses reservedHeartbeatInterval. With an interval of 20 ms, each round has a statement
// timeout of 5 ms, and on a loaded host that timeout ends most rounds before they renew the lease.
func TestWorkerRetriesAFailedHeartbeatRoundAndKeepsTasksRunning(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-heartbeat-retry")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	observer := observeDatabase(t, ctx, databaseURL)

	var logs lockedBuffer
	queueName := "go-worker-heartbeat-retry"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskID, err := queue.Enqueue(ctx, "heartbeat-retry", nil)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:               queueName,
		WorkerID:            "heartbeat-retry-worker",
		LeaseDuration:       retryLeaseDuration,
		HeartbeatInterval:   reservedHeartbeatInterval,
		PollInterval:        5 * time.Millisecond,
		MaintenanceInterval: 20 * time.Millisecond,
		Logger:              slog.New(slog.NewTextHandler(&logs, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	release := make(chan struct{})
	cancelled := make(chan struct{}, 1)
	worker.Handle("heartbeat-retry", func(handlerContext context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		close(started)
		select {
		case <-release:
		case <-handlerContext.Done():
			cancelled <- struct{}{}
		}
		return nil, nil
	})
	workerResult := make(chan error, 1)
	go func() {
		processed, err := worker.RunOnce(ctx)
		if err == nil && !processed {
			err = errors.New("worker did not process the heartbeat-retry task")
		}
		workerResult <- err
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not start the handler")
	}
	claimed := leaseExpiry(t, ctx, observer, taskID)
	waitForLeaseRenewal(t, ctx, observer, taskID, claimed, retryRenewalWait)

	// Kill the session the reserved connection heartbeats on. The next round fails on it, and the
	// round after that renews on a connection the pool lends fresh. A round that the load ended
	// before this point does not count, so the test waits for a failure logged after the kill.
	failedRounds := strings.Count(logs.String(), heartbeatRoundFailedMessage)
	terminateHeartbeatSession(t, ctx, observer)
	waitForWorkerLogCount(t, &logs, heartbeatRoundFailedMessage, failedRounds+1, retryRenewalWait)
	select {
	case <-cancelled:
		t.Fatal("a failed heartbeat round cancelled the handler")
	default:
	}
	failed := leaseExpiry(t, ctx, observer, taskID)
	waitForLeaseRenewal(t, ctx, observer, taskID, failed, retryRenewalWait)

	close(release)
	select {
	case err := <-workerResult:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not settle the task whose heartbeat round failed")
	}
	var state string
	if err := observer.QueryRow(
		ctx,
		"SELECT state FROM workhorse.task_outcome WHERE task_id = $1::uuid",
		taskID,
	).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "succeeded" {
		t.Fatalf("expected the retried attempt to succeed, received %s", state)
	}
}

// waitForWorkerLogCount waits until logs holds message at least count times, for a maximum of within.
func waitForWorkerLogCount(t *testing.T, logs *lockedBuffer, message string, count int, within time.Duration) {
	t.Helper()
	deadline := time.Now().Add(within)
	for strings.Count(logs.String(), message) < count {
		if time.Now().After(deadline) {
			t.Fatalf("worker did not log %q %d times within %s", message, count, within)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// terminateHeartbeatSession ends the backend the reserved connection sent its last heartbeat on. A
// round ends with the commit of its transaction, and no other worker statement sends one.
func terminateHeartbeatSession(t *testing.T, ctx context.Context, observer *pgx.Conn) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		var terminated bool
		err := observer.QueryRow(
			ctx,
			`SELECT pg_terminate_backend(pid)
			 FROM pg_stat_activity
			 WHERE datname = current_database()
			   AND pid <> pg_backend_pid()
			   AND (query LIKE '%heartbeat_many_v2%' OR lower(query) = 'commit')
			 LIMIT 1`,
		).Scan(&terminated)
		if err == nil && terminated {
			return
		}
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal(err)
		}
		if time.Now().After(deadline) {
			t.Fatal("no heartbeat session was found to terminate")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TestWorkerWatchdogCancelsAHandlerAfterALeaseWithoutAnAcceptedHeartbeat pins the local watchdog: a
// heartbeat that never answers still ends the attempt, because by then a peer may own the task.
func TestWorkerWatchdogCancelsAHandlerAfterALeaseWithoutAnAcceptedHeartbeat(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-lease-watchdog")
	ctx := context.Background()
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	// Every heartbeat statement stalls for longer than the lease, which is what a heartbeat that
	// never returns looks like to the worker.
	config.ConnConfig.Tracer = newHeartbeatQueryTracer(time.Second)
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	observer := observeDatabase(t, ctx, databaseURL)

	var logs lockedBuffer
	queueName := "go-worker-lease-watchdog"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskID, err := queue.Enqueue(ctx, "lease-watchdog", nil)
	if err != nil {
		t.Fatal(err)
	}
	leaseDuration := 300 * time.Millisecond
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:               queueName,
		WorkerID:            "lease-watchdog-worker",
		LeaseDuration:       leaseDuration,
		HeartbeatInterval:   100 * time.Millisecond,
		PollInterval:        5 * time.Millisecond,
		MaintenanceInterval: time.Minute,
		Logger:              slog.New(slog.NewTextHandler(&logs, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan time.Time, 1)
	causes := make(chan error, 1)
	worker.Handle("lease-watchdog", func(handlerContext context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		started <- time.Now()
		<-handlerContext.Done()
		causes <- context.Cause(handlerContext)
		return nil, nil
	})
	workerResult := make(chan error, 1)
	go func() {
		processed, err := worker.RunOnce(ctx)
		if err == nil && !processed {
			err = errors.New("worker did not process the lease-watchdog task")
		}
		workerResult <- err
	}()
	var claimedAt time.Time
	select {
	case claimedAt = <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not start the handler")
	}
	select {
	case cause := <-causes:
		if !errors.Is(cause, workhorse.ErrLeaseLost) {
			t.Fatalf("expected the watchdog to cancel the handler with a lost lease, received %v", cause)
		}
		if elapsed := time.Since(claimedAt); elapsed > 3*leaseDuration {
			t.Fatalf("watchdog waited %s for a lease of %s", elapsed, leaseDuration)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("watchdog did not cancel the handler within a lease")
	}
	select {
	case err := <-workerResult:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not return after the watchdog fired")
	}
	if !strings.Contains(logs.String(), "workhorse.handler.outcome=lease_lost") {
		t.Fatalf("expected a lease_lost execution outcome, logged:\n%s", logs.String())
	}
	// A lost lease is recorded, not settled: lease recovery owns the task now, so this worker must
	// not submit a failure for it.
	var settled bool
	if err := observer.QueryRow(
		ctx,
		"SELECT EXISTS (SELECT 1 FROM workhorse.task_outcome WHERE task_id = $1::uuid)",
		taskID,
	).Scan(&settled); err != nil {
		t.Fatal(err)
	}
	if settled {
		t.Fatal("the watchdog settled a task whose lease it had already lost")
	}
}

// heartbeatSessionPID waits for a backend other than the observer's that last ran a heartbeat or its
// commit,
// skipping the session named by previous, and returns its pid.
func heartbeatSessionPID(t *testing.T, ctx context.Context, observer *pgx.Conn, previous uint32) uint32 {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		var pid uint32
		err := observer.QueryRow(
			ctx,
			`SELECT pid
			 FROM pg_stat_activity
			 WHERE datname = current_database()
			   AND pid <> pg_backend_pid()
			   AND pid <> $1
			   AND (query LIKE '%heartbeat_many_v2%' OR lower(query) = 'commit')
			 LIMIT 1`,
			previous,
		).Scan(&pid)
		if err == nil {
			return pid
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal(err)
		}
		if time.Now().After(deadline) {
			t.Fatal("no heartbeat session was found")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TestWorkerRunSurvivesTheTerminationOfItsIdleHeartbeatConnection pins the idle case: PostgreSQL
// may end the reserved heartbeat session while no task runs, and Run keeps running. The next task's
// first round fails on the dead session, and the round after renews on a fresh connection.
func TestWorkerRunSurvivesTheTerminationOfItsIdleHeartbeatConnection(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-idle-heartbeat-termination")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	observer := observeDatabase(t, ctx, databaseURL)

	var logs lockedBuffer
	queueName := "go-worker-idle-heartbeat-termination"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:               queueName,
		WorkerID:            "idle-heartbeat-termination-worker",
		LeaseDuration:       10 * time.Second,
		HeartbeatInterval:   100 * time.Millisecond,
		PollInterval:        5 * time.Millisecond,
		MaintenanceInterval: 20 * time.Millisecond,
		Logger:              slog.New(slog.NewTextHandler(&logs, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan string, 2)
	releases := map[string]chan struct{}{"before": make(chan struct{}), "after": make(chan struct{})}
	cancelled := make(chan string, 2)
	worker.Handle("idle-heartbeat", func(handlerContext context.Context, payload any, _ *workhorse.HandlerContext) (any, error) {
		document, _ := payload.(map[string]any)
		name, _ := document["name"].(string)
		started <- name
		select {
		case <-releases[name]:
		case <-handlerContext.Done():
			cancelled <- name
		}
		return nil, nil
	})
	runContext, stopRun := context.WithCancel(ctx)
	defer stopRun()
	runResult := make(chan error, 1)
	go func() { runResult <- worker.Run(runContext) }()

	runTask := func(name string, previousSession uint32) uint32 {
		t.Helper()
		taskID, err := queue.Enqueue(ctx, "idle-heartbeat", map[string]any{"name": name})
		if err != nil {
			t.Fatal(err)
		}
		select {
		case startedName := <-started:
			if startedName != name {
				t.Fatalf("expected task %q to start, received %q", name, startedName)
			}
		case <-time.After(5 * time.Second):
			select {
			case err := <-runResult:
				t.Fatalf("Run returned before task %q started: %v", name, err)
			default:
			}
			t.Fatalf("worker did not start task %q, logged:\n%s", name, logs.String())
		}
		claimed := leaseExpiry(t, ctx, observer, taskID)
		waitForLeaseRenewal(t, ctx, observer, taskID, claimed, 2*time.Second)
		session := heartbeatSessionPID(t, ctx, observer, previousSession)
		close(releases[name])
		deadline := time.Now().Add(5 * time.Second)
		for {
			var state string
			err := observer.QueryRow(
				ctx,
				"SELECT state FROM workhorse.task_outcome WHERE task_id = $1::uuid",
				taskID,
			).Scan(&state)
			if err == nil {
				if state != "succeeded" {
					t.Fatalf("expected task %q to succeed, received %s", name, state)
				}
				return session
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				t.Fatal(err)
			}
			if time.Now().After(deadline) {
				t.Fatalf("worker did not settle task %q", name)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}

	before := runTask("before", 0)
	// The worker is idle now, and its reservation still holds the session that heartbeated.
	var terminated bool
	if err := observer.QueryRow(ctx, "SELECT pg_terminate_backend($1)", before).Scan(&terminated); err != nil {
		t.Fatal(err)
	}
	if !terminated {
		t.Fatalf("heartbeat session %d was not terminated", before)
	}
	time.Sleep(100 * time.Millisecond)
	select {
	case err := <-runResult:
		t.Fatalf("Run returned while idle after its heartbeat session ended: %v", err)
	default:
	}

	after := runTask("after", before)
	if after == before {
		t.Fatalf("heartbeats resumed on the terminated session %d", before)
	}
	select {
	case name := <-cancelled:
		t.Fatalf("the terminated heartbeat session cancelled task %q", name)
	default:
	}
	select {
	case err := <-runResult:
		t.Fatalf("Run returned before its context was cancelled: %v", err)
	default:
	}

	stopRun()
	select {
	case err := <-runResult:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after its context was cancelled")
	}
	// The reservation held the dead session through the idle stretch, so a round must have failed
	// on it before the fresh connection renewed.
	if !strings.Contains(logs.String(), "heartbeat round failed; retrying") {
		t.Fatalf("no heartbeat round failed on the terminated session, logged:\n%s", logs.String())
	}
}

const heldConnectionFailureHelper = "WORKHORSE_TEST_HELD_CONNECTION_FAILURE"

// A test that fails while it holds every lendable connection must still exit:
// pool.Close waits for acquired connections, so the release cleanup has to run first.
func TestAFailingTestReleasesTheConnectionsItHolds(t *testing.T) {
	testDatabaseURL(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	command := exec.CommandContext(
		ctx, os.Args[0], "-test.run", "^TestHeldConnectionFailureHelper$", "-test.count=1", "-test.v",
	)
	command.Env = append(os.Environ(), heldConnectionFailureHelper+"=1")
	output, err := command.CombinedOutput()
	if ctx.Err() != nil {
		t.Fatalf("the failing test hung with its connections held:\n%s", output)
	}
	var exitError *exec.ExitError
	if !errors.As(err, &exitError) || exitError.ExitCode() == 0 {
		t.Fatalf("the failing test did not fail: %v\n%s", err, output)
	}
	if !strings.Contains(string(output), "held-connection failure") {
		t.Fatalf("the failing test did not report its own failure:\n%s", output)
	}
}

func TestHeldConnectionFailureHelper(t *testing.T) {
	if os.Getenv(heldConnectionFailureHelper) != "1" {
		t.Skip("runs only under TestAFailingTestReleasesTheConnectionsItHolds")
	}
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-held-connection-failure")
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
	holdLendableConnections(t, ctx, pool)
	t.Fatal("held-connection failure")
}

// TestWorkerEndsATimedOutHeartbeatStatementOnTheServer pins the server bound of a heartbeat round
// (SM-1442). Closing a connection does not stop its statement, so each round that timed out used to
// leave one more backend waiting on the same lock. PostgreSQL now ends the transaction by the
// round's deadline, on the reserved connection and on a shared round alike. A row lock now makes
// the round report the lease busy at once (SM-1443), so the test holds a table lock instead.
func TestWorkerEndsATimedOutHeartbeatStatementOnTheServer(t *testing.T) {
	for _, shared := range []bool{false, true} {
		name := "reserved"
		if shared {
			name = "shared"
		}
		t.Run(name, func(t *testing.T) {
			databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-heartbeat-bound-"+name)
			ctx := context.Background()
			pool, err := pgxpool.New(ctx, databaseURL)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(pool.Close)
			observer := observeDatabase(t, ctx, databaseURL)
			blocker := observeDatabase(t, ctx, databaseURL)

			const interval = 200 * time.Millisecond
			queueName := "go-worker-heartbeat-bound-" + name
			queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
			if _, err := queue.Enqueue(ctx, "heartbeat-bound", nil); err != nil {
				t.Fatal(err)
			}
			worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
				Queue:               queueName,
				WorkerID:            "heartbeat-bound-worker-" + name,
				LeaseDuration:       30 * time.Second,
				HeartbeatInterval:   interval,
				PollInterval:        5 * time.Millisecond,
				MaintenanceInterval: time.Second,
				SharedHeartbeats:    shared,
			})
			if err != nil {
				t.Fatal(err)
			}
			started := make(chan struct{})
			release := make(chan struct{})
			worker.Handle("heartbeat-bound", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
				close(started)
				<-release
				return nil, nil
			})
			workerResult := make(chan error, 1)
			go func() {
				processed, err := worker.RunOnce(ctx)
				if err == nil && !processed {
					err = errors.New("worker did not process the heartbeat-bound task")
				}
				workerResult <- err
			}()
			select {
			case <-started:
			case <-time.After(5 * time.Second):
				close(release)
				t.Fatal("worker did not start the handler")
			}

			// Hold a table lock that conflicts with the first lock step of heartbeat_many_v2, so
			// every heartbeat round waits until its deadline.
			lockFastRuntimeTable(t, ctx, blocker)
			maxCount, maxAge, seen := 0, 0.0, false
			until := time.Now().Add(8 * interval)
			for time.Now().Before(until) {
				var count int
				var age float64
				if err := observer.QueryRow(
					ctx,
					`SELECT count(*)::int,
					        COALESCE(max(extract(epoch FROM clock_timestamp() - query_start) * 1000), 0)::float8
					   FROM pg_stat_activity
					  WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'active'
					    AND query LIKE '%workhorse.heartbeat_many_v2%'`,
				).Scan(&count, &age); err != nil {
					t.Fatal(err)
				}
				seen = seen || count > 0
				maxCount, maxAge = max(maxCount, count), max(maxAge, age)
				time.Sleep(20 * time.Millisecond)
			}
			if _, err := blocker.Exec(ctx, "COMMIT"); err != nil {
				t.Fatal(err)
			}
			close(release)
			if err := <-workerResult; err != nil {
				t.Fatal(err)
			}
			if !seen {
				t.Fatal("no heartbeat statement waited on the locked table")
			}
			if maxCount > 1 {
				t.Fatalf("%d heartbeat statements were active at once; want at most 1", maxCount)
			}
			// A statement ends by its round's deadline. The slack allows for a slow host, and stays
			// far below the 1.6 s that the lock was held.
			if limit := float64(5 * interval / time.Millisecond); maxAge >= limit {
				t.Fatalf("a heartbeat statement ran for %.0f ms; want less than %.0f ms", maxAge, limit)
			}
		})
	}
}

// lockFastRuntimeTableStatement conflicts with the ROW SHARE lock that heartbeat_many_v2 takes on
// workhorse.fast_task_runtime in its first lock step, for a task of either tier. A heartbeat thus
// waits until the blocker commits or the server timeouts end it. Unlike a row lock, which the
// heartbeat now skips, the table lock exercises the bound. It does not block a full-tier enqueue or
// claim, which a lock on workhorse.task_runtime would.
const lockFastRuntimeTableStatement = "LOCK TABLE workhorse.fast_task_runtime IN EXCLUSIVE MODE"

// lockFastRuntimeTable opens a transaction on blocker that holds lockFastRuntimeTableStatement until
// the test sends COMMIT.
func lockFastRuntimeTable(t *testing.T, ctx context.Context, blocker *pgx.Conn) {
	t.Helper()
	if _, err := blocker.Exec(ctx, "BEGIN"); err != nil {
		t.Fatal(err)
	}
	if _, err := blocker.Exec(ctx, lockFastRuntimeTableStatement); err != nil {
		t.Fatal(err)
	}
}

// TestAHeartbeatRoundReportsALockedRowAsBusy pins SM-1443: a heartbeat round skips a task row that
// another transaction holds. It reports the lease busy at once, well before the round bound, and
// leaves the lease as it was. After the holder commits, the next round renews the lease.
func TestAHeartbeatRoundReportsALockedRowAsBusy(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-heartbeat-busy")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	observer := observeDatabase(t, ctx, databaseURL)
	blocker := observeDatabase(t, ctx, databaseURL)

	const queueName = "go-worker-heartbeat-busy"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskID, err := queue.Enqueue(ctx, "heartbeat-busy", nil)
	if err != nil {
		t.Fatal(err)
	}
	// The worker's own rounds fall due long after the test ends, so only the test's rounds run.
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:               queueName,
		WorkerID:            "heartbeat-busy-worker",
		LeaseDuration:       time.Minute,
		HeartbeatInterval:   30 * time.Second,
		PollInterval:        5 * time.Millisecond,
		MaintenanceInterval: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	release, closeRelease := releaseOnce(t)
	worker.Handle("heartbeat-busy", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		close(started)
		<-release
		return nil, nil
	})
	workerResult := make(chan error, 1)
	go func() {
		processed, err := worker.RunOnce(ctx)
		if err == nil && !processed {
			err = errors.New("worker did not process the heartbeat-busy task")
		}
		workerResult <- err
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		closeRelease()
		t.Fatal("worker did not start the handler")
	}
	var fenceToken int64
	if err := observer.QueryRow(
		ctx, "SELECT fence_token FROM workhorse.task_runtime WHERE task_id = $1::uuid", taskID,
	).Scan(&fenceToken); err != nil {
		t.Fatal(err)
	}

	const bound = 5 * time.Second
	if _, err := blocker.Exec(ctx, "BEGIN"); err != nil {
		t.Fatal(err)
	}
	if _, err := blocker.Exec(
		ctx, "SELECT FROM workhorse.task_runtime WHERE task_id = $1::uuid FOR UPDATE", taskID,
	); err != nil {
		t.Fatal(err)
	}
	before := leaseExpiry(t, ctx, observer, taskID)
	sentAt := time.Now()
	status, err := worker.HeartbeatRoundForTest(taskID, fenceToken, bound)
	elapsed := time.Since(sentAt)
	if err != nil {
		t.Fatal(err)
	}
	if status != "busy" {
		t.Fatalf("a round over a locked row reported %q; want busy", status)
	}
	if elapsed >= time.Second {
		t.Fatalf("a round over a locked row took %s; want an answer well before the %s bound", elapsed, bound)
	}
	if after := leaseExpiry(t, ctx, observer, taskID); !after.Equal(before) {
		t.Fatalf("a busy round moved the lease expiry from %s to %s", before, after)
	}
	if _, err := blocker.Exec(ctx, "COMMIT"); err != nil {
		t.Fatal(err)
	}
	status, err = worker.HeartbeatRoundForTest(taskID, fenceToken, bound)
	if err != nil {
		t.Fatal(err)
	}
	if status != "accepted" {
		t.Fatalf("a round after the commit reported %q; want accepted", status)
	}
	if after := leaseExpiry(t, ctx, observer, taskID); !after.After(before) {
		t.Fatal("an accepted round did not renew the lease")
	}
	closeRelease()
	if err := <-workerResult; err != nil {
		t.Fatal(err)
	}
}

// TestAHeartbeatStatementEndsOnTheServerBeforeTheClientDeadline pins the server side of the bound
// alone. pgx also sends a cancel request when a deadline interrupts a query, but that request needs
// a second connection and can be lost. PostgreSQL ends the statement first, at one quarter of the
// time left, so the error is the server's statement timeout and not the client's deadline.
func TestAHeartbeatStatementEndsOnTheServerBeforeTheClientDeadline(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "heartbeat-server-bound")
	ctx := context.Background()
	conn := observeDatabase(t, ctx, databaseURL)
	var before string
	if err := conn.QueryRow(ctx, "SELECT current_setting('statement_timeout')").Scan(&before); err != nil {
		t.Fatal(err)
	}
	roundContext, cancel := context.WithTimeout(ctx, 400*time.Millisecond)
	defer cancel()

	started := time.Now()
	_, err := workhorse.ServerBoundedQueryForTest(roundContext, conn, "SELECT pg_sleep(5)")
	elapsed := time.Since(started)

	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "57014" {
		t.Fatalf("expected the server's statement timeout (57014), received %v", err)
	}
	if roundContext.Err() != nil {
		t.Fatalf("the client deadline passed first, after %s", elapsed)
	}
	// The transaction rolled back, so its timeout ended with it and the session is clean.
	var timeout string
	if err := conn.QueryRow(ctx, "SELECT current_setting('statement_timeout')").Scan(&timeout); err != nil {
		t.Fatal(err)
	}
	if timeout != before {
		t.Fatalf("the round's statement_timeout %s outlived its transaction", timeout)
	}
}

// TestWorkerKeepsARenewalMarginAfterOneTimedOutHeartbeatRound pins the fixed schedule: a round falls
// due one interval after the previous round started, so one timed-out round does not move the next
// round toward the end of the lease (SM-1444). The lease is 2.3 intervals, shorter than the default
// of 3. The table lock makes the first round end on the server at about 1.4 intervals. The fixed
// schedule sends the next round at 2 intervals, inside the lease. A schedule that waits one interval
// after the failed round ends sends it at about 2.4 intervals, after the lease.
//
// The lease starts when the claim leaves, so the claim, the start of the handler, and the second
// round must end in 0.3 intervals. The delays of a loaded host are absolute, so the interval is
// 4 s, which gives them 1.2 s. A trace of the TypeScript test ran at a 1-minute load of 46 on 32
// cores. The delay from the claim to the handler was up to 654 ms, and the second round took up to
// 221 ms (SM-1479).
func TestWorkerKeepsARenewalMarginAfterOneTimedOutHeartbeatRound(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-heartbeat-margin")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	observer := observeDatabase(t, ctx, databaseURL)
	blocker := observeDatabase(t, ctx, databaseURL)

	const interval = 4 * time.Second
	const queueName = "go-worker-heartbeat-margin"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskID, err := queue.Enqueue(ctx, "heartbeat-margin", nil)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:               queueName,
		WorkerID:            "heartbeat-margin-worker",
		LeaseDuration:       9200 * time.Millisecond,
		HeartbeatInterval:   interval,
		PollInterval:        5 * time.Millisecond,
		MaintenanceInterval: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	var blockerPID int32
	if err := blocker.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&blockerPID); err != nil {
		t.Fatal(err)
	}
	// reached reports whether a heartbeat statement waits on the lock of blocker (waits true) or no
	// statement waits on it (waits false). An answer that arrives after deadline does not count.
	reached := func(waits bool, deadline time.Time) (bool, error) {
		for {
			var count int
			if err := observer.QueryRow(
				ctx,
				"SELECT count(*) FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid)) "+
					"AND query LIKE '%heartbeat_many%'",
				blockerPID,
			).Scan(&count); err != nil {
				return false, err
			}
			if time.Now().After(deadline) {
				return false, nil
			}
			if (count > 0) == waits {
				return true, nil
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	handlerErr := make(chan error, 1)
	worker.Handle("heartbeat-margin", func(handlerContext context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		started := time.Now()
		handlerErr <- func() error {
			if _, err := blocker.Exec(ctx, "BEGIN"); err != nil {
				return err
			}
			if _, err := blocker.Exec(ctx, lockFastRuntimeTableStatement); err != nil {
				return err
			}
			// The first round falls due one interval after the lease registered, just before the
			// handler started. A lock that comes later than half an interval can miss that round.
			if held := time.Since(started); held > interval/2 {
				_, _ = blocker.Exec(ctx, "ROLLBACK")
				return errors.New("precondition not met: the table lock came " + held.String() + " after the handler started")
			}
			// Hold the lock until the first round waits on it and then stops. While the lock is held,
			// the statement stops only when its round times out. Then release the lock before the
			// second round.
			waited, err := reached(true, started.Add(interval*3/2))
			if err != nil {
				return err
			}
			if !waited {
				_, _ = blocker.Exec(ctx, "ROLLBACK")
				return errors.New("precondition not met: the first round did not wait on the table lock")
			}
			timedOut, err := reached(false, started.Add(interval*19/10))
			if err != nil {
				return err
			}
			if !timedOut {
				_, _ = blocker.Exec(ctx, "ROLLBACK")
				return errors.New("precondition not met: the first round did not time out")
			}
			if _, err := blocker.Exec(ctx, "COMMIT"); err != nil {
				return err
			}
			if released := time.Since(started); released > interval*19/10 {
				return errors.New("precondition not met: the table lock ended " + released.String() + " after the handler started")
			}
			// Run past the end of the lease from the claim, so only a renewal keeps the task.
			time.Sleep(time.Until(started.Add(interval * 26 / 10)))
			return handlerContext.Err()
		}()
		return nil, nil
	})
	processed, err := worker.RunOnce(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !processed {
		t.Fatal("worker did not process the heartbeat-margin task")
	}
	if err := <-handlerErr; err != nil {
		if strings.HasPrefix(err.Error(), "precondition not met") {
			t.Fatal(err)
		}
		t.Fatalf("the handler lost its lease: %v", err)
	}
	var state string
	if err := observer.QueryRow(
		ctx, "SELECT state FROM workhorse.task_outcome WHERE task_id = $1::uuid", taskID,
	).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "succeeded" {
		t.Fatalf("task state %q; want succeeded", state)
	}
}

// TestAFailedHeartbeatRoundAcquiresItsReplacementBeforeTheNextRound pins SM-1444: rounds start on
// a fixed schedule, so the next round can start soon after a failed one. The failed round acquires
// the replacement as it ends, so the checkout starts before the next round.
func TestAFailedHeartbeatRoundAcquiresItsReplacementBeforeTheNextRound(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "heartbeat-replacement")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	connection := workhorse.NewHeartbeatConnectionForTest(pool)
	t.Cleanup(connection.Release)

	if err := connection.FailRound(ctx, time.Second); err == nil {
		t.Fatal("the failing round reported no error")
	}
	until := time.Now().Add(5 * time.Second)
	for !connection.Held() {
		if time.Now().After(until) {
			t.Fatal("the failed round acquired no replacement connection")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// roundStatement is one statement that a round sent, and the backend that ran it.
type roundStatement struct {
	pid uint32
	sql string
}

// roundStatementTracer is a pgx tracer that keeps each statement a round sends. Before it sends the
// settings statement it waits for settingsDelay, so the round finds that the statement used more
// than its quarter. The wait comes before the round's idle timeout applies, so PostgreSQL keeps the
// session. A wait after the settings statement would pass that timeout and end the session.
type roundStatementTracer struct {
	mu            sync.Mutex
	statements    []roundStatement
	settingsDelay time.Duration
}

func (tracer *roundStatementTracer) TraceQueryStart(
	ctx context.Context,
	conn *pgx.Conn,
	data pgx.TraceQueryStartData,
) context.Context {
	tracer.mu.Lock()
	tracer.statements = append(tracer.statements, roundStatement{pid: conn.PgConn().PID(), sql: data.SQL})
	delay := tracer.settingsDelay
	tracer.mu.Unlock()
	if strings.Contains(data.SQL, "set_config('statement_timeout'") {
		time.Sleep(delay)
	}
	return ctx
}

func (*roundStatementTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

// take returns the statements so far, forgets them, and sets the wait after the next settings
// statements.
func (tracer *roundStatementTracer) take(settingsDelay time.Duration) []roundStatement {
	tracer.mu.Lock()
	defer tracer.mu.Unlock()
	statements := tracer.statements
	tracer.statements = nil
	tracer.settingsDelay = settingsDelay
	return statements
}

func newRoundStatementPool(t *testing.T, name string) (*pgxpool.Pool, *roundStatementTracer) {
	t.Helper()
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), name)
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	tracer := &roundStatementTracer{}
	config.ConnConfig.Tracer = tracer
	// One connection, so a round that discards its connection gets a new backend.
	config.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool, tracer
}

// roundBackend returns the one backend that ran statements.
func roundBackend(t *testing.T, statements []roundStatement) uint32 {
	t.Helper()
	if len(statements) == 0 {
		t.Fatal("the round sent no statement")
	}
	for _, statement := range statements {
		if statement.pid != statements[0].pid {
			t.Fatalf("the round ran on backends %d and %d; want one", statements[0].pid, statement.pid)
		}
	}
	return statements[0].pid
}

// assertCleanExpiry checks that a round expired after BEGIN, sent no heartbeat statement, and
// rolled back.
func assertCleanExpiry(t *testing.T, statements []roundStatement, heartbeat string) {
	t.Helper()
	var sent []string
	for _, statement := range statements {
		sent = append(sent, strings.ToLower(statement.sql))
	}
	for _, sql := range sent {
		if strings.Contains(sql, heartbeat) {
			t.Fatalf("the expired round sent its heartbeat statement: %v", sent)
		}
	}
	if len(sent) == 0 || sent[0] != "begin" || sent[len(sent)-1] != "rollback" {
		t.Fatalf("the expired round sent %v; want BEGIN first and ROLLBACK last", sent)
	}
}

// TestARoundThatExpiresBeforeItsHeartbeatKeepsTheReservedConnection pins SM-1492: the round sent
// no heartbeat statement, so its ROLLBACK leaves the connection clean, and the next round uses it.
// Handlers cannot take that connection, so keeping it keeps renewals going (ADR 0071).
func TestARoundThatExpiresBeforeItsHeartbeatKeepsTheReservedConnection(t *testing.T) {
	pool, tracer := newRoundStatementPool(t, "heartbeat-clean-expiry")
	ctx := context.Background()
	connection := workhorse.NewHeartbeatConnectionForTest(pool)
	t.Cleanup(connection.Release)

	if err := connection.QueryRound(ctx, 2*time.Second, "SELECT 'first round'"); err != nil {
		t.Fatal(err)
	}
	backend := roundBackend(t, tracer.take(300*time.Millisecond))

	// The settings statement and the wait after it take more than a quarter of the 800 ms bound.
	err := connection.QueryRound(ctx, 800*time.Millisecond, "SELECT 'expired round'")
	if err == nil || !workhorse.RoundKeptItsConnectionForTest(err) {
		t.Fatalf("the round that expired after BEGIN returned %v; want a clean expiry", err)
	}
	statements := tracer.take(0)
	assertCleanExpiry(t, statements, "expired round")
	if pid := roundBackend(t, statements); pid != backend {
		t.Fatalf("the expired round ran on backend %d; want %d", pid, backend)
	}
	if !connection.Held() {
		t.Fatal("the expired round gave up the reserved connection")
	}

	// Too little time is left before BEGIN, so the round sends nothing.
	err = connection.QueryRound(ctx, 5*time.Millisecond, "SELECT 'short round'")
	if err == nil || !workhorse.RoundKeptItsConnectionForTest(err) {
		t.Fatalf("the round without time for BEGIN returned %v; want a clean expiry", err)
	}
	if statements := tracer.take(0); len(statements) != 0 {
		t.Fatalf("the round without time for BEGIN sent %v", statements)
	}
	if !connection.Held() {
		t.Fatal("the round without time for BEGIN gave up the reserved connection")
	}

	if err := connection.QueryRound(ctx, 2*time.Second, "SELECT 'next round'"); err != nil {
		t.Fatal(err)
	}
	if pid := roundBackend(t, tracer.take(0)); pid != backend {
		t.Fatalf("the next round ran on backend %d; want the kept backend %d", pid, backend)
	}
}

// TestARoundOnThePoolThatExpiresBeforeItsHeartbeatReturnsItsConnectionOpen pins SM-1492 for
// SharedHeartbeats: the round returns the clean connection to the pool without closing it.
func TestARoundOnThePoolThatExpiresBeforeItsHeartbeatReturnsItsConnectionOpen(t *testing.T) {
	pool, tracer := newRoundStatementPool(t, "heartbeat-pool-clean-expiry")
	ctx := context.Background()

	if err := workhorse.BoundedPoolQueryForTest(ctx, pool, 2*time.Second, "SELECT 'first round'"); err != nil {
		t.Fatal(err)
	}
	backend := roundBackend(t, tracer.take(300*time.Millisecond))

	err := workhorse.BoundedPoolQueryForTest(ctx, pool, 800*time.Millisecond, "SELECT 'expired round'")
	if err == nil || !workhorse.RoundKeptItsConnectionForTest(err) {
		t.Fatalf("the round that expired after BEGIN returned %v; want a clean expiry", err)
	}
	statements := tracer.take(0)
	assertCleanExpiry(t, statements, "expired round")
	if pid := roundBackend(t, statements); pid != backend {
		t.Fatalf("the expired round ran on backend %d; want %d", pid, backend)
	}

	if err := workhorse.BoundedPoolQueryForTest(ctx, pool, 2*time.Second, "SELECT 'next round'"); err != nil {
		t.Fatal(err)
	}
	if pid := roundBackend(t, tracer.take(0)); pid != backend {
		t.Fatalf("the next round ran on backend %d; want the kept backend %d", pid, backend)
	}
}

// TestAHeartbeatRoundAnswersEachLeaseItSent pins SM-1494 and SM-1495. A round can name one task
// twice, when an old attempt has not unregistered yet, and it can hold more than the 100 leases
// that one heartbeat_many_v2 call accepts. Each lease gets the status of its own row, and the round
// splits its leases into batches of at most 100 in one heartbeat_pool_v1 statement (SM-1633).
func TestAHeartbeatRoundAnswersEachLeaseItSent(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-heartbeat-ordinal")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	observer := observeDatabase(t, ctx, databaseURL)

	const queueName = "go-worker-heartbeat-ordinal"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskID, err := queue.Enqueue(ctx, "heartbeat-ordinal", nil)
	if err != nil {
		t.Fatal(err)
	}
	// The worker's own rounds fall due long after the test ends, so only the test's rounds run.
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:               queueName,
		WorkerID:            "heartbeat-ordinal-worker",
		LeaseDuration:       time.Minute,
		HeartbeatInterval:   30 * time.Second,
		PollInterval:        5 * time.Millisecond,
		MaintenanceInterval: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	release, closeRelease := releaseOnce(t)
	worker.Handle("heartbeat-ordinal", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		close(started)
		<-release
		return nil, nil
	})
	workerResult := make(chan error, 1)
	go func() {
		processed, err := worker.RunOnce(ctx)
		if err == nil && !processed {
			err = errors.New("worker did not process the heartbeat-ordinal task")
		}
		workerResult <- err
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		closeRelease()
		t.Fatal("worker did not start the handler")
	}
	var fenceToken int64
	if err := observer.QueryRow(
		ctx, "SELECT fence_token FROM workhorse.task_runtime WHERE task_id = $1::uuid", taskID,
	).Scan(&fenceToken); err != nil {
		t.Fatal(err)
	}
	// An older fence of the task comes first and the current fence second. 150 leases of tasks
	// that do not exist follow, so the round needs two batches.
	leases := []workhorse.HeartbeatLeaseForTest{
		{TaskID: taskID, FenceToken: fenceToken - 1},
		{TaskID: taskID, FenceToken: fenceToken},
	}
	var unknown []string
	if err := observer.QueryRow(
		ctx, "SELECT array_agg(gen_random_uuid()::text) FROM generate_series(1, 150)",
	).Scan(&unknown); err != nil {
		t.Fatal(err)
	}
	for _, id := range unknown {
		leases = append(leases, workhorse.HeartbeatLeaseForTest{TaskID: id, FenceToken: 1})
	}
	before := leaseExpiry(t, ctx, observer, taskID)
	statuses, err := worker.HeartbeatRoundManyForTest(leases, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if len(statuses) != len(leases) {
		t.Fatalf("a round of %d leases returned %d statuses", len(leases), len(statuses))
	}
	if statuses[0] != "stale" || statuses[1] != "accepted" {
		t.Fatalf("the old and current fences reported %q and %q; want stale and accepted", statuses[0], statuses[1])
	}
	for index, status := range statuses[2:] {
		if status != "stale" {
			t.Fatalf("the lease of unknown task %d reported %q; want stale", index, status)
		}
	}
	if after := leaseExpiry(t, ctx, observer, taskID); !after.After(before) {
		t.Fatal("the accepted lease was not renewed")
	}
	closeRelease()
	if err := <-workerResult; err != nil {
		t.Fatal(err)
	}
}
