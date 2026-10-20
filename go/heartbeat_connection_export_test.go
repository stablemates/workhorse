package workhorse

import (
	"context"
	"errors"
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

// NewHeartbeatConnectionForTest reserves nothing until the first round.
func NewHeartbeatConnectionForTest(pool *pgxpool.Pool) HeartbeatConnectionForTest {
	return HeartbeatConnectionForTest{connection: newHeartbeatConnection(pool)}
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

// BoundedPoolQueryForTest runs one round that sends statement through the bounded executor on a
// connection acquired from pool, bounded by bound.
func BoundedPoolQueryForTest(ctx context.Context, pool *pgxpool.Pool, bound time.Duration, statement string) error {
	roundContext, cancel := context.WithTimeout(ctx, bound)
	defer cancel()
	return runBoundedOnPool(roundContext, pool, func(roundContext context.Context, executor Executor) error {
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
