package workhorse

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"strings"
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
// one quarter, each gap one quarter, and the last quarter is kept for COMMIT and the settings
// statement. No setting bounds COMMIT itself.
func roundTimeouts(remaining time.Duration) (statement string, idle string) {
	milliseconds := remaining.Milliseconds()
	quarter := strconv.FormatInt(max(1, milliseconds/4), 10)
	return quarter, quarter
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
	return executor.query(ctx, statement, func() []any { return arguments })
}

// query is Query with the arguments from argumentsFor, which runs after the settings statement and
// right before the statement is sent. A shared round takes the rounds that join it there.
func (executor serverBoundedExecutor) query(
	ctx context.Context,
	statement string,
	argumentsFor func() []any,
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
	// The settings statement is prepared here too, so that its first use on a connection does not
	// count against the quarter that the settings statement may use.
	for _, prepared := range []string{statement, roundTimeoutsStatement} {
		if _, err := tx.Prepare(ctx, prepared, prepared); err != nil {
			return nil, err
		}
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
	arguments := argumentsFor()
	// The payload counts against the deadline, so the statement goes out only in time.
	if !time.Now().Before(deadline) {
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
// heartbeat and its idle waits by the same deadline (serverBoundedExecutor). The bound covers the wait
// for the transaction in flight, the wait for the connection, and the transaction. The timeouts are
// transaction-scoped, so the connection stays safe behind a transaction-mode pooler.
//
// One PostgreSQL session runs one transaction at a time, and every worker on the pool sends its
// rounds here. So the rounds that wait share one transaction (renew): the round that finds no
// transaction in flight leads one, and the waiting rounds whose deadline is not earlier join its
// heartbeat statement.
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
	mu      sync.Mutex
	// leading is true while a round leads a transaction on the connection, until it hands off.
	leading bool
	// waiting holds the rounds that wait for the transaction in flight. A round waits only until its
	// bound.
	waiting []*heartbeatRequest
	conn    *pgxpool.Conn
	rounds  int
	closed  bool
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
		if err == nil {
			if err = connection.prepare(acquired); err != nil {
				closeAndRemove(connection.pool, acquired)
				acquired = nil
			}
		}
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

// prepare prepares the statements of a heartbeat round on a connection that the loop acquired, so
// the first round on it spends no round trip on them. Each takes one round trip on a new session,
// and a round that pays them can reach its deadline before its heartbeat. The wait is bounded by
// max(interval, minimumStartupBudget), as the startup budget is, and by the lifetime of the
// connection. A bound of one interval is too short: with an interval of 100 ms and a round trip of
// 50 ms or more, the two preparations never fit, and the pool never gets a heartbeat connection. A
// round does not wait for the preparation past its own deadline, as it does not wait for the open.
func (connection *heartbeatConnection) prepare(acquired *pgxpool.Conn) error {
	connection.mu.Lock()
	bound := max(connection.interval, minimumStartupBudget)
	connection.mu.Unlock()
	ctx, cancel := context.WithTimeout(connection.lifetime, bound)
	defer cancel()
	statements := []string{protocolStatementRegistry[heartbeatPoolStatementName], roundTimeoutsStatement}
	for _, statement := range statements {
		if _, err := acquired.Conn().Prepare(ctx, statement, statement); err != nil {
			return err
		}
	}
	return nil
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

// run executes one bounded round alone on the reserved connection. It waits for the transaction in
// flight like a heartbeat round, but no other round joins it.
func (connection *heartbeatConnection) run(
	ctx context.Context,
	bound time.Duration,
	round func(context.Context, Executor) error,
) error {
	roundContext, cancel := context.WithTimeout(ctx, bound)
	defer cancel()
	deadline, _ := roundContext.Deadline()
	request := &heartbeatRequest{deadline: deadline, lead: make(chan struct{})}
	if _, _, err := connection.enter(roundContext, request); err != nil {
		return err
	}
	defer connection.handOff()
	return connection.lead(roundContext, round)
}

// lead runs round as the leader of one transaction on the reserved connection. A round that fails
// discards the connection, and the acquisition loop starts at once, so the next round starts from a
// healthy one. A round that expired before its heartbeat statement and left the connection clean
// keeps it, so the next round uses it. This keeps the connection that handlers cannot take (ADR
// 0071).
func (connection *heartbeatConnection) lead(
	roundContext context.Context,
	round func(context.Context, Executor) error,
) error {
	// A round can become the leader after its deadline. It then sends nothing.
	if err := roundContext.Err(); err != nil {
		return err
	}
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

// heartbeatBatch is the leases of one worker in a heartbeat_pool_v1 statement.
type heartbeatBatch struct {
	// object is the JSON batch object: {"workerId": ..., "leases": [...]}.
	object []byte
	// size is the number of leases, at most heartbeatStatementLeaseLimit.
	size int
}

// heartbeatRequest is one round that waits for the reserved connection.
type heartbeatRequest struct {
	deadline time.Time
	// batches is nil for a round that runs alone (run). Only a round with batches joins another one.
	batches []heartbeatBatch
	// lead closes when the round leads the next transaction.
	lead chan struct{}
	// result gets the outcome of the transaction that the round joined.
	result chan heartbeatResult
}

// heartbeatResult is the outcome of a shared transaction for one round that joined it: the rows of
// each of its batches, or the failure of the transaction.
type heartbeatResult struct {
	rows [][]Row
	err  error
}

// enter returns when request leads a transaction on the connection, or when the transaction that
// request joined has ended. joined is true in the second case, and result is that outcome. A round
// that finds no transaction in flight leads at once. If ctx ends while request waits, enter returns
// the error of ctx, and the round sent nothing.
func (connection *heartbeatConnection) enter(
	ctx context.Context,
	request *heartbeatRequest,
) (result heartbeatResult, joined bool, err error) {
	connection.mu.Lock()
	if !connection.leading {
		connection.leading = true
		connection.mu.Unlock()
		return heartbeatResult{}, false, nil
	}
	connection.waiting = append(connection.waiting, request)
	connection.mu.Unlock()
	select {
	case <-request.lead:
		return heartbeatResult{}, false, nil
	case result := <-request.result:
		return result, true, nil
	case <-ctx.Done():
	}
	connection.mu.Lock()
	if index := slices.Index(connection.waiting, request); index >= 0 {
		connection.waiting = slices.Delete(connection.waiting, index, index+1)
		connection.mu.Unlock()
		return heartbeatResult{}, false, ctx.Err()
	}
	connection.mu.Unlock()
	// A leader took the request before its deadline: the request leads now, or it joined a
	// transaction that ends by a deadline that is not later than its own.
	select {
	case <-request.lead:
		return heartbeatResult{}, false, nil
	case result := <-request.result:
		return result, true, nil
	}
}

// handOff ends the turn of the leader. The waiting round with the earliest deadline leads the next
// transaction, and the others can join it.
func (connection *heartbeatConnection) handOff() {
	connection.mu.Lock()
	defer connection.mu.Unlock()
	if len(connection.waiting) == 0 {
		connection.leading = false
		return
	}
	next := 0
	for index, request := range connection.waiting {
		if request.deadline.Before(connection.waiting[next].deadline) {
			next = index
		}
	}
	request := connection.waiting[next]
	connection.waiting = slices.Delete(connection.waiting, next, next+1)
	close(request.lead)
}

// join takes every waiting round with batches whose deadline is not earlier than deadline. Those
// rounds join the transaction of the leader whose deadline is deadline.
func (connection *heartbeatConnection) join(deadline time.Time) []*heartbeatRequest {
	connection.mu.Lock()
	defer connection.mu.Unlock()
	var joined []*heartbeatRequest
	kept := connection.waiting[:0]
	for _, request := range connection.waiting {
		if request.batches != nil && !request.deadline.Before(deadline) {
			joined = append(joined, request)
		} else {
			kept = append(kept, request)
		}
	}
	clear(connection.waiting[len(kept):])
	connection.waiting = kept
	return joined
}

// renew sends batches in one heartbeat_pool_v1 statement on the reserved connection, bounded by
// bound, and returns the rows of each batch in the order of batches.
//
// If no transaction is in flight, the round leads one. Just before its heartbeat statement, the
// leader takes every waiting round whose deadline is not earlier than its own, and their batches
// follow its own in the statement. Each round that joined gets its own rows after COMMIT, or the
// failure of the transaction. A round that cannot join waits, and when the transaction ends, the
// waiting round with the earliest deadline leads the next one.
func (connection *heartbeatConnection) renew(
	ctx context.Context,
	bound time.Duration,
	batches []heartbeatBatch,
) ([][]Row, error) {
	roundContext, cancel := context.WithTimeout(ctx, bound)
	defer cancel()
	deadline, _ := roundContext.Deadline()
	request := &heartbeatRequest{
		deadline: deadline,
		batches:  batches,
		lead:     make(chan struct{}),
		result:   make(chan heartbeatResult, 1),
	}
	result, joined, err := connection.enter(roundContext, request)
	if err != nil {
		return nil, err
	}
	if joined {
		return result.rows, result.err
	}
	defer connection.handOff()
	var group []*heartbeatRequest
	var rows [][][]Row
	err = connection.lead(roundContext, func(ctx context.Context, executor Executor) error {
		var err error
		group, rows, err = connection.sendGroup(ctx, executor.(serverBoundedExecutor), request)
		return err
	})
	// Every round of the transaction gets the same failure.
	for index, member := range group {
		if index == 0 {
			continue
		}
		if err != nil {
			member.result <- heartbeatResult{err: err}
		} else {
			member.result <- heartbeatResult{rows: rows[index]}
		}
	}
	if err != nil {
		return nil, err
	}
	return rows[0], nil
}

// sendGroup sends one transaction with the batches of leader and of every round that joins it. It
// returns the rounds of the transaction, leader first, and the rows of each batch of each round.
//
// PostgreSQL rolls back a deadlock victim, so nothing of the transaction committed. The rollback
// leaves the session clean, and the whole group is sent again in a new transaction with the time
// that remains, up to fencedWriteDeadlockAttempts times.
func (connection *heartbeatConnection) sendGroup(
	ctx context.Context,
	executor serverBoundedExecutor,
	leader *heartbeatRequest,
) ([]*heartbeatRequest, [][][]Row, error) {
	group := []*heartbeatRequest{leader}
	argumentsFor := func() []any {
		group = append(group, connection.join(leader.deadline)...)
		return []any{heartbeatPoolPayload(group)}
	}
	for attempt := 1; ; attempt++ {
		rows, err := executor.query(ctx, protocolStatementRegistry[heartbeatPoolStatementName], argumentsFor)
		if err == nil {
			routed, err := routeHeartbeatPoolRows(group, rows)
			return group, routed, err
		}
		if attempt >= fencedWriteDeadlockAttempts || !hasSQLState(err, deadlockDetectedSQLState) {
			return group, nil, err
		}
	}
}

// heartbeatPoolPayload is the JSON array of every batch of group, in order.
func heartbeatPoolPayload(group []*heartbeatRequest) string {
	var payload strings.Builder
	payload.WriteByte('[')
	for _, request := range group {
		for _, batch := range request.batches {
			if payload.Len() > 1 {
				payload.WriteByte(',')
			}
			payload.Write(batch.object)
		}
	}
	payload.WriteByte(']')
	return payload.String()
}

// routeHeartbeatPoolRows gives each batch of group its rows. The batch column is the 1-based position
// of the batch in the statement, and each batch must get one row for each lease.
func routeHeartbeatPoolRows(group []*heartbeatRequest, rows []Row) ([][][]Row, error) {
	var batches [][]Row
	for _, request := range group {
		for range request.batches {
			batches = append(batches, nil)
		}
	}
	for _, row := range rows {
		position := intValue(row[rowBatchField])
		if position < 1 || position > len(batches) {
			return nil, errors.New(invalidOwnershipResultMessage)
		}
		batches[position-1] = append(batches[position-1], row)
	}
	routed := make([][][]Row, len(group))
	offset := 0
	for index, request := range group {
		for _, batch := range request.batches {
			if len(batches[offset]) != batch.size {
				return nil, errors.New(invalidOwnershipResultMessage)
			}
			routed[index] = append(routed[index], batches[offset])
			offset++
		}
	}
	return routed, nil
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

// renew sends batches on the shared connection, in one transaction with the rounds of other
// workers on the pool.
func (lease *heartbeatConnectionLease) renew(
	ctx context.Context,
	bound time.Duration,
	batches []heartbeatBatch,
) ([][]Row, error) {
	return lease.connection.renew(ctx, bound, batches)
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
