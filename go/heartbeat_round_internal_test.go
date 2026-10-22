package workhorse

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"
)

func TestHeartbeatRoundBoundIsThreeQuartersOfTheIntervalAndTheIntervalUpTo50Ms(t *testing.T) {
	for _, test := range []struct{ interval, bound time.Duration }{
		{10 * time.Millisecond, 10 * time.Millisecond},
		{40 * time.Millisecond, 40 * time.Millisecond},
		{50 * time.Millisecond, 50 * time.Millisecond},
		{66 * time.Millisecond, 50 * time.Millisecond},
		{69 * time.Millisecond, 51 * time.Millisecond},
		{200 * time.Millisecond, 150 * time.Millisecond},
		{10 * time.Second, 7500 * time.Millisecond},
	} {
		if bound := heartbeatRoundBoundFor(test.interval); bound != test.bound {
			t.Errorf("bound for %s = %s; want %s", test.interval, bound, test.bound)
		}
	}
	// With the defaults, one timed-out round leaves a renewal margin.
	lease := defaultWorkerLease
	if interval := lease / 3; 2*interval+heartbeatRoundBoundFor(interval) >= lease {
		t.Fatalf("no renewal margin for a lease of %s", lease)
	}
}

// SM-1633: the heartbeat statement and each idle gap get one quarter of the time left, and the last
// quarter is kept for COMMIT and the settings statement. Each budget is at least 1 ms.
func TestRoundTimeoutsGiveTheStatementAndEachIdleGapOneQuarter(t *testing.T) {
	for _, test := range []struct {
		remaining       time.Duration
		statement, idle string
	}{
		{8 * time.Millisecond, "2", "2"},
		{3 * time.Millisecond, "1", "1"},
		{999 * time.Microsecond, "1", "1"},
		{750 * time.Millisecond, "187", "187"},
		{2250 * time.Millisecond, "562", "562"},
	} {
		statement, idle := roundTimeouts(test.remaining)
		if statement != test.statement || idle != test.idle {
			t.Errorf("roundTimeouts(%s) = %s, %s; want %s, %s",
				test.remaining, statement, idle, test.statement, test.idle)
		}
	}
}

// waitingRequest adds a round with one batch of one lease to the rounds that wait on connection.
func waitingRequest(
	t *testing.T, connection *heartbeatConnection, deadline time.Time, worker string,
) (*heartbeatRequest, <-chan error) {
	t.Helper()
	request := &heartbeatRequest{
		deadline: deadline,
		batches:  []heartbeatBatch{{object: []byte(`{"workerId":"` + worker + `"}`), size: 1}},
		lead:     make(chan struct{}),
		result:   make(chan heartbeatResult, 1),
	}
	entered := make(chan error, 1)
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	t.Cleanup(cancel)
	go func() {
		result, joined, err := connection.enter(ctx, request)
		switch {
		case err != nil:
			entered <- err
		case joined:
			entered <- result.err
		default:
			entered <- errLed
		}
	}()
	until := time.Now().Add(time.Second)
	for {
		connection.mu.Lock()
		waits := slices.Contains(connection.waiting, request)
		connection.mu.Unlock()
		if waits {
			return request, entered
		}
		if time.Now().After(until) {
			t.Fatal("the round did not wait")
		}
		time.Sleep(time.Millisecond)
	}
}

var errLed = errors.New("the round leads")

