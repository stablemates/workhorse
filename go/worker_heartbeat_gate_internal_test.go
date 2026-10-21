package workhorse

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// These tests pin the claim gate of ADR 0071: a worker with a dedicated heartbeat connection claims
// no task, ordinary or fused, while its pool holds no such connection, and it claims at once when
// the connection returns.

// SM-1576: an ordinary claim waits while the gate is closed and starts at once when the heartbeat
// connection returns, without the poll interval.
func TestDispatchClaimsNothingWithoutTheHeartbeatConnectionAndWakesWhenItReturns(t *testing.T) {
	harness := startDispatchOn(t, WorkerOptions{Concurrency: 2}, false, fastTierQueue)
	harness.expectClaim(2).respond <- fakeClaimResponse{tasks: harness.tasks(2, dispatchTaskType)}
	executions := harness.expectExecutions(2)

	harness.withoutHeartbeat.Store(true)
	// A fused completion gets no reservation, so its statement claims nothing.
	if reservation := harness.reserve(executions[0]); reservation != nil {
		t.Fatalf("a completion reserved %d slots without the heartbeat connection", reservation.limit)
	}
	// The finished execution frees a slot, but no claim starts.
	executions[0].finish <- nil
	harness.expectNoClaim(200 * time.Millisecond)

	harness.withoutHeartbeat.Store(false)
	harness.heartbeat <- struct{}{}
	call := harness.expectClaim(1)
	if err := harness.stop([]fakeClaimCall{call}, executions[1:]); err != nil {
		t.Fatal(err)
	}
}

// SM-1576: a claim that already started and finds the gate closed before its statement sends
// nothing. The claim does not count as empty, and the returning connection starts the next claim.
// Channels order the events: the notified claim enters its delay, the gate closes, the claim
// continues and settles as skipped, and only then does the gate open again.
func TestDispatchSkipsAStartedClaimWhenTheGateCloses(t *testing.T) {
	harness := startDispatchOn(t, WorkerOptions{Concurrency: 1, PollInterval: time.Minute}, false, fullTierQueue)
	harness.expectClaim(1).respond <- fakeClaimResponse{}
	if skipped := <-harness.settled; skipped {
		t.Fatal("the first claim settled as skipped")
	}
	entered := make(chan struct{})
	proceed := make(chan struct{})
	var once sync.Once
	pause := func() {
		once.Do(func() { close(entered) })
		<-proceed
	}
	harness.delayEntered.Store(&pause)
	harness.notification <- struct{}{}
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("the notified claim did not start")
	}
	harness.withoutHeartbeat.Store(true)
	close(proceed)
	select {
	case skipped := <-harness.settled:
		if !skipped {
			t.Fatal("the started claim settled without being skipped")
		}
	case call := <-harness.claims:
		t.Fatalf("the started claim sent a claim for %d slots after the gate closed", call.limit)
	case <-time.After(5 * time.Second):
		t.Fatal("the started claim did not settle")
	}

	harness.delayEntered.Store(nil)
	harness.withoutHeartbeat.Store(false)
	harness.heartbeat <- struct{}{}
	call := harness.expectClaim(1)
	if err := harness.stop([]fakeClaimCall{call}, nil); err != nil {
		t.Fatal(err)
	}
}

// claimLimitExecutor answers a batched completion and keeps the claim limit each statement sent.
type claimLimitExecutor struct {
	limits []int
}

func (executor *claimLimitExecutor) Query(_ context.Context, _ string, arguments ...any) ([]Row, error) {
	executor.limits = append(executor.limits, arguments[5].(int))
	ids := arguments[1].([]string)
	accepted := make([]any, len(ids))
	for index, id := range ids {
		accepted[index] = id
	}
	return []Row{{rowAcceptedField: accepted}}, nil
}

