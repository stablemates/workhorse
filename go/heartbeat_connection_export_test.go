package workhorse

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ServerBoundedQueryForTest exposes the transaction that bounds a heartbeat statement on the
// server to the external test that checks PostgreSQL ends it.
func ServerBoundedQueryForTest(ctx context.Context, conn *pgx.Conn, statement string) ([]Row, error) {
	return serverBoundedExecutor{conn: conn}.Query(ctx, statement)
}

// HeartbeatConnectionForTest exposes one reserved heartbeat connection to the external test that
// checks a failed round acquires its replacement.
type HeartbeatConnectionForTest struct{ connection *heartbeatConnection }

// NewHeartbeatConnectionForTest reserves nothing until the first round. Its acquisition loop waits
// at most one second between two failed attempts.
func NewHeartbeatConnectionForTest(pool *pgxpool.Pool) HeartbeatConnectionForTest {
	return HeartbeatConnectionForTest{connection: newHeartbeatConnection(pool, time.Second, nil)}
}

// FailRound runs one round whose statement fails, so the round discards its connection.
func (test HeartbeatConnectionForTest) FailRound(ctx context.Context, bound time.Duration) error {
	return test.connection.run(ctx, bound, func(context.Context, Executor) error {
		return errors.New("the heartbeat failed")
	})
}

// QueryRound runs one round that sends statement through the bounded executor on the reserved
// connection.
func (test HeartbeatConnectionForTest) QueryRound(ctx context.Context, bound time.Duration, statement string) error {
	return test.connection.run(ctx, bound, func(roundContext context.Context, executor Executor) error {
		_, err := executor.Query(roundContext, statement)
		return err
	})
}

// RoundKeptItsConnectionForTest reports whether a failed round left its connection clean, so the
// round kept it.
func RoundKeptItsConnectionForTest(err error) bool { return keepsConnection(err) }

// Held reports whether a connection waits for the next round.
func (test HeartbeatConnectionForTest) Held() bool {
	test.connection.mu.Lock()
	defer test.connection.mu.Unlock()
	return test.connection.conn != nil
}

// Release stops reserving.
func (test HeartbeatConnectionForTest) Release() { test.connection.release() }

// HeartbeatRoundForTest sends one heartbeat round for one lease on the path the worker's own
// rounds take, bounded by bound, and returns the status of the lease.
func (worker *Worker) HeartbeatRoundForTest(taskID string, fenceToken int64, bound time.Duration) (string, error) {
	member := &heartbeatMember{ctx: context.Background(), task: ClaimedTask{ID: taskID, FenceToken: fenceToken}}
	statuses, err := worker.queryHeartbeatRound([]*heartbeatMember{member}, time.Now().Add(bound))
	if err != nil {
		return emptyString, err
	}
	return string(statuses[0]), nil
}

// HeartbeatLeaseForTest names one lease that HeartbeatRoundManyForTest sends.
type HeartbeatLeaseForTest struct {
	TaskID     string
	FenceToken int64
}

// HeartbeatRoundManyForTest sends one heartbeat round for leases on the path the worker's own
// rounds take, bounded by bound, and returns the status of each lease in the order of leases.
func (worker *Worker) HeartbeatRoundManyForTest(leases []HeartbeatLeaseForTest, bound time.Duration) ([]string, error) {
	members := make([]*heartbeatMember, 0, len(leases))
	for _, lease := range leases {
		members = append(members, &heartbeatMember{
			ctx: context.Background(), task: ClaimedTask{ID: lease.TaskID, FenceToken: lease.FenceToken},
		})
	}
	statuses, err := worker.queryHeartbeatRound(members, time.Now().Add(bound))
	if err != nil {
		return nil, err
	}
	result := make([]string, 0, len(statuses))
	for _, status := range statuses {
		result = append(result, string(status))
	}
	return result, nil
}

// HeartbeatConnectionHeldForTest reports whether the worker's pool holds its heartbeat connection now.
func (worker *Worker) HeartbeatConnectionHeldForTest() bool {
	worker.heartbeatMu.Lock()
	lease := worker.heartbeatLease
	worker.heartbeatMu.Unlock()
	if lease == nil {
		return false
	}
	lease.connection.mu.Lock()
	defer lease.connection.mu.Unlock()
	return lease.connection.conn != nil
}

