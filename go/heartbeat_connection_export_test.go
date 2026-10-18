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
	return string(statuses[taskID]), err
}