// SM-1576: a fused completion that finds the gate closed settles its task with a claim limit of
// zero. With the heartbeat connection back, it claims up to its reservation again.
func TestFusedCompletionClaimsNothingWithoutTheHeartbeatConnection(t *testing.T) {
	worker := newDefaultWorker(t, WorkerOptions{})
	worker.sharedHeartbeats = false
	connection := &heartbeatConnection{pool: worker.pool, slot: make(chan struct{}, 1)}
	worker.heartbeatLease = &heartbeatConnectionLease{pool: worker.pool, connection: connection}
	executor := &claimLimitExecutor{}

	chunk := completionChunk(executor, "a")
	chunk[0].limit = 3
	worker.completeChunk("defaults", chunk)
	if answer := <-chunk[0].answer; answer.err != nil || !answer.accepted {
		t.Fatalf("the completion answered %#v", answer)
	}

	connection.conn = new(pgxpool.Conn)
	chunk = completionChunk(executor, "b")
	chunk[0].limit = 3
	worker.completeChunk("defaults", chunk)
	if answer := <-chunk[0].answer; answer.err != nil || !answer.accepted {
		t.Fatalf("the completion answered %#v", answer)
	}
	if len(executor.limits) != 2 || executor.limits[0] != 0 || executor.limits[1] != 3 {
		t.Fatalf("claim limits = %v, want [0 3]", executor.limits)
	}
}

// SM-1576: the returning heartbeat connection ends the poll wait of an earlier empty claim, so the
// claim starts at once and not at the next poll.
func TestDispatchClaimsAtOnceWhenTheHeartbeatConnectionReturnsDuringAPollWait(t *testing.T) {
	harness := startDispatchOn(t, WorkerOptions{Concurrency: 1, PollInterval: time.Minute}, false, fullTierQueue)
	harness.expectClaim(1).respond <- fakeClaimResponse{}
	harness.withoutHeartbeat.Store(true)
	harness.expectNoClaim(50 * time.Millisecond)
	harness.withoutHeartbeat.Store(false)
	harness.heartbeat <- struct{}{}
	call := harness.expectClaim(1)
	if err := harness.stop([]fakeClaimCall{call}, nil); err != nil {
		t.Fatal(err)
	}
}

// SM-1576: a fused completion that the closed gate held to a claim limit of 0 says nothing about the
// backlog. When the gate opens, the freed slot is claimed at once, not after a poll wait.
func TestAGatedFusedCompletionDoesNotCountAsAnEmptyClaim(t *testing.T) {
	harness := startDispatchOn(t, WorkerOptions{Concurrency: 2, PollInterval: time.Minute}, false, fastTierQueue)
	worker := harness.worker
	worker.sharedHeartbeats = false
	connection := &heartbeatConnection{pool: worker.pool, slot: make(chan struct{}, 1)}
	worker.heartbeatMu.Lock()
	worker.heartbeatLease = &heartbeatConnectionLease{pool: worker.pool, connection: connection}
	worker.heartbeatMu.Unlock()
	harness.expectClaim(2).respond <- fakeClaimResponse{tasks: harness.tasks(2, dispatchTaskType)}
	executions := harness.expectExecutions(2)

	// The dispatch loop grants the reservation, and then the pool loses its heartbeat connection
	// before the completion statement.
	task := executions[0].task
	task.fastTier = true
	executor := &claimLimitExecutor{}
	if _, err := worker.writeCompletion(context.Background(), executor, task, []byte("null")); err != nil {
		t.Fatal(err)
	}
	if len(executor.limits) != 1 || executor.limits[0] != 0 {
		t.Fatalf("claim limits = %v, want [0]", executor.limits)
	}
	executions[0].finish <- nil
	call := harness.expectClaim(1)
	if err := harness.stop([]fakeClaimCall{call}, executions[1:]); err != nil {
		t.Fatal(err)
	}
}

// SM-1576: a startup that cannot connect names the connection error, not only the budget.
func TestAStartupThatCannotConnectNamesTheConnectionError(t *testing.T) {
	worker, err := NewWorker(unconnectedPool(t), WorkerOptions{Queue: "startup-error", WorkerID: "startup-error"})
	if err != nil {
		t.Fatal(err)
	}
	worker.startupBudget = 300 * time.Millisecond
	_, err = worker.RunOnce(context.Background())
	if err == nil {
		t.Fatal("RunOnce started on a pool that cannot connect")
	}
	for _, fragment := range []string{"dedicated heartbeat connection", "last attempt", "127.0.0.1"} {
		if !strings.Contains(err.Error(), fragment) {
			t.Fatalf("the refusal does not name %q: %v", fragment, err)
		}
	}
}

// statementCounter counts the statements a claim sends and answers each with no rows.
type statementCounter struct{ statements int }

func (executor *statementCounter) Query(context.Context, string, ...any) ([]Row, error) {
	executor.statements++
	return nil, nil
}

