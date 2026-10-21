package workhorse_test

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	workhorse "github.com/stablemates/workhorse/go"
)

// These tests check that the heartbeat connection of a pool has one owner at a time (SM-1579). A
// holder that arrives after the last holder released waits until the released connection has left
// the pool, so a released connection never overlaps the next one (ADR 0071, rule 7).

func heartbeatSettlePool(t *testing.T, name string) *pgxpool.Pool {
	t.Helper()
	pool := heartbeatSettlePoolWith(t, name, nil)
	// Two idle connections let a second heartbeat connection arrive at once, without a connect.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	first, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	second, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	first.Release()
	second.Release()
	return pool
}

// heartbeatSettlePoolWith opens a pool of 4 connections on a scratch database, with configure
// applied to its config. It opens no connection in advance.
func heartbeatSettlePoolWith(t *testing.T, name string, configure func(*pgxpool.Config)) *pgxpool.Pool {
	t.Helper()
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), name)
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = 4
	if configure != nil {
		configure(config)
	}
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// releasedRound is a heartbeat connection whose last holder released while one of its rounds still
// used the connection.
type releasedRound struct {
	hold   workhorse.HeartbeatHoldForTest
	finish func()
	done   chan error
}

// releaseDuringRound reserves the heartbeat connection of pool, starts a round that runs until
// finish, and releases the last hold while that round runs.
func releaseDuringRound(ctx context.Context, t *testing.T, pool *pgxpool.Pool) releasedRound {
	t.Helper()
	hold := workhorse.HoldHeartbeatConnectionForTest(pool)
	if err := hold.Reserve(ctx); err != nil {
		t.Fatal(err)
	}
	entered := make(chan struct{})
	finish := make(chan struct{})
	var finishOnce sync.Once
	released := releasedRound{
		hold:   hold,
		finish: func() { finishOnce.Do(func() { close(finish) }) },
		done:   make(chan error, 1),
	}
	// A failed check still ends the round, so the pool can close.
	t.Cleanup(released.finish)
	go func() {
		released.done <- hold.RunRound(ctx, 5*time.Second, func() {
			close(entered)
			<-finish
		})
	}()
	<-entered
	hold.Release()
	return released
}

// Worker A's round holds the heartbeat connection when A releases its last hold. Worker B starts on
// the same pool. B must not take a second heartbeat connection while A's round holds the first one,
// and it must reserve once that round returns the connection.
func TestANewHeartbeatHolderWaitsForTheReleasedRoundToReturnItsConnection(t *testing.T) {
	pool := heartbeatSettlePool(t, "heartbeat-settle-round")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	first := releaseDuringRound(ctx, t, pool)

	second := workhorse.HoldHeartbeatConnectionForTest(pool)
	defer second.Release()
	// The startup budget ends the wait while the released round still holds its connection.
	budget, endBudget := context.WithTimeout(ctx, 500*time.Millisecond)
	err := second.Reserve(budget)
	endBudget()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf(
			"the new holder reserved with %v while the released round held its connection; the pool lends %d",
			err, pool.Stat().AcquiredConns(),
		)
	}
	if !strings.Contains(err.Error(), "has not returned to the pool") {
		t.Fatalf("the failed reservation does not name the released connection: %v", err)
	}

	first.finish()
	if err := <-first.done; err != nil {
		t.Fatal(err)
	}
	if err := second.Reserve(ctx); err != nil {
		t.Fatal(err)
	}
	if lent := pool.Stat().AcquiredConns(); lent != 1 {
		t.Fatalf("the pool lends %d connections, want the one heartbeat connection", lent)
	}
}

// Startups that end in their budget while a released round runs leave nothing that waits for that
// round. The next holder waits for the released connection itself (ADR 0071, rule 7).
func TestStartupsThatEndWhileAReleasedRoundRunsLeaveNoWaiter(t *testing.T) {
	pool := heartbeatSettlePool(t, "heartbeat-settle-retries")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	first := releaseDuringRound(ctx, t, pool)
	for range 3 {
		retry := workhorse.HoldHeartbeatConnectionForTest(pool)
		budget, endBudget := context.WithTimeout(ctx, 50*time.Millisecond)
		err := retry.Reserve(budget)
		endBudget()
		retry.Release()
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("a startup reserved with %v while the released round held its connection", err)
		}
		if !workhorse.NextHeartbeatConnectionWaitsForTest(pool, first.hold) {
			t.Fatal("the next holder waits for a startup that ended, not for the released connection")
		}
	}

	first.finish()
	if err := <-first.done; err != nil {
		t.Fatal(err)
	}
	next := workhorse.HoldHeartbeatConnectionForTest(pool)
	defer next.Release()
	if err := next.Reserve(ctx); err != nil {
		t.Fatal(err)
	}
}