// TakeHeartbeatConnectionForTest takes the heartbeat connection from the worker, as a lost
// connection does, and gives it to the test, which must release it. The worker then acquires a
// replacement, as after a failed round.
func (worker *Worker) TakeHeartbeatConnectionForTest() *pgxpool.Conn {
	worker.heartbeatMu.Lock()
	connection := worker.heartbeatLease.connection
	worker.heartbeatMu.Unlock()
	connection.mu.Lock()
	defer connection.mu.Unlock()
	held := connection.conn
	connection.conn = nil
	connection.held = make(chan struct{})
	connection.startAcquiringLocked()
	return held
}

// HeartbeatHoldForTest is one holder's share of the heartbeat connection of a pool, for the
// external tests that check how a released connection settles.
type HeartbeatHoldForTest struct{ lease *heartbeatConnectionLease }

// HoldHeartbeatConnectionForTest takes a share of the heartbeat connection of pool, as a worker does
// when it starts.
func HoldHeartbeatConnectionForTest(pool *pgxpool.Pool) HeartbeatHoldForTest {
	return HeartbeatHoldForTest{lease: holdHeartbeatConnection(pool, time.Second)}
}

// Reserve waits until the shared connection is held or ctx ends.
func (hold HeartbeatHoldForTest) Reserve(ctx context.Context) error { return hold.lease.reserve(ctx) }

// Release drops this share, as a worker does when it stops.
func (hold HeartbeatHoldForTest) Release() { hold.lease.release() }

// RunRound runs one round on the shared connection that calls round, bounded by bound.
func (hold HeartbeatHoldForTest) RunRound(ctx context.Context, bound time.Duration, round func()) error {
	return hold.lease.run(ctx, bound, func(context.Context, Executor) error {
		round()
		return nil
	})
}

// FailRound runs one round on the shared connection whose statement fails, so the round discards
// the connection.
func (hold HeartbeatHoldForTest) FailRound(ctx context.Context, bound time.Duration) error {
	return hold.lease.run(ctx, bound, func(context.Context, Executor) error {
		return errors.New("the heartbeat failed")
	})
}

// BackendRound runs one round on the shared connection that reads its backend process ID through the
// bounded executor, as a heartbeat statement does.
func (hold HeartbeatHoldForTest) BackendRound(ctx context.Context, bound time.Duration) (any, error) {
	var backend any
	err := hold.lease.run(ctx, bound, func(roundContext context.Context, executor Executor) error {
		rows, err := executor.Query(roundContext, "SELECT pg_backend_pid() AS backend")
		if err != nil {
			return err
		}
		if len(rows) != 1 {
			return fmt.Errorf("the round read %d rows", len(rows))
		}
		backend = rows[0]["backend"]
		return nil
	})
	return backend, err
}

// HoldHeartbeatConnectionAcquiringForTest takes a share of the heartbeat connection of pool and
// starts its acquisition loop, which asks acquire instead of the pool.
func HoldHeartbeatConnectionAcquiringForTest(
	pool *pgxpool.Pool,
	acquire func(context.Context) (*pgxpool.Conn, error),
) HeartbeatHoldForTest {
	hold := HoldHeartbeatConnectionForTest(pool)
	connection := hold.lease.connection
	connection.mu.Lock()
	defer connection.mu.Unlock()
	connection.acquire = acquire
	connection.startAcquiringLocked()
	return hold
}

// NextHeartbeatConnectionWaitsForTest reports whether the next heartbeat connection on pool waits
// for the connection that hold shares.
func NextHeartbeatConnectionWaitsForTest(pool *pgxpool.Pool, hold HeartbeatHoldForTest) bool {
	heldHeartbeatConnections.mu.Lock()
	defer heldHeartbeatConnections.mu.Unlock()
	return heldHeartbeatConnections.settling[pool] == (<-chan struct{})(hold.lease.connection.settled)
}

// HoldClaimStatementsForTest makes each claim statement of the worker call inSQL after the worker
// read its claim gate, before PostgreSQL receives the statement. The statement starts when inSQL
// returns, unless its context has ended.
func (worker *Worker) HoldClaimStatementsForTest(inSQL func(ctx context.Context)) {
	worker.claimConnection = func(ctx context.Context, executor Executor) (Executor, func(), error) {
		held, release, err := holdClaimConnection(ctx, executor)
		if err != nil {
			return nil, nil, err
		}
		return heldClaimExecutor{executor: held, inSQL: inSQL}, release, nil
	}
}

type heldClaimExecutor struct {
	executor Executor
	inSQL    func(ctx context.Context)
}

func (executor heldClaimExecutor) Query(ctx context.Context, statement string, arguments ...any) ([]Row, error) {
	executor.inSQL(ctx)
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return executor.executor.Query(ctx, statement, arguments...)
}