// SM-1576: a claim reads the gate on its held connection before each claim statement, so a claim
// that waited for the pool sends nothing after the heartbeat connection went away.
func TestAClaimSendsNoStatementWhileTheGateIsClosed(t *testing.T) {
	worker := newDefaultWorker(t, WorkerOptions{})
	worker.sharedHeartbeats = false
	connection := &heartbeatConnection{pool: worker.pool, slot: make(chan struct{}, 1)}
	worker.heartbeatLease = &heartbeatConnectionLease{pool: worker.pool, connection: connection}
	executor := &statementCounter{}

	tasks, err := worker.claimNextMany(context.Background(), executor, 1, 1)
	if !errors.Is(err, errHeartbeatClaimGateClosed) || len(tasks) != 0 || executor.statements != 0 {
		t.Fatalf("closed gate: tasks %d, statements %d, err %v", len(tasks), executor.statements, err)
	}
	connection.conn = new(pgxpool.Conn)
	if _, err := worker.claimNextMany(context.Background(), executor, 1, 1); err != nil {
		t.Fatal(err)
	}
	if executor.statements == 0 {
		t.Fatal("the open gate sent no claim statement")
	}
}

// SM-1576: a claim that claimed from one queue and then found the gate closed before the next queue
// runs the tasks it claimed. The closed gate does not stop the run and does not count as an empty
// claim, so the next claim starts without a poll wait.
func TestAClaimThatEndsAtTheClosedGateRunsTheTasksItClaimed(t *testing.T) {
	harness := startDispatch(t, WorkerOptions{Concurrency: 2, PollInterval: time.Minute}, false)
	harness.expectClaim(2).respond <- fakeClaimResponse{
		tasks: harness.tasks(1, dispatchTaskType), err: errHeartbeatClaimGateClosed,
	}
	executions := harness.expectExecutions(1)
	harness.expectClaim(1).respond <- fakeClaimResponse{err: errHeartbeatClaimGateClosed}
	next := harness.expectClaim(1)
	if err := harness.stop([]fakeClaimCall{next}, executions); err != nil {
		t.Fatal(err)
	}
}

// gatedWorker returns a worker with a dedicated heartbeat connection that the test controls. The
// worker holds the connection, so its claim gate is open.
func gatedWorker(t *testing.T) (*Worker, *heartbeatConnection) {
	t.Helper()
	worker := newDefaultWorker(t, WorkerOptions{})
	worker.sharedHeartbeats = false
	connection := &heartbeatConnection{pool: worker.pool, slot: make(chan struct{}, 1), conn: new(pgxpool.Conn)}
	worker.heartbeatLease = &heartbeatConnectionLease{pool: worker.pool, connection: connection}
	return worker, connection
}

// loseHeartbeatConnection makes the pool hold no heartbeat connection, as a discarded round does.
func loseHeartbeatConnection(connection *heartbeatConnection) {
	connection.mu.Lock()
	defer connection.mu.Unlock()
	connection.conn = nil
}

// stallingExecutor answers its first statement with failure and loses the heartbeat connection while
// that statement runs. Later statements succeed. It keeps the arguments of every statement.
type stallingExecutor struct {
	connection *heartbeatConnection
	failure    error
	statements [][]any
}

func (executor *stallingExecutor) Query(_ context.Context, _ string, arguments ...any) ([]Row, error) {
	executor.statements = append(executor.statements, arguments)
	if len(executor.statements) == 1 {
		loseHeartbeatConnection(executor.connection)
		return nil, executor.failure
	}
	ids, _ := arguments[1].([]string)
	accepted := make([]any, len(ids))
	for index, id := range ids {
		accepted[index] = id
	}
	return []Row{{rowAcceptedField: accepted}}, nil
}

// SM-1576: a claim waits for its pooled connection, and the heartbeat connection goes away during
// that wait. The claim reads the gate on the connection it got, so it sends no statement.
func TestAClaimThatWaitedForItsConnectionSendsNothingAfterTheHeartbeatConnectionWentAway(t *testing.T) {
	worker, connection := gatedWorker(t)
	borrowing := make(chan struct{})
	lend := make(chan struct{})
	worker.claimConnection = func(_ context.Context, executor Executor) (Executor, func(), error) {
		close(borrowing)
		<-lend
		return executor, func() {}, nil
	}
	executor := &statementCounter{}
	result := make(chan error, 1)
	go func() {
		_, err := worker.claimNextMany(context.Background(), executor, 1, 1)
		result <- err
	}()
	<-borrowing
	loseHeartbeatConnection(connection)
	close(lend)
	if err := <-result; !errors.Is(err, errHeartbeatClaimGateClosed) || executor.statements != 0 {
		t.Fatalf("statements %d, err %v; want no statement and the closed gate", executor.statements, err)
	}
}