// Worker A's acquisition is in flight when A releases its last hold, and its connection arrives
// later. Worker B must not take a heartbeat connection until A's loop has returned that late
// connection to the pool.
func TestANewHeartbeatHolderWaitsForALateConnectionOfTheReleasedHolder(t *testing.T) {
	pool := heartbeatSettlePool(t, "heartbeat-settle-late")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	entered := make(chan struct{})
	deliver := make(chan struct{})
	var deliverOnce sync.Once
	deliverLate := func() { deliverOnce.Do(func() { close(deliver) }) }
	// A failed check still lets the late connection return, so the pool can close.
	t.Cleanup(deliverLate)
	// The connect finishes after the holder stopped waiting, as a slow connect does.
	first := workhorse.HoldHeartbeatConnectionAcquiringForTest(pool, func(context.Context) (*pgxpool.Conn, error) {
		close(entered)
		<-deliver
		return pool.Acquire(context.Background())
	})
	<-entered
	first.Release()

	second := workhorse.HoldHeartbeatConnectionForTest(pool)
	defer second.Release()
	budget, endBudget := context.WithTimeout(ctx, 500*time.Millisecond)
	err := second.Reserve(budget)
	endBudget()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("the new holder reserved with %v while the released holder's acquisition ran", err)
	}

	deliverLate()
	if err := second.Reserve(ctx); err != nil {
		t.Fatal(err)
	}
	if lent := pool.Stat().AcquiredConns(); lent != 1 {
		t.Fatalf("the pool lends %d connections, want the one heartbeat connection", lent)
	}
}

// pgxpool runs an AfterRelease hook on a goroutine and returns before the hook gives the
// connection back. Worker A releases its last hold while that hook blocks. Worker B must reserve
// only after the pool no longer counts A's connection.
func TestANewHeartbeatHolderWaitsUntilThePoolNoLongerCountsTheReleasedConnection(t *testing.T) {
	var blockReleases atomic.Bool
	unblock := make(chan struct{})
	pool := heartbeatSettlePoolWith(t, "heartbeat-settle-after-release", func(config *pgxpool.Config) {
		config.AfterRelease = func(*pgx.Conn) bool {
			if blockReleases.Load() {
				<-unblock
			}
			return true
		}
	})
	var unblockOnce sync.Once
	// A failed check still lets a blocked hook end, so the pool can close.
	t.Cleanup(func() { unblockOnce.Do(func() { close(unblock) }) })
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	first := workhorse.HoldHeartbeatConnectionForTest(pool)
	if err := first.Reserve(ctx); err != nil {
		t.Fatal(err)
	}
	blockReleases.Store(true)
	first.Release()

	second := workhorse.HoldHeartbeatConnectionForTest(pool)
	defer second.Release()
	if err := second.Reserve(ctx); err != nil {
		t.Fatal(err)
	}
	if lent := pool.Stat().AcquiredConns(); lent != 1 {
		t.Fatalf("the pool counts %d acquired connections after the new holder reserved, want 1", lent)
	}
}

// A round fails and discards the heartbeat connection, and the close of that connection blocks. The
// replacement connection must renew at once: the round slot cannot wait for the close. The released
// connection still settles only after the close ends.
func TestAReplacementHeartbeatConnectionRenewsWhileTheDiscardedOneCloses(t *testing.T) {
	var blockClose atomic.Bool
	closing := make(chan struct{})
	unblock := make(chan struct{})
	pool := heartbeatSettlePoolWith(t, "heartbeat-settle-discard-close", func(config *pgxpool.Config) {
		config.BeforeClose = func(*pgx.Conn) {
			if blockClose.CompareAndSwap(true, false) {
				close(closing)
				<-unblock
			}
		}
	})
	var unblockOnce sync.Once
	unblockClose := func() { unblockOnce.Do(func() { close(unblock) }) }
	// A failed check still lets the blocked close end, so the pool can close.
	t.Cleanup(unblockClose)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	hold := workhorse.HoldHeartbeatConnectionForTest(pool)
	released := false
	defer func() {
		if !released {
			hold.Release()
		}
	}()
	if err := hold.Reserve(ctx); err != nil {
		t.Fatal(err)
	}
	discarded, err := hold.BackendRound(ctx, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}

	blockClose.Store(true)
	failed := make(chan error, 1)
	go func() { failed <- hold.FailRound(ctx, 2*time.Second) }()
	// The discard closes the connection on its own goroutine, so the failing round can return
	// before the close starts. A round that returns another error never ran, and nothing closes.
	var roundErr error
	roundEnded := failed
	for waiting := true; waiting; {
		select {
		case <-closing:
			waiting = false
		case roundErr = <-roundEnded:
			roundEnded = nil
			if roundErr == nil || roundErr.Error() != "the heartbeat failed" {
				t.Fatalf("the failing round returned %v without discarding its connection", roundErr)
			}
		case <-ctx.Done():
			t.Fatalf("the discarded connection did not start to close: %v", ctx.Err())
		}
	}
	// The close of the discarded connection is blocked from here until unblockClose.
	replacement, err := hold.BackendRound(ctx, 2*time.Second)
	if err != nil {
		t.Fatalf("the replacement round failed while the discarded connection closed: %v", err)
	}
	if replacement == discarded {
		t.Fatalf("the replacement round ran on the discarded backend %v", discarded)
	}
	if roundEnded != nil {
		roundErr = <-roundEnded
	}
	if roundErr == nil || roundErr.Error() != "the heartbeat failed" {
		t.Fatalf("the failing round returned %v, want its own error", roundErr)
	}

	// The released connection settles only after the blocked close ends.
	hold.Release()
	released = true
	next := workhorse.HoldHeartbeatConnectionForTest(pool)
	defer next.Release()
	budget, endBudget := context.WithTimeout(ctx, 300*time.Millisecond)
	err = next.Reserve(budget)
	endBudget()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("the next holder reserved with %v while the discarded connection closed", err)
	}
	unblockClose()
	if err := next.Reserve(ctx); err != nil {
		t.Fatal(err)
	}
	if lent := pool.Stat().AcquiredConns(); lent != 1 {
		t.Fatalf("the pool counts %d acquired connections, want the one heartbeat connection", lent)
	}
}

