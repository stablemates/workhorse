package workhorse

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// minimumRoundRemaining is the least time a round must have left to send its heartbeat. At this size
// every budget of roundTimeouts is at least 1 ms, and the budgets still fit in the time left.
const minimumRoundRemaining = 8 * time.Millisecond

// roundTimeouts returns the server budgets for the rest of a round that has remaining left, in whole
// milliseconds.
//
// PostgreSQL measures statement_timeout for each statement and idle_in_transaction_session_timeout
// for each idle gap, and restarts both every time. While the round can hold a row lock, it has one
// idle gap before the heartbeat, the heartbeat, and one idle gap before COMMIT. So the heartbeat gets
// one half, each gap one eighth, and the last quarter is kept for COMMIT. No setting bounds COMMIT
// itself.
func roundTimeouts(remaining time.Duration) (statement string, idle string) {
	milliseconds := remaining.Milliseconds()
	return strconv.FormatInt(max(1, milliseconds/2), 10), strconv.FormatInt(max(1, milliseconds/8), 10)
}

var errHeartbeatRoundExpired = errors.New(heartbeatRoundExpiredMessage)

// serverBoundedExecutor sends each statement in its own transaction on conn, with server timeouts
// that fit in the time left before the deadline of the statement's context.
//
// Closing a connection does not stop its statement: PostgreSQL notices a closed client only when it
// next writes to it. So the server must end a round that the client stopped waiting for. The
// timeouts (roundTimeouts) end the heartbeat, and a transaction whose client stopped before COMMIT,
// by the deadline. A COMMIT that PostgreSQL has already started can still finish later. Both settings
// end with the transaction, so the connection keeps no session state.
type serverBoundedExecutor struct {
	conn *pgx.Conn
}

func (executor serverBoundedExecutor) Query(
	ctx context.Context,
	statement string,
	arguments ...any,
) ([]Row, error) {
	deadline, ok := ctx.Deadline()
	if !ok {
		return nil, errors.New(heartbeatRoundWithoutDeadlineMessage)
	}
	tx, err := executor.conn.Begin(ctx)
	if err != nil {
		return nil, err
	}
	// Rollback after a commit does nothing. After a failure it leaves the session clean for a
	// deadlock resend. It keeps the round's deadline: past it, the rollback fails at once, and the
	// caller discards the connection.
	defer func() { _ = tx.Rollback(ctx) }()
	// pgx prepares a statement in its own cycle on first use, and PostgreSQL restarts the statement
	// timer at the end of that cycle. Preparing first keeps that cycle out of the heartbeat's budget.
	if _, err := tx.Prepare(ctx, statement, statement); err != nil {
		return nil, err
	}
	setAt := time.Now()
	remaining := deadline.Sub(setAt)
	if remaining < minimumRoundRemaining {
		return nil, errHeartbeatRoundExpired
	}
	statementMS, idleMS := roundTimeouts(remaining)
	if _, err := tx.Exec(ctx, roundTimeoutsStatement, statementMS, idleMS); err != nil {
		return nil, err
	}
	// The budgets fit only if the settings statement used at most the quarter kept for COMMIT.
	if time.Since(setAt) > remaining/4 {
		return nil, errHeartbeatRoundExpired
	}
	rows, err := NewPGXExecutor(tx).Query(ctx, statement, arguments...)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	// A COMMIT that ends after the deadline does not count as a renewal.
	if !time.Now().Before(deadline) {
		return nil, errHeartbeatRoundExpired
	}
	return rows, nil
}

// runBoundedOnPool runs one round on a connection acquired from pool, bounded by the deadline of ctx.
// A round that fails closes the connection, because its state is not known.
func runBoundedOnPool(
	ctx context.Context,
	pool *pgxpool.Pool,
	round func(context.Context, Executor) error,
) error {
	held, err := pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer held.Release()
	if err := round(ctx, serverBoundedExecutor{conn: held.Conn()}); err != nil {
		_ = held.Conn().Close(context.Background())
		return err
	}
	return nil
}

// heartbeatConnection keeps one pooled connection for heartbeats, with every round bounded in time.
//
// Handlers that hold every other pooled connection cannot delay a heartbeat queued behind them,
// because the heartbeat never waits for the shared pool. A round that outlives its bound closes the
// connection, so the pool discards it instead of lending it again, and server timeouts end its
// heartbeat and its idle waits by the same deadline (serverBoundedExecutor). The bound covers the wait for the slot,
// the checkout, and the transaction. The next round takes a fresh connection. The timeouts are
// transaction-scoped, so the connection stays safe behind a transaction-mode pooler.
type heartbeatConnection struct {
	pool *pgxpool.Pool
	// slot serializes rounds, because one PostgreSQL session runs one transaction at a time and
	// every worker on this pool sends its rounds here. A round waits for it only until its bound.
	slot   chan struct{}
	mu     sync.Mutex
	conn   *pgxpool.Conn
	rounds int
	closed bool
}

func newHeartbeatConnection(pool *pgxpool.Pool) *heartbeatConnection {
	return &heartbeatConnection{pool: pool, slot: make(chan struct{}, 1)}
}

// reserve takes the connection before any handler can exhaust the pool. A pool that cannot lend one
// now is asked again by the first round.
func (connection *heartbeatConnection) reserve(ctx context.Context, bound time.Duration) {
	reserveContext, cancel := context.WithTimeout(ctx, bound)
	defer cancel()
	_, _ = connection.acquire(reserveContext)
}

