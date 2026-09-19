package workhorse

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// heartbeatConnection keeps one pooled connection for heartbeats, with every round bounded in time.
//
// Handlers that hold every other pooled connection cannot delay a heartbeat queued behind them,
// because the heartbeat never waits for the shared pool. A round that outlives its bound closes the
// connection, so the pool discards it instead of lending it again, and closing also ends the
// statement still running on it. The next round takes a fresh connection. The connection holds no
// session state, so it stays safe behind a transaction-mode pooler.
type heartbeatConnection struct {
	pool *pgxpool.Pool
	// slot serializes rounds, because one PostgreSQL session runs one statement at a time and
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
	if err := round(roundContext, NewPGXExecutor(held.Conn())); err != nil {
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

// discard closes the session so the pool cannot lend it again, which also ends a statement still
// running on it.
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