// SM-1633: while a transaction is in flight, the rounds that wait with a deadline that is not earlier
// than the leader's join its statement after the leader's batches. A round with an earlier deadline
// does not join. When the transaction ends, it leads the next one.
func TestWaitingRoundsJoinTheLeaderUnlessTheirDeadlineIsEarlier(t *testing.T) {
	connection := &heartbeatConnection{}
	now := time.Now()
	leader := &heartbeatRequest{
		deadline: now.Add(time.Second),
		batches:  []heartbeatBatch{{object: []byte(`{"workerId":"leader"}`), size: 1}},
	}
	if _, joined, err := connection.enter(context.Background(), leader); err != nil || joined {
		t.Fatalf("the first round did not lead: joined %v, error %v", joined, err)
	}
	later, laterDone := waitingRequest(t, connection, now.Add(3*time.Second), "later")
	equal, equalDone := waitingRequest(t, connection, leader.deadline, "equal")
	_, earlierDone := waitingRequest(t, connection, now.Add(500*time.Millisecond), "earlier")

	group := append([]*heartbeatRequest{leader}, connection.join(leader.deadline)...)
	if len(group) != 3 || group[1] != later || group[2] != equal {
		t.Fatalf("the leader took %d rounds; want itself, the later round, and the equal round", len(group))
	}
	if payload := heartbeatPoolPayload(group); payload !=
		`[{"workerId":"leader"},{"workerId":"later"},{"workerId":"equal"}]` {
		t.Fatalf("the statement payload is %s", payload)
	}
	failure := errors.New("the transaction failed")
	for _, member := range group[1:] {
		member.result <- heartbeatResult{err: failure}
	}
	for _, done := range []<-chan error{laterDone, equalDone} {
		if err := <-done; !errors.Is(err, failure) {
			t.Fatalf("a joined round got %v; want the failure of the transaction", err)
		}
	}
	connection.handOff()
	if err := <-earlierDone; !errors.Is(err, errLed) {
		t.Fatalf("the round with the earlier deadline got %v; want it to lead the next transaction", err)
	}
	connection.mu.Lock()
	defer connection.mu.Unlock()
	if !connection.leading || len(connection.waiting) != 0 {
		t.Fatal("the next transaction has no leader")
	}
}

// SM-1633: when a transaction ends, the waiting round with the earliest deadline leads the next one,
// whatever the order the rounds arrived in. With no waiting round, the connection is free.
func TestTheWaitingRoundWithTheEarliestDeadlineLeadsTheNextTransaction(t *testing.T) {
	connection := &heartbeatConnection{}
	now := time.Now()
	first := &heartbeatRequest{deadline: now.Add(time.Second)}
	if _, joined, err := connection.enter(context.Background(), first); err != nil || joined {
		t.Fatal("the first round did not lead")
	}
	_, firstDone := waitingRequest(t, connection, now.Add(3*time.Second), "first")
	_, secondDone := waitingRequest(t, connection, now.Add(2*time.Second), "second")
	connection.handOff()
	if err := <-secondDone; !errors.Is(err, errLed) {
		t.Fatalf("the round with the earliest deadline got %v; want it to lead", err)
	}
	connection.handOff()
	if err := <-firstDone; !errors.Is(err, errLed) {
		t.Fatalf("the last round got %v; want it to lead", err)
	}
	connection.handOff()
	connection.mu.Lock()
	defer connection.mu.Unlock()
	if connection.leading {
		t.Fatal("the connection has a leader after the last round handed off")
	}
}

// SM-1633: a waiting round whose deadline passes before a leader takes it sends nothing and leaves
// the queue.
func TestAWaitingRoundThatReachesItsDeadlineLeavesTheQueue(t *testing.T) {
	connection := &heartbeatConnection{}
	first := &heartbeatRequest{deadline: time.Now().Add(time.Second)}
	if _, _, err := connection.enter(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	_, done := waitingRequest(t, connection, time.Now().Add(20*time.Millisecond), "expired")
	if err := <-done; !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("the expired round got %v; want its deadline", err)
	}
	connection.mu.Lock()
	defer connection.mu.Unlock()
	if len(connection.waiting) != 0 {
		t.Fatal("the expired round still waits")
	}
}

// SM-1633: each batch gets the rows whose batch column names its position in the statement, and a
// batch with a missing row makes the result invalid.
func TestHeartbeatPoolRowsGoToTheBatchThatSentThem(t *testing.T) {
	group := []*heartbeatRequest{
		{batches: []heartbeatBatch{{size: 1}, {size: 2}}},
		{batches: []heartbeatBatch{{size: 1}}},
	}
	row := func(batch int32, task string) Row { return Row{rowBatchField: batch, rowTaskIDField: task} }
	routed, err := routeHeartbeatPoolRows(group, []Row{
		row(1, "a"), row(2, "b"), row(2, "c"), row(3, "d"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(routed) != 2 || len(routed[0]) != 2 || len(routed[1]) != 1 ||
		routed[0][1][1][rowTaskIDField] != "c" || routed[1][0][0][rowTaskIDField] != "d" {
		t.Fatalf("the rows went to the wrong batches: %v", routed)
	}
	if _, err := routeHeartbeatPoolRows(group, []Row{row(1, "a"), row(2, "b"), row(3, "d")}); err == nil {
		t.Fatal("a batch with a missing row was accepted")
	}
	if _, err := routeHeartbeatPoolRows(group, []Row{row(4, "x")}); err == nil {
		t.Fatal("a row of an unknown batch was accepted")
	}
}