// run executes one bounded round on the reserved connection. A round that fails discards the
// connection, so the next round starts from a healthy one.
func (connection *heartbeatConnection) run(
	ctx context.Context,
	bound time.Duration,
	round func(context.Context, Executor) error,
) error {
	roundContext, cancel := context.WithTimeout(ctx, bound)
	defer cancel()
	select {
	case connection.slot <- struct{}{}:
	case <-roundContext.Done():
		return roundContext.Err()
	}
	defer func() { <-connection.slot }()
	if err := connection.startRound(); err != nil {
		return err
	}
	defer connection.finishRound()
	held, err := connection.acquire(roundContext)
	if err != nil {
		return err
	}
	if err := round(roundContext, serverBoundedExecutor{conn: held.Conn()}); err != nil {
		connection.discard(held)
		return err
	}
	return nil
}

// release stops reserving. A round still in flight owns the connection until it returns, so
// releasing never takes a session out from under a statement.
func (connection *heartbeatConnection) release() {
	connection.mu.Lock()
	connection.closed = true
	if connection.rounds > 0 {
		connection.mu.Unlock()
		return
	}
	held := connection.conn
	connection.conn = nil
	connection.mu.Unlock()
	if held != nil {
		held.Release()
	}
}

func (connection *heartbeatConnection) startRound() error {
	connection.mu.Lock()
	defer connection.mu.Unlock()
	if connection.closed {
		return errors.New(heartbeatConnectionClosedMessage)
	}
	connection.rounds++
	return nil
}

func (connection *heartbeatConnection) finishRound() {
	connection.mu.Lock()
	connection.rounds--
	if connection.rounds > 0 || !connection.closed {
		connection.mu.Unlock()
		return
	}
	held := connection.conn
	connection.conn = nil
	connection.mu.Unlock()
	if held != nil {
		held.Release()
	}
}

func (connection *heartbeatConnection) acquire(ctx context.Context) (*pgxpool.Conn, error) {
	connection.mu.Lock()
	held := connection.conn
	closed := connection.closed
	connection.mu.Unlock()
	if held != nil {
		return held, nil
	}
	if closed {
		return nil, errors.New(heartbeatConnectionClosedMessage)
	}
	acquired, err := connection.pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	connection.mu.Lock()
	if connection.conn == nil && !connection.closed {
		connection.conn = acquired
		connection.mu.Unlock()
		return acquired, nil
	}
	held = connection.conn
	connection.mu.Unlock()
	acquired.Release()
	if held == nil {
		return nil, errors.New(heartbeatConnectionClosedMessage)
	}
	return held, nil
}

// discard closes the session so the pool cannot lend it again. A heartbeat or an idle wait still open
// on it ends by its server-side timeout.
func (connection *heartbeatConnection) discard(held *pgxpool.Conn) {
	connection.mu.Lock()
	if connection.conn != held {
		connection.mu.Unlock()
		return
	}
	connection.conn = nil
	connection.mu.Unlock()
	_ = held.Conn().Close(context.Background())
	held.Release()
}

// heartbeatConnectionLease is one worker's hold on the heartbeat connection its pool shares.
type heartbeatConnectionLease struct {
	pool       *pgxpool.Pool
	connection *heartbeatConnection
	released   bool
}

func (lease *heartbeatConnectionLease) reserve(ctx context.Context, bound time.Duration) {
	lease.connection.reserve(ctx, bound)
}

func (lease *heartbeatConnectionLease) run(
	ctx context.Context,
	bound time.Duration,
	round func(context.Context, Executor) error,
) error {
	return lease.connection.run(ctx, bound, round)
}

var heldHeartbeatConnections = struct {
	mu   sync.Mutex
	held map[*pgxpool.Pool]*sharedHeartbeatConnection
}{held: make(map[*pgxpool.Pool]*sharedHeartbeatConnection)}

type sharedHeartbeatConnection struct {
	connection *heartbeatConnection
	holders    int
}

// holdHeartbeatConnection hands the caller the heartbeat connection shared by every worker on one
// pool. Workers share it the way they share the notification listener, so a pool gives up one
// connection for heartbeats however many workers run on it. The last holder to release returns it.
func holdHeartbeatConnection(pool *pgxpool.Pool) *heartbeatConnectionLease {
	heldHeartbeatConnections.mu.Lock()
	defer heldHeartbeatConnections.mu.Unlock()
	shared, ok := heldHeartbeatConnections.held[pool]
	if !ok {
		shared = &sharedHeartbeatConnection{connection: newHeartbeatConnection(pool)}
		heldHeartbeatConnections.held[pool] = shared
	}
	shared.holders++
	return &heartbeatConnectionLease{pool: pool, connection: shared.connection}
}

// release drops this worker's hold. Releasing twice is a no-op, so a worker releases at the end of
// every run and takes a new hold when it runs again.
func (lease *heartbeatConnectionLease) release() {
	heldHeartbeatConnections.mu.Lock()
	if lease.released {
		heldHeartbeatConnections.mu.Unlock()
		return
	}
	lease.released = true
	shared, ok := heldHeartbeatConnections.held[lease.pool]
	if !ok || shared.connection != lease.connection {
		heldHeartbeatConnections.mu.Unlock()
		return
	}
	shared.holders--
	if shared.holders > 0 {
		heldHeartbeatConnections.mu.Unlock()
		return
	}
	delete(heldHeartbeatConnections.held, lease.pool)
	heldHeartbeatConnections.mu.Unlock()
	shared.connection.release()
}