// SM-1576: the same order for a fused completion. It settles its task with a claim limit of 0.
func TestAFusedCompletionThatWaitedForItsConnectionClaimsNothingAfterTheHeartbeatConnectionWentAway(t *testing.T) {
	worker, connection := gatedWorker(t)
	borrowing := make(chan struct{})
	lend := make(chan struct{})
	worker.claimConnection = func(_ context.Context, executor Executor) (Executor, func(), error) {
		close(borrowing)
		<-lend
		return executor, func() {}, nil
	}
	executor := &claimLimitExecutor{}
	chunk := completionChunk(executor, "a")
	chunk[0].limit = 3
	done := make(chan struct{})
	go func() {
		worker.completeChunk("defaults", chunk)
		close(done)
	}()
	<-borrowing
	loseHeartbeatConnection(connection)
	close(lend)
	<-done
	if answer := <-chunk[0].answer; answer.err != nil || !answer.accepted || len(answer.rows) != 0 {
		t.Fatalf("the completion answered %#v", answer)
	}
	if len(executor.limits) != 1 || executor.limits[0] != 0 || chunk[0].limit != 0 {
		t.Fatalf("claim limits = %v, entry limit %d; want [0] and 0", executor.limits, chunk[0].limit)
	}
}

// SM-1576: PostgreSQL chooses a fast claim as a deadlock victim, and the heartbeat connection goes
// away during that attempt. The claim sends no second attempt.
func TestAClaimSendsNoDeadlockRetryAfterTheHeartbeatConnectionWentAway(t *testing.T) {
	worker, connection := gatedWorker(t)
	executor := &stallingExecutor{
		connection: connection,
		failure:    &pgconn.PgError{Code: deadlockDetectedSQLState, Message: "deadlock detected"},
	}
	_, err := worker.claimNextMany(context.Background(), executor, 2, 2)
	if !errors.Is(err, errHeartbeatClaimGateClosed) || len(executor.statements) != 1 {
		t.Fatalf("statements %d, err %v; want one statement and the closed gate", len(executor.statements), err)
	}
}

// SM-1576: PostgreSQL refuses a fast claim because the queue left the fast tier, and the heartbeat
// connection goes away during that attempt. The worker sends no claim_many_v1 fallback.
func TestAClaimSendsNoFullTierFallbackAfterTheHeartbeatConnectionWentAway(t *testing.T) {
	worker, connection := gatedWorker(t)
	executor := &stallingExecutor{
		connection: connection,
		failure:    &pgconn.PgError{Code: fastTierUnsupportedSQLState, Message: "fast tier unsupported"},
	}
	_, err := worker.claimNextMany(context.Background(), executor, 2, 2)
	if !errors.Is(err, errHeartbeatClaimGateClosed) || len(executor.statements) != 1 {
		t.Fatalf("statements %d, err %v; want one statement and the closed gate", len(executor.statements), err)
	}
}

// SM-1576: a fused completion is a deadlock victim, and the heartbeat connection goes away during
// that attempt. The resend settles the task with a claim limit of 0.
func TestAFusedCompletionResendClaimsNothingAfterTheHeartbeatConnectionWentAway(t *testing.T) {
	worker, connection := gatedWorker(t)
	executor := &stallingExecutor{
		connection: connection,
		failure:    &pgconn.PgError{Code: deadlockDetectedSQLState, Message: "deadlock detected"},
	}
	chunk := completionChunk(executor, "a")
	chunk[0].limit = 3
	worker.completeChunk("defaults", chunk)
	if answer := <-chunk[0].answer; answer.err != nil || !answer.accepted || len(answer.rows) != 0 {
		t.Fatalf("the completion answered %#v", answer)
	}
	if len(executor.statements) != 2 || executor.statements[0][5] != 3 || executor.statements[1][5] != 0 {
		t.Fatalf("claim limits of the attempts: %v", executor.statements)
	}
	if chunk[0].limit != 0 {
		t.Fatalf("entry limit %d, want 0", chunk[0].limit)
	}
}