// stopWaitSignal is a log handler that reports the warning the stop path logs when the grace ends
// while claims are still in flight.
type stopWaitSignal struct {
	once   sync.Once
	claims chan int64
}

func (signal *stopWaitSignal) Enabled(context.Context, slog.Level) bool { return true }

func (signal *stopWaitSignal) Handle(_ context.Context, record slog.Record) error {
	if !strings.HasPrefix(record.Message, "claims are still in flight at the end of the shutdown grace") {
		return nil
	}
	claims := int64(-1)
	record.Attrs(func(attribute slog.Attr) bool {
		if attribute.Key == "claims" {
			claims = attribute.Value.Int64()
		}
		return true
	})
	signal.once.Do(func() { signal.claims <- claims })
	return nil
}

func (signal *stopWaitSignal) WithAttrs([]slog.Attr) slog.Handler { return signal }

func (signal *stopWaitSignal) WithGroup(string) slog.Handler { return signal }

// A claim is inside its SQL, after the worker read its claim gate, when the worker stops. The grace
// ends before the SQL settles. The worker must keep its heartbeat reservation until the claim
// settles, so no claim outcome arrives after the reservation is gone.
func TestAStopKeepsTheHeartbeatReservationUntilAClaimInItsSQLSettles(t *testing.T) {
	pool := heartbeatSettlePool(t, "heartbeat-settle-stop-claim")
	signal := &stopWaitSignal{claims: make(chan int64, 1)}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:               "go-stop-claim",
		WorkerID:            "stop-claim-worker",
		Concurrency:         1,
		ShutdownGracePeriod: 50 * time.Millisecond,
		Logger:              slog.New(signal),
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("stop-claim", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return nil, nil
	})
	inSQL := make(chan struct{})
	settle := make(chan struct{})
	var settleOnce sync.Once
	settleSQL := func() { settleOnce.Do(func() { close(settle) }) }
	t.Cleanup(settleSQL)
	var first sync.Once
	worker.HoldClaimStatementsForTest(func(context.Context) {
		held := false
		first.Do(func() { held = true })
		if !held {
			return
		}
		close(inSQL)
		<-settle
	})
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	stopped := make(chan error, 1)
	go func() { stopped <- worker.Run(ctx) }()
	select {
	case <-inSQL:
	case err := <-stopped:
		t.Fatalf("Run returned before its first claim: %v", err)
	}

	stop()
	// The stop path reports the claim at the end of the grace, then waits for it again.
	select {
	case claims := <-signal.claims:
		if claims != 1 {
			t.Fatalf("the stop path waited for %d claims at the end of the grace, want 1", claims)
		}
	case err := <-stopped:
		t.Fatalf("Run returned with %v while a claim was inside its SQL", err)
	}
	if !worker.HeartbeatConnectionHeldForTest() {
		t.Fatal("the worker released its heartbeat reservation while a claim was inside its SQL")
	}
	settleSQL()
	select {
	case <-stopped:
	case <-time.After(10 * time.Second):
		t.Fatal("Run did not return after the claim settled")
	}
	if worker.HeartbeatConnectionHeldForTest() {
		t.Fatal("the worker kept its heartbeat reservation after Run returned")
	}
}
