package workhorse

import (
	"sync"
	"time"
)

// HeartbeatRoundForTest is one heartbeat round of a worker at the worker's own stamps. It holds the
// start of the round, its return to the heartbeat loop, and whether a lease was busy. A round
// that failed has Failed set and Busy unset.
type HeartbeatRoundForTest struct {
	Started  time.Time
	Returned time.Time
	Busy     bool
	Failed   bool
}

// RecordHeartbeatRoundsForTest records each heartbeat round of worker, and returns a function that
// reads the rounds so far. Call it before the worker runs. One loop sends every round of a worker,
// so the rounds are in the order that the worker sent them.
func RecordHeartbeatRoundsForTest(worker *Worker) func() []HeartbeatRoundForTest {
	var mu sync.Mutex
	var rounds []HeartbeatRoundForTest
	send := worker.heartbeatRound
	worker.heartbeatRound = func(members []*heartbeatMember, deadline time.Time) ([]ownershipStatus, error) {
		started := time.Now()
		statuses, err := send(members, deadline)
		round := HeartbeatRoundForTest{Started: started, Returned: time.Now(), Failed: err != nil}
		for _, status := range statuses {
			round.Busy = round.Busy || (err == nil && status == workerOwnershipBusy)
		}
		mu.Lock()
		rounds = append(rounds, round)
		mu.Unlock()
		return statuses, err
	}
	return func() []HeartbeatRoundForTest {
		mu.Lock()
		defer mu.Unlock()
		return append([]HeartbeatRoundForTest(nil), rounds...)
	}
}

// FailNextHeartbeatRoundForTest makes the next heartbeat round of worker fail with err before it
// sends anything. Later rounds send their statements. Call it before the worker runs.
func FailNextHeartbeatRoundForTest(worker *Worker, err error) {
	var failed sync.Once
	send := worker.heartbeatRound
	worker.heartbeatRound = func(members []*heartbeatMember, deadline time.Time) ([]ownershipStatus, error) {
		failure := error(nil)
		failed.Do(func() { failure = err })
		if failure != nil {
			return nil, failure
		}
		return send(members, deadline)
	}
}
