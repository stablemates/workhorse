package workhorse

import (
	"context"
	"errors"
	"fmt"
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

// errHeartbeatConnectionSettling is the cause a waiter reports while the connection that the pool's
// last holder released has not settled.
var errHeartbeatConnectionSettling = errors.New(heartbeatConnectionSettlingMessage)

// errHeartbeatRoundExpiredBeforeHeartbeat ends a round that expired before it sent its heartbeat
// statement and left the connection clean: it sent nothing, or its ROLLBACK succeeded by the
// deadline. The round still fails, but the caller keeps the connection for the next round.
var errHeartbeatRoundExpiredBeforeHeartbeat error = heartbeatRoundExpiredBeforeHeartbeat{}

// heartbeatRoundExpiredBeforeHeartbeat has the message of errHeartbeatRoundExpired and wraps it, so
// errors.Is finds both.
type heartbeatRoundExpiredBeforeHeartbeat struct{}

func (heartbeatRoundExpiredBeforeHeartbeat) Error() string { return heartbeatRoundExpiredMessage }

func (heartbeatRoundExpiredBeforeHeartbeat) Unwrap() error { return errHeartbeatRoundExpired }

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
	// A round without the time for its settings statement sends nothing, so the connection stays
	// clean.
	if time.Until(deadline) < minimumRoundRemaining {
		return nil, errHeartbeatRoundExpiredBeforeHeartbeat
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
		return nil, rollBackBeforeHeartbeat(ctx, tx)
	}
	statementMS, idleMS := roundTimeouts(remaining)
	if _, err := tx.Exec(ctx, roundTimeoutsStatement, statementMS, idleMS); err != nil {
		return nil, err
	}
	// The budgets fit only if the settings statement used at most the quarter kept for COMMIT.
	if time.Since(setAt) > remaining/4 {
		return nil, rollBackBeforeHeartbeat(ctx, tx)
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

// rollBackBeforeHeartbeat ends a round that expired before its heartbeat statement. No statement is
// in flight, so the ROLLBACK is the only statement left. It keeps the round's deadline: past it, pgx
// sends nothing and closes the connection. A ROLLBACK that succeeds leaves the session clean, so the
// caller keeps the connection (errHeartbeatRoundExpiredBeforeHeartbeat). After any other result, the
// caller discards it.
func rollBackBeforeHeartbeat(ctx context.Context, tx pgx.Tx) error {
	if err := tx.Rollback(ctx); err != nil {
		return errHeartbeatRoundExpired
	}
	return errHeartbeatRoundExpiredBeforeHeartbeat
}

// keepsConnection reports whether a failed round left its connection clean, so the next round can
// use it.
func keepsConnection(err error) bool {
	return errors.Is(err, errHeartbeatRoundExpiredBeforeHeartbeat)
}

// runBoundedOnPool runs one round on a connection acquired from pool, bounded by the deadline of ctx.
// A round that fails closes the connection, because its state is not known. A round that expired
// before its heartbeat statement and left the connection clean returns it to the pool open.
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
		if !keepsConnection(err) {
			_ = held.Conn().Close(context.Background())
		}
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
// the wait for the connection, and the transaction. The timeouts are transaction-scoped, so the
// connection stays safe behind a transaction-mode pooler.
//
// Only one acquisition loop asks the pool for the connection (acquireUntilHeld), with one Acquire in
// flight. A round or a startup that needs the connection waits for that loop until its own deadline,
// and the Acquire continues past that deadline. So waiters that time out start no new acquisition
// and leave none behind. The loop starts when the first holder reserves and again when a round
// discards the connection, and it retries until a connection arrives or the last holder releases.
// It runs whether or not any task is active (ADR 0071).
//
// A connection that the last holder released still owns what it holds until it settles: a round in
// flight, its connection, and a late Acquire. The connection that replaces it on the same pool
// starts its acquisition loop only after it settles, so a released connection never overlaps the
// next one (ADR 0071, rule 7). The notification listener waits for its predecessor the
// same way.
type heartbeatConnection struct {
	pool *pgxpool.Pool
	// acquire is pool.Acquire outside tests.
	acquire func(context.Context) (*pgxpool.Conn, error)
	// slot serializes rounds, because one PostgreSQL session runs one transaction at a time and
	// every worker on this pool sends its rounds here. A round waits for it only until its bound.
	slot   chan struct{}
	mu     sync.Mutex
	conn   *pgxpool.Conn
	rounds int
	closed bool
	// held closes when the loop stores a connection. A discard replaces it with an open channel, so a
	// waiter sees only a connection that arrived after the discard.
	held chan struct{}
	// acquiring is true while the acquisition loop runs, until it has removed a late connection.
	acquiring bool
	// removing counts the connections that closeAndRemove still ends on their own goroutines: a
	// discarded one, and the held one after the last release (removeLocked).
	removing int
	// lastErr is the error of the loop's last failed attempt since the connection was last held.
	lastErr error
	// interval caps the delay between two failed attempts of the loop. It is the shortest that any
	// worker gave since the connection was created.
	interval time.Duration
	// lifetime ends when the last holder releases, which stops the loop and every wait.
	lifetime      context.Context
	endLifetime   context.CancelFunc
	readyHandlers map[*heartbeatConnectionLease]func()
	// previous closes when the connection that this one replaces on the pool has settled. It is nil
	// when no connection was settling.
	previous <-chan struct{}
	// started is true once the acquisition loop has stopped waiting for previous.
	started bool
	// settled closes when this connection and previous have settled: the last holder released, no
	// round runs, the acquisition loop has ended, and the pool no longer counts the connection.
	settled  chan struct{}
	settling bool
	// handedBack is true when the last holder released before the loop started. The connection then
	// held nothing, so the registry gave previous to the next connection, and settled never closes.
	handedBack bool
}

// heartbeatReacquireInitialDelay is the first delay between two attempts of the acquisition loop.
// Each later delay doubles, up to the heartbeat interval.
const heartbeatReacquireInitialDelay = 10 * time.Millisecond

func newHeartbeatConnection(
	pool *pgxpool.Pool,
	interval time.Duration,
	previous <-chan struct{},
) *heartbeatConnection {
	lifetime, endLifetime := context.WithCancel(context.Background())
	return &heartbeatConnection{
		pool:          pool,
		acquire:       pool.Acquire,
		slot:          make(chan struct{}, 1),
		held:          make(chan struct{}),
		interval:      interval,
		lifetime:      lifetime,
		endLifetime:   endLifetime,
		readyHandlers: make(map[*heartbeatConnectionLease]func()),
		previous:      previous,
		settled:       make(chan struct{}),
	}
}

// reserve waits until the connection is held or ctx ends.
func (connection *heartbeatConnection) reserve(ctx context.Context) error {
	_, err := connection.await(ctx)
	return err
}

// ready reports whether the connection is held now. A round in flight keeps it held, so a slow or
// failed round that keeps its connection does not make the connection unready.
func (connection *heartbeatConnection) ready() bool {
	connection.mu.Lock()
	defer connection.mu.Unlock()
	return connection.conn != nil && !connection.closed
}

// await returns the held connection. Without one, it starts the acquisition loop if the loop is not
// running and waits for it until ctx ends.
func (connection *heartbeatConnection) await(ctx context.Context) (*pgxpool.Conn, error) {
	for {
		connection.mu.Lock()
		if connection.closed {
			connection.mu.Unlock()
			return nil, errors.New(heartbeatConnectionClosedMessage)
		}
		if held := connection.conn; held != nil {
			connection.mu.Unlock()
			return held, nil
		}
		connection.startAcquiringLocked()
		held := connection.held
		connection.mu.Unlock()
		select {
		case <-held:
		case <-connection.lifetime.Done():
		case <-ctx.Done():
			connection.mu.Lock()
			lastErr := connection.lastErr
			connection.mu.Unlock()
			if lastErr == errHeartbeatConnectionSettling {
				return nil, fmt.Errorf(heartbeatSettlingWaitFormat, ctx.Err(), lastErr)
			}
			if lastErr != nil {
				return nil, fmt.Errorf(heartbeatAcquisitionFailedFormat, ctx.Err(), lastErr)
			}
			return nil, ctx.Err()
		}
	}
}

// startAcquiringLocked starts the acquisition loop unless a connection is held, the loop runs, or the
// connection is released. The caller holds mu.
func (connection *heartbeatConnection) startAcquiringLocked() {
	if connection.conn != nil || connection.acquiring || connection.closed {
		return
	}
	connection.acquiring = true
	if connection.previous != nil {
		select {
		case <-connection.previous:
		default:
			connection.lastErr = errHeartbeatConnectionSettling
		}
	}
	go connection.acquireUntilHeld()
}

// acquireUntilHeld asks the pool for the connection until one arrives or the connection is released.
// It has one Acquire in flight. That Acquire ends only when the pool lends a connection, the
// connection fails to open, or the last holder releases. No waiter's deadline ends it, so repeated
// waiter timeouts start no further Acquire and no further connect. After a failed attempt the loop
// waits, starting at heartbeatReacquireInitialDelay and doubling up to the heartbeat interval.
//
// The loop is the one owner of what its Acquire returns: it keeps the connection, or it closes it and
// removes it from the pool (closeAndRemove) when the last holder released first. The loop counts as
// running until that removal ends, so the connection settles only after it. If the release ends an
// Acquire whose connect is still running, pgxpool finishes that connect and adopts the connection as
// idle.
//
// The loop first waits until the connection that this one replaces has settled, or until the last
// holder releases this one. A holder's own deadline bounds its wait, as it bounds every wait for
// the loop. A connection whose last holder releases during that wait holds nothing, so it leaves no
// goroutine behind (closeUnstarted).
func (connection *heartbeatConnection) acquireUntilHeld() {
	if connection.previous != nil {
		select {
		case <-connection.previous:
		case <-connection.lifetime.Done():
			connection.endAcquiring(nil)
			return
		}
	}
	connection.mu.Lock()
	if connection.closed {
		connection.mu.Unlock()
		connection.endAcquiring(nil)
		return
	}
	connection.started = true
	if connection.lastErr == errHeartbeatConnectionSettling {
		connection.lastErr = nil
	}
	connection.mu.Unlock()
	delay := heartbeatReacquireInitialDelay
	for {
		acquired, err := connection.acquire(connection.lifetime)
		connection.mu.Lock()
		if connection.closed {
			connection.mu.Unlock()
			connection.endAcquiring(acquired)
			return
		}
		if err == nil {
			connection.conn = acquired
			connection.acquiring = false
			connection.lastErr = nil
			close(connection.held)
			handlers := make([]func(), 0, len(connection.readyHandlers))
			for _, handler := range connection.readyHandlers {
				handlers = append(handlers, handler)
			}
			connection.mu.Unlock()
			for _, handler := range handlers {
				handler()
			}
			return
		}
		connection.lastErr = err
		interval := connection.interval
		connection.mu.Unlock()
		wait := time.NewTimer(min(delay, interval))
		select {
		case <-wait.C:
		case <-connection.lifetime.Done():
			wait.Stop()
		}
		delay = min(2*delay, interval)
	}
}

// endAcquiring ends the acquisition loop after the last holder released. It closes a connection
// that arrived late and removes it from the pool (closeAndRemove), then settles.
func (connection *heartbeatConnection) endAcquiring(acquired *pgxpool.Conn) {
	if acquired != nil {
		closeAndRemove(connection.pool, acquired)
	}
	connection.mu.Lock()
	connection.acquiring = false
	connection.settleLocked()
	connection.mu.Unlock()
}

// watch calls onReady each time the acquisition loop stores a connection, until lease releases.
func (connection *heartbeatConnection) watch(lease *heartbeatConnectionLease, onReady func()) {
	connection.mu.Lock()
	defer connection.mu.Unlock()
	connection.readyHandlers[lease] = onReady
}

func (connection *heartbeatConnection) unwatch(lease *heartbeatConnectionLease) {
	connection.mu.Lock()
	defer connection.mu.Unlock()
	delete(connection.readyHandlers, lease)
}

// shorten lowers the loop's delay cap to the interval of a new holder with a shorter one.
func (connection *heartbeatConnection) shorten(interval time.Duration) {
	connection.mu.Lock()
	defer connection.mu.Unlock()
	connection.interval = min(connection.interval, interval)
}

// run executes one bounded round on the reserved connection. A round that fails discards the
// connection, and the acquisition loop starts at once, so the next round starts from a healthy one.
// A round that expired before its heartbeat statement and left the connection clean keeps it, so
// the next round uses it. This keeps the connection that handlers cannot take (ADR 0071).
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
	held, err := connection.await(roundContext)
	if err != nil {
		return err
	}
	if err := round(roundContext, serverBoundedExecutor{conn: held.Conn()}); err != nil {
		if keepsConnection(err) {
			return err
		}
		connection.discard(held)
		return err
	}
	return nil
}

// release stops reserving and ends the acquisition loop. A round still in flight owns the
// connection until it returns, so releasing never takes a session out from under a statement.
// Release waits for nothing. settled closes when the connection has settled.
func (connection *heartbeatConnection) release() {
	connection.mu.Lock()
	connection.closed = true
	connection.endLifetime()
	if connection.rounds > 0 {
		connection.mu.Unlock()
		return
	}
	connection.returnHeldAndUnlock()
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
	connection.returnHeldAndUnlock()
}

// returnHeldAndUnlock closes the held connection and removes it from the pool once the last holder
// released and no round runs (removeLocked), then settles. The caller holds mu, and mu is unlocked
// when it returns.
func (connection *heartbeatConnection) returnHeldAndUnlock() {
	if held := connection.conn; held != nil {
		connection.conn = nil
		connection.removeLocked(held)
	}
	connection.settleLocked()
	connection.mu.Unlock()
}

// removeLocked gives held to closeAndRemove on a goroutine that it counts in removing. Closing
// waits for the server, up to heartbeatCloseTimeout after BeforeClose returns. So neither a round
// nor a stopping worker waits for it, and the next round can use the replacement at once. The
// connection settles only after every removal has ended, so the pool no longer counts what it
// removed. The caller holds mu.
func (connection *heartbeatConnection) removeLocked(held *pgxpool.Conn) {
	connection.removing++
	go func() {
		closeAndRemove(connection.pool, held)
		connection.mu.Lock()
		connection.removing--
		connection.settleLocked()
		connection.mu.Unlock()
	}()
}

// heartbeatCloseTimeout bounds closeAndRemove. pgxpool gives its own destructor the same bound.
const heartbeatCloseTimeout = 15 * time.Second

// closeAndRemove ends the session of held and then removes it from pool, before it returns. It does
// what the pool's destructor does, in the same order: BeforeClose, Close, and the wait for the
// cleanup. Then Hijack removes the connection from the pool's count and frees its place at once.
//
// Release cannot give this order. pgxpool runs an AfterRelease hook on a goroutine and returns
// before the hook gives the connection back, and it destroys a closed or expired connection on a
// goroutine too. A connection whose return the caller cannot observe could still count against the
// pool after its owner settled. The session closes before its place is free, so the pool never holds
// more sessions than its maximum.
func closeAndRemove(pool *pgxpool.Pool, held *pgxpool.Conn) {
	conn := held.Conn()
	if beforeClose := pool.Config().BeforeClose; beforeClose != nil {
		beforeClose(conn)
	}
	ctx, cancel := context.WithTimeout(context.Background(), heartbeatCloseTimeout)
	defer cancel()
	_ = conn.Close(ctx)
	select {
	case <-conn.PgConn().CleanupDone():
	case <-ctx.Done():
	}
	held.Hijack()
}

// settleLocked closes settled once nothing of this connection is left: the last holder released, no
// round runs, the acquisition loop has ended, and the pool no longer counts the held connection. It
// closes settled only after previous, so each connection on a pool settles after the one it
// replaced. The caller holds mu.
func (connection *heartbeatConnection) settleLocked() {
	if !connection.closed || connection.rounds > 0 || connection.acquiring || connection.removing > 0 ||
		connection.settling {
		return
	}
	connection.settling = true
	if connection.handedBack {
		return
	}
	go func() {
		if connection.previous != nil {
			<-connection.previous
		}
		close(connection.settled)
		forgetSettledHeartbeatConnection(connection.pool, connection.settled)
	}()
}

// closeUnstarted closes the connection if its acquisition loop has not started, and returns
// previous. Such a connection holds nothing and never will, so the registry can give previous to the
// next connection on the pool instead of a settled channel that waits for previous. Repeated
// startups that end while a released round still runs then leave no waiting goroutine.
func (connection *heartbeatConnection) closeUnstarted() (<-chan struct{}, bool) {
	connection.mu.Lock()
	defer connection.mu.Unlock()
	if connection.started {
		return nil, false
	}
	connection.closed = true
	connection.handedBack = true
	return connection.previous, true
}

// discard closes the session so the pool cannot lend it again, and starts the acquisition loop for
// its replacement. A heartbeat or an idle wait still open on it ends by its server-side timeout.
// The close runs on its own goroutine (removeLocked), so the round that discards ends at once and
// frees the round slot for the replacement. The replacement starts at once (ADR 0071, rule 6), so
// while the discarded session closes, the pool can count both.
func (connection *heartbeatConnection) discard(held *pgxpool.Conn) {
	connection.mu.Lock()
	defer connection.mu.Unlock()
	if connection.conn != held {
		return
	}
	connection.conn = nil
	connection.held = make(chan struct{})
	connection.startAcquiringLocked()
	connection.removeLocked(held)
}

// heartbeatConnectionLease is one worker's hold on the heartbeat connection its pool shares.
type heartbeatConnectionLease struct {
	pool       *pgxpool.Pool
	connection *heartbeatConnection
	released   bool
}

// reserve waits until the shared connection is held or ctx ends.
func (lease *heartbeatConnectionLease) reserve(ctx context.Context) error {
	return lease.connection.reserve(ctx)
}

// ready reports whether the shared connection is held now.
func (lease *heartbeatConnectionLease) ready() bool {
	return lease.connection.ready()
}

// watch calls onReady each time a replacement connection arrives, until this hold releases.
func (lease *heartbeatConnectionLease) watch(onReady func()) {
	lease.connection.watch(lease, onReady)
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
	// settling holds the settled channel of the connection whose last holder released, until it
	// settles. A connection that replaces it waits for that channel before it acquires.
	settling map[*pgxpool.Pool]<-chan struct{}
}{
	held:     make(map[*pgxpool.Pool]*sharedHeartbeatConnection),
	settling: make(map[*pgxpool.Pool]<-chan struct{}),
}

type sharedHeartbeatConnection struct {
	connection *heartbeatConnection
	holders    int
}

// holdHeartbeatConnection hands the caller the heartbeat connection shared by every worker on one
// pool. Workers share it the way they share the notification listener, so a pool gives up one
// connection for heartbeats however many workers run on it. When the last holder releases, the
// connection closes and leaves the pool.
// interval is the holder's heartbeat interval, which caps the delay of the shared acquisition loop.
// A new connection acquires only after the released one it replaces has settled, so the holder's
// reserve waits for that within its own deadline.
func holdHeartbeatConnection(pool *pgxpool.Pool, interval time.Duration) *heartbeatConnectionLease {
	heldHeartbeatConnections.mu.Lock()
	defer heldHeartbeatConnections.mu.Unlock()
	shared, ok := heldHeartbeatConnections.held[pool]
	if !ok {
		previous := heldHeartbeatConnections.settling[pool]
		shared = &sharedHeartbeatConnection{connection: newHeartbeatConnection(pool, interval, previous)}
		heldHeartbeatConnections.held[pool] = shared
	} else {
		shared.connection.shorten(interval)
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
	lease.connection.unwatch(lease)
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
	if previous, unstarted := shared.connection.closeUnstarted(); unstarted {
		settleHeartbeatConnectionAfterLocked(lease.pool, previous)
	} else {
		heldHeartbeatConnections.settling[lease.pool] = shared.connection.settled
	}
	heldHeartbeatConnections.mu.Unlock()
	shared.connection.release()
}

// settleHeartbeatConnectionAfterLocked makes the next connection on pool wait for previous, or for
// nothing when previous is nil or has settled. The caller holds heldHeartbeatConnections.mu.
func settleHeartbeatConnectionAfterLocked(pool *pgxpool.Pool, previous <-chan struct{}) {
	if previous != nil {
		select {
		case <-previous:
		default:
			heldHeartbeatConnections.settling[pool] = previous
			return
		}
	}
	delete(heldHeartbeatConnections.settling, pool)
}

// forgetSettledHeartbeatConnection removes the settling entry of a connection that has settled,
// unless a later release replaced it.
func forgetSettledHeartbeatConnection(pool *pgxpool.Pool, settled <-chan struct{}) {
	heldHeartbeatConnections.mu.Lock()
	defer heldHeartbeatConnections.mu.Unlock()
	if heldHeartbeatConnections.settling[pool] == settled {
		delete(heldHeartbeatConnections.settling, pool)
	}
}
