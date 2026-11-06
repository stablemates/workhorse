package workhorse

import (
	"context"
	"errors"
	"runtime"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// These tests check the busy retry of the heartbeat scheduler (SM-1443) with a fake round in place
// of the heartbeat statement. Each attempt registers through superviseOwnership, so the lease
// watchdog is the real one.

// fakeHeartbeatRound is one call of the fake round: when it started, the task IDs it sent, the
// deadline that the scheduler gave it, and the lease window end of each member when it started.
type fakeHeartbeatRound struct {
	at        time.Time
	tasks     []string
	deadline  time.Time
	leaseEnds map[string]time.Time
}

// scheduledStart is the instant at which the scheduler started a regular round. A regular round's
// deadline is that instant plus heartbeatRoundBound, so the value comes from the scheduler's own
// clock reading and not from when the fake ran.
func (round fakeHeartbeatRound) scheduledStart(worker *Worker) time.Time {
	return round.deadline.Add(-worker.heartbeatRoundBound)
}

// nextSlot is the regular slot after a regular round: its scheduled start plus one interval.
func (round fakeHeartbeatRound) nextSlot(worker *Worker) time.Time {
	return round.scheduledStart(worker).Add(worker.heartbeatInterval)
}

// fakeHeartbeat records every round and answers each one with answer, by task ID. If
// answerMembers is set, it answers each member instead, in the order of members.
type fakeHeartbeat struct {
	mu            sync.Mutex
	rounds        []fakeHeartbeatRound
	active        atomic.Int32
	maxActive     atomic.Int32
	answer        func(call int, tasks []string) (map[string]ownershipStatus, error)
	answerMembers func(members []*heartbeatMember) []ownershipStatus
}

func (fake *fakeHeartbeat) round(members []*heartbeatMember, deadline time.Time) ([]ownershipStatus, error) {
	active := fake.active.Add(1)
	defer fake.active.Add(-1)
	for {
		seen := fake.maxActive.Load()
		if active <= seen || fake.maxActive.CompareAndSwap(seen, active) {
			break
		}
	}
	tasks := make([]string, 0, len(members))
	leaseEnds := make(map[string]time.Time, len(members))
	for _, member := range members {
		tasks = append(tasks, member.task.ID)
		if end := member.leaseEnd.Load(); end != nil {
			leaseEnds[member.task.ID] = *end
		}
	}
	slices.Sort(tasks)
	fake.mu.Lock()
	call := len(fake.rounds)
	fake.rounds = append(fake.rounds, fakeHeartbeatRound{
		at: time.Now(), tasks: tasks, deadline: deadline, leaseEnds: leaseEnds,
	})
	fake.mu.Unlock()
	if fake.answerMembers != nil {
		return fake.answerMembers(members), nil
	}
	answer, err := fake.answer(call, tasks)
	if err != nil {
		return nil, err
	}
	statuses := make([]ownershipStatus, len(members))
	for index, member := range members {
		statuses[index] = answer[member.task.ID]
		if statuses[index] == emptyString {
			statuses[index] = workerOwnershipStale
		}
	}
	return statuses, nil
}

func (fake *fakeHeartbeat) snapshot() []fakeHeartbeatRound {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	return slices.Clone(fake.rounds)
}

// waitForRounds waits until the fake has seen count rounds and returns them.
func (fake *fakeHeartbeat) waitForRounds(t *testing.T, count int, within time.Duration) []fakeHeartbeatRound {
	t.Helper()
	deadline := time.Now().Add(within)
	for {
		rounds := fake.snapshot()
		if len(rounds) >= count {
			return rounds
		}
		if time.Now().After(deadline) {
			t.Fatalf("the scheduler sent %d heartbeat rounds; want %d", len(rounds), count)
		}
		time.Sleep(time.Millisecond)
	}
}

// statusesFor answers every task in tasks with status, apart from the tasks in overrides.
func statusesFor(tasks []string, status ownershipStatus, overrides map[string]ownershipStatus) map[string]ownershipStatus {
	statuses := make(map[string]ownershipStatus, len(tasks))
	for _, task := range tasks {
		statuses[task] = status
		if override, ok := overrides[task]; ok {
			statuses[task] = override
		}
	}
	return statuses
}

func newBusyHeartbeatWorker(
	t *testing.T, lease, interval time.Duration, fake *fakeHeartbeat,
) *Worker {
	t.Helper()
	worker, err := NewWorker(unconnectedPool(t), WorkerOptions{
		Queue: "busy-heartbeat", WorkerID: "busy-heartbeat-worker",
		LeaseDuration: lease, HeartbeatInterval: interval,
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.heartbeatRound = fake.round
	return worker
}

// supervisedAttempt is one attempt that the test registers for heartbeats.
type supervisedAttempt struct {
	member  func() *heartbeatMember
	cause   func() error
	aborted chan time.Time
	release func()
}

func superviseAttempt(t *testing.T, worker *Worker, id string, fence int64) *supervisedAttempt {
	t.Helper()
	ctx, cancel := context.WithCancelCause(context.Background())
	aborted := make(chan time.Time, 1)
	var abortOnce sync.Once
	cancelHandler := func(cause error) {
		abortOnce.Do(func() { aborted <- time.Now() })
		cancel(cause)
	}
	task := ClaimedTask{ID: id, FenceToken: fence, claimSentAt: time.Now()}
	_, release := worker.superviseOwnership(ctx, task, cancelHandler)
	t.Cleanup(release)
	t.Cleanup(func() { cancel(nil) })
	member := func() *heartbeatMember {
		worker.heartbeatMu.Lock()
		defer worker.heartbeatMu.Unlock()
		for member := range worker.heartbeatMembers {
			if member.task.ID == id && member.task.FenceToken == fence {
				return member
			}
		}
		return nil
	}
	return &supervisedAttempt{
		member:  member,
		cause:   func() error { return context.Cause(ctx) },
		aborted: aborted,
		release: release,
	}
}

func TestBusyRetryDelayIsTheBaseTimesOneToTwo(t *testing.T) {
	for _, testCase := range []struct {
		interval time.Duration
		base     time.Duration
	}{
		{interval: 10 * time.Second, base: 100 * time.Millisecond},
		{interval: 800 * time.Millisecond, base: 100 * time.Millisecond},
		{interval: 400 * time.Millisecond, base: 50 * time.Millisecond},
		{interval: 8 * time.Millisecond, base: time.Millisecond},
	} {
		for range 200 {
			delay := busyRetryDelay(testCase.interval)
			if delay < testCase.base || delay >= 2*testCase.base {
				t.Fatalf("interval %s gave a busy retry delay of %s; want [%s, %s)",
					testCase.interval, delay, testCase.base, 2*testCase.base)
			}
		}
	}
}

func TestABusyLeaseIsRetriedAloneBeforeTheNextRegularRound(t *testing.T) {
	const interval = 400 * time.Millisecond
	fake := &fakeHeartbeat{answer: func(call int, tasks []string) (map[string]ownershipStatus, error) {
		if call == 0 {
			return statusesFor(tasks, workerOwnershipAccepted, map[string]ownershipStatus{"busy": workerOwnershipBusy}), nil
		}
		return statusesFor(tasks, workerOwnershipAccepted, nil), nil
	}}
	worker := newBusyHeartbeatWorker(t, 4*time.Second, interval, fake)
	busy := superviseAttempt(t, worker, "busy", 1)
	superviseAttempt(t, worker, "free", 1)

	rounds := fake.waitForRounds(t, 3, 6*interval)
	if !slices.Equal(rounds[0].tasks, []string{"busy", "free"}) {
		t.Fatalf("the regular round sent %v; want both leases", rounds[0].tasks)
	}
	if !slices.Equal(rounds[1].tasks, []string{"busy"}) {
		t.Fatalf("the retry sent %v; want only the busy lease", rounds[1].tasks)
	}
	// A retry never runs past the next regular slot, so its deadline puts it inside the interval
	// of the busy round. TestBusyRetryDelayIsTheBaseTimesOneToTwo checks the delay itself. The
	// checks use the deadlines that the scheduler gave, so a slow host cannot change the result.
	slot := rounds[0].nextSlot(worker)
	if rounds[1].deadline.After(slot) {
		t.Fatalf("the busy retry had the deadline %s; want no later than the next regular slot %s",
			rounds[1].deadline, slot)
	}
	// The retry got accepted, so no further retry runs: the next round is the regular one.
	if !slices.Equal(rounds[2].tasks, []string{"busy", "free"}) {
		t.Fatalf("the round after the accepted retry sent %v; want the regular round", rounds[2].tasks)
	}
	if start := rounds[2].scheduledStart(worker); start.Before(slot) {
		t.Fatalf("the round after the accepted retry started %s before the regular slot", slot.Sub(start))
	}
	if busy.cause() != nil {
		t.Fatalf("a busy lease aborted its attempt: %v", busy.cause())
	}
}

func TestBusyRetriesKeepTheRegularSlotsAndOneRoundInFlight(t *testing.T) {
	const interval = 400 * time.Millisecond
	fake := &fakeHeartbeat{answer: func(_ int, tasks []string) (map[string]ownershipStatus, error) {
		// Each round takes a while, so a second round would overlap if the scheduler allowed it.
		time.Sleep(15 * time.Millisecond)
		return statusesFor(tasks, workerOwnershipAccepted, map[string]ownershipStatus{"busy": workerOwnershipBusy}), nil
	}}
	worker := newBusyHeartbeatWorker(t, 10*time.Second, interval, fake)
	registeredAt := time.Now()
	superviseAttempt(t, worker, "busy", 1)
	superviseAttempt(t, worker, "free", 1)

	// The test reads the rounds up to the fifth regular round, so it sees four whole intervals. It
	// compares the deadlines that the scheduler gave each round, and not the wall clock, so a slow
	// host or -race cannot change the result.
	const regularCount = 5
	var rounds, regular []fakeHeartbeatRound
	for until := time.Now().Add(4 * regularCount * interval); len(regular) < regularCount; time.Sleep(time.Millisecond) {
		if time.Now().After(until) {
			t.Fatalf("the scheduler sent %d regular rounds in %d intervals; want %d",
				len(regular), 4*regularCount, regularCount)
		}
		rounds, regular = nil, nil
		for _, round := range fake.snapshot() {
			if len(regular) == regularCount {
				break
			}
			rounds = append(rounds, round)
			if len(round.tasks) == 2 {
				regular = append(regular, round)
			}
		}
	}
	if len(rounds[0].tasks) != 2 {
		t.Fatalf("the first round sent %v; want the regular round with both leases", rounds[0].tasks)
	}
	// The first slot is one interval after the heartbeat loop starts, which is after registeredAt.
	first := regular[0].scheduledStart(worker)
	if first.Before(registeredAt.Add(interval)) {
		t.Fatalf("the first regular round started %s after the registration; want at least %s",
			first.Sub(registeredAt), interval)
	}
	// Each retry ends by the slot after the regular round before it, which is the regular start
	// plus one interval. A correct scheduler meets this at any timing, because a retry deadline is
	// never later than the scheduler's next slot. A retry that moved the slot later, or a schedule
	// that drifts, gives a later retry a deadline after it.
	// TestABusyRetryDeadlineIsTheEarliestOfTheBoundTheSlotAndTheWindowEnd checks the cap itself.
	retries := 0
	var slot time.Time
	for _, round := range rounds {
		if len(round.tasks) == 2 {
			slot = round.nextSlot(worker)
			continue
		}
		if !slices.Equal(round.tasks, []string{"busy"}) {
			t.Fatalf("a retry sent %v; want only the busy lease", round.tasks)
		}
		if round.deadline.After(slot) {
			t.Fatalf("a busy retry had the deadline %s; want no later than the regular slot %s",
				round.deadline, slot)
		}
		retries++
	}
	if retries < 4 {
		t.Fatalf("the scheduler sent %d busy retries in four intervals; want at least 4", retries)
	}
	// A regular round never starts before its slot. The scheduler counts each slot from the
	// start of the round before it, so a timer delay moves every later slot too. The delays of
	// all rounds add up, so the test bounds the start of each regular round against the first
	// one. Timer and scheduler delay over four intervals stays well under half an interval on a
	// loaded host or with -race. A schedule that drifts more than one eighth of an interval in
	// each round goes past that bound. Less drift than that, or one delay of almost half an
	// interval, passes: the bound gives up that much to stay free of host timing.
	for index := 1; index < len(regular); index++ {
		start := regular[index].scheduledStart(worker)
		if late := start.Sub(regular[index-1].nextSlot(worker)); late < 0 {
			t.Fatalf("regular round %d started %s before its slot", index+1, -late)
		}
		ideal := first.Add(time.Duration(index) * interval)
		if drift := start.Sub(ideal); drift >= interval/2 {
			t.Fatalf("regular round %d started %s after %d intervals from the first regular round; want less than %s",
				index+1, drift, index, interval/2)
		}
	}
	if overlap := fake.maxActive.Load(); overlap != 1 {
		t.Fatalf("%d heartbeat rounds were in flight at once; want 1", overlap)
	}
}

func TestContinuousBusyLetsTheWatchdogEndTheAttemptAtTheLeaseEnd(t *testing.T) {
	const lease = 600 * time.Millisecond
	fake := &fakeHeartbeat{answer: func(_ int, tasks []string) (map[string]ownershipStatus, error) {
		return statusesFor(tasks, workerOwnershipBusy, nil), nil
	}}
	worker := newBusyHeartbeatWorker(t, lease, 150*time.Millisecond, fake)
	attempt := superviseAttempt(t, worker, "busy", 1)
	member := attempt.member()
	if member == nil {
		t.Fatal("the attempt did not register for heartbeats")
	}
	// The claim opened this lease window. The watchdog arms its timer at its end.
	window := *member.leaseEnd.Load()

	var abortedAt time.Time
	select {
	case abortedAt = <-attempt.aborted:
	case <-time.After(3 * lease):
		t.Fatal("the watchdog did not end an attempt whose lease was busy for a whole lease")
	}
	var lost *LeaseLostError
	if !errors.As(attempt.cause(), &lost) {
		t.Fatalf("the attempt ended with %v; want a lease loss", attempt.cause())
	}
	// The busy results renewed nothing, so the watchdog fires at the end of the window that the
	// claim opened, and not before it. Each round started with that same window end. These checks
	// compare the window end that the worker stores, so a slow host cannot change the result. A
	// late abort comes only from timer and scheduler delay, which stays under half a lease.
	if abortedAt.Before(window) {
		t.Fatalf("the watchdog ended the attempt %s before the end of the lease window", window.Sub(abortedAt))
	}
	if late := abortedAt.Sub(window); late >= lease/2 {
		t.Fatalf("the watchdog ended the attempt %s after the end of the lease window; want less than %s",
			late, lease/2)
	}
	rounds := fake.snapshot()
	if len(rounds) < 5 {
		t.Fatalf("the scheduler sent %d rounds during the lease; want busy retries", len(rounds))
	}
	for index, round := range rounds {
		if end := round.leaseEnds["busy"]; !end.Equal(window) {
			t.Fatalf("round %d started with the lease window end %s; want the claim's window end %s",
				index, end, window)
		}
	}
}

func TestABusyResultForALeaseThatWasReplacedDuringTheRoundStartsNoRetry(t *testing.T) {
	const interval = 300 * time.Millisecond
	entered := make(chan struct{})
	proceed := make(chan struct{})
	fake := &fakeHeartbeat{answer: func(call int, tasks []string) (map[string]ownershipStatus, error) {
		if call == 0 {
			close(entered)
			<-proceed
		}
		return statusesFor(tasks, workerOwnershipBusy, nil), nil
	}}
	worker := newBusyHeartbeatWorker(t, 4*time.Second, interval, fake)
	first := superviseAttempt(t, worker, "task", 1)
	select {
	case <-entered:
	case <-time.After(3 * interval):
		t.Fatal("the scheduler sent no round")
	}
	// The attempt leaves and a new attempt of the same task registers while the round runs.
	first.release()
	superviseAttempt(t, worker, "task", 2)
	close(proceed)

	rounds := fake.waitForRounds(t, 2, 3*interval)
	// The busy result belongs to the old attempt, so it starts no retry. The new attempt's first
	// round is the next regular one.
	if gap := rounds[1].at.Sub(rounds[0].at); gap < interval-20*time.Millisecond {
		t.Fatalf("the next round came %s after the replaced round; want the regular slot", gap)
	}
}

func TestAnAcceptedResultForAReplacedLeaseDoesNotMoveTheNewWatchdog(t *testing.T) {
	const interval = 300 * time.Millisecond
	entered := make(chan struct{})
	proceed := make(chan struct{})
	answered := make(chan struct{})
	fake := &fakeHeartbeat{answer: func(call int, tasks []string) (map[string]ownershipStatus, error) {
		if call == 0 {
			close(entered)
			<-proceed
			defer close(answered)
			return statusesFor(tasks, workerOwnershipAccepted, nil), nil
		}
		// Later rounds report busy, which never moves a watchdog.
		return statusesFor(tasks, workerOwnershipBusy, nil), nil
	}}
	worker := newBusyHeartbeatWorker(t, 4*time.Second, interval, fake)
	first := superviseAttempt(t, worker, "task", 1)
	select {
	case <-entered:
	case <-time.After(3 * interval):
		t.Fatal("the scheduler sent no round")
	}
	first.release()
	second := superviseAttempt(t, worker, "task", 2)
	endBefore := *second.member().leaseEnd.Load()
	close(proceed)
	awaitSignal(t, answered, "the held round to answer")
	time.Sleep(50 * time.Millisecond)
	if member := second.member(); member == nil || !member.leaseEnd.Load().Equal(endBefore) {
		t.Fatal("an accepted result for the replaced attempt moved the new attempt's watchdog")
	}
}

func TestEachResultOfARoundGoesToTheMemberThatItBelongsTo(t *testing.T) {
	const interval = 100 * time.Millisecond
	answered := make(chan struct{})
	var once sync.Once
	fake := &fakeHeartbeat{answerMembers: func(members []*heartbeatMember) []ownershipStatus {
		// PostgreSQL renews only the current fence, so the old attempt's lease is stale.
		statuses := make([]ownershipStatus, len(members))
		for index, member := range members {
			statuses[index] = workerOwnershipStale
			if member.task.FenceToken == 2 {
				statuses[index] = workerOwnershipAccepted
			}
		}
		if len(members) == 2 {
			once.Do(func() { close(answered) })
		}
		return statuses
	}}
	worker := newBusyHeartbeatWorker(t, 4*time.Second, interval, fake)
	// The old attempt has not unregistered yet when the new attempt of the same task registers.
	old := superviseAttempt(t, worker, "task", 1)
	current := superviseAttempt(t, worker, "task", 2)
	endBefore := *current.member().leaseEnd.Load()
	select {
	case <-answered:
	case <-time.After(5 * interval):
		t.Fatal("the scheduler sent no round with both members")
	}
	select {
	case <-old.aborted:
	case <-time.After(5 * interval):
		t.Fatal("a stale result did not end the old attempt")
	}
	var lost *LeaseLostError
	if !errors.As(old.cause(), &lost) {
		t.Fatalf("the old attempt ended with %v; want a lost lease", old.cause())
	}
	// The round applies each status in the order of its members, so the renewal can come after
	// the old attempt ends.
	deadline := time.Now().Add(5 * interval)
	for {
		if member := current.member(); member != nil && member.leaseEnd.Load().After(endBefore) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the accepted result did not move the current attempt's watchdog")
		}
		time.Sleep(time.Millisecond)
	}
	select {
	case <-current.aborted:
		t.Fatalf("the current attempt ended with %v; its lease was renewed", current.cause())
	default:
	}
}

func TestABusyLeaseThatLeftBeforeItsRetryStartsNoEarlyRound(t *testing.T) {
	const interval = 400 * time.Millisecond
	fake := &fakeHeartbeat{answer: func(call int, tasks []string) (map[string]ownershipStatus, error) {
		if call == 0 {
			return statusesFor(tasks, workerOwnershipAccepted, map[string]ownershipStatus{"busy": workerOwnershipBusy}), nil
		}
		return statusesFor(tasks, workerOwnershipAccepted, nil), nil
	}}
	worker := newBusyHeartbeatWorker(t, 4*time.Second, interval, fake)
	busy := superviseAttempt(t, worker, "busy", 1)
	superviseAttempt(t, worker, "free", 1)
	fake.waitForRounds(t, 1, 3*interval)
	// The busy attempt completes before its retry falls due.
	busy.release()

	rounds := fake.waitForRounds(t, 2, 3*interval)
	if gap := rounds[1].at.Sub(rounds[0].at); gap < interval-20*time.Millisecond {
		t.Fatalf("the scheduler sent a round %s after the busy round; want the regular slot", gap)
	}
	if !slices.Equal(rounds[1].tasks, []string{"free"}) {
		t.Fatalf("the regular round sent %v; want only the remaining lease", rounds[1].tasks)
	}
}

func TestAFailedBusyRetrySchedulesNoFurtherRetry(t *testing.T) {
	const interval = 400 * time.Millisecond
	fake := &fakeHeartbeat{answer: func(call int, tasks []string) (map[string]ownershipStatus, error) {
		switch call {
		case 0:
			return statusesFor(tasks, workerOwnershipBusy, nil), nil
		case 1:
			return nil, errors.New("the busy retry failed")
		default:
			return statusesFor(tasks, workerOwnershipAccepted, nil), nil
		}
	}}
	worker := newBusyHeartbeatWorker(t, 4*time.Second, interval, fake)
	attempt := superviseAttempt(t, worker, "busy", 1)

	rounds := fake.waitForRounds(t, 3, 4*interval)
	// A retry never runs past the next regular slot, so its deadline puts it inside the interval
	// of the busy round.
	if slot := rounds[0].nextSlot(worker); rounds[1].deadline.After(slot) {
		t.Fatalf("the busy retry had the deadline %s; want no later than the next regular slot %s",
			rounds[1].deadline, slot)
	}
	// The failed retry left no retry behind, so the next round is the regular one.
	if gap := rounds[2].at.Sub(rounds[0].at); gap < interval-20*time.Millisecond {
		t.Fatalf("the round after the failed retry came %s after the regular round; want %s", gap, interval)
	}
	if attempt.cause() != nil {
		t.Fatalf("a failed busy retry aborted the attempt: %v", attempt.cause())
	}
}

// TestARenewalAndABusyRetrySelectionDoNotRace pins that the supervising goroutine publishes each
// lease window end as a new value. A delayed supervisor applies accepted renewals while the
// heartbeat loop selects a busy retry, which reads the window end. Run it with -race.
func TestARenewalAndABusyRetrySelectionDoNotRace(t *testing.T) {
	fake := &fakeHeartbeat{answer: func(_ int, tasks []string) (map[string]ownershipStatus, error) {
		return statusesFor(tasks, workerOwnershipBusy, nil), nil
	}}
	// The regular slot falls due long after the test, so only the test reads the window end.
	worker := newBusyHeartbeatWorker(t, time.Minute, 30*time.Second, fake)
	attempt := superviseAttempt(t, worker, "task", 1)
	member := attempt.member()
	if member == nil {
		t.Fatal("the attempt did not register for heartbeats")
	}
	stop := make(chan struct{})
	renewed := make(chan struct{})
	go func() {
		defer close(renewed)
		for {
			select {
			case <-stop:
				return
			default:
				member.renew(time.Now())
				runtime.Gosched()
			}
		}
	}()
	next := time.Now().Add(time.Minute)
	until := time.Now().Add(200 * time.Millisecond)
	for time.Now().Before(until) {
		selection, deadline := worker.busyRetrySelection([]*heartbeatMember{member}, time.Now(), next)
		if len(selection) != 1 || !deadline.After(time.Now()) {
			t.Fatalf("a live busy lease was left out of its retry: %d selected, deadline %s", len(selection), deadline)
		}
	}
	close(stop)
	awaitSignal(t, renewed, "the renewal goroutine to stop")
	if attempt.cause() != nil {
		t.Fatalf("the renewals ended the attempt: %v", attempt.cause())
	}
}

func TestTheBusyRetryMinimumIsTheRoundMinimumPlusItsMargin(t *testing.T) {
	if busyRetryMinimum != 20*time.Millisecond {
		t.Fatalf("busyRetryMinimum = %s; want %s + %s = 20 ms", busyRetryMinimum, minimumRoundRemaining, busyRetryMargin)
	}
}

func TestABusyRetrySelectionNeedsTheMinimumBeforeItsDeadline(t *testing.T) {
	fake := &fakeHeartbeat{answer: func(_ int, tasks []string) (map[string]ownershipStatus, error) {
		return statusesFor(tasks, workerOwnershipBusy, nil), nil
	}}
	// The regular slot falls due long after the test, so the window end does not move.
	worker := newBusyHeartbeatWorker(t, time.Minute, 30*time.Second, fake)
	member := superviseAttempt(t, worker, "task", 1).member()
	if member == nil {
		t.Fatal("the attempt did not register for heartbeats")
	}
	end := *member.leaseEnd.Load()
	busy := []*heartbeatMember{member}
	for _, testCase := range []struct {
		name string
		now  time.Time
		next time.Time
		runs bool
	}{
		{"the next regular slot 10 ms after the retry", end.Add(-time.Second), end.Add(-time.Second + 10*time.Millisecond), false},
		{"the next regular slot 1 ms short of the minimum", end.Add(-time.Second), end.Add(-time.Second + busyRetryMinimum - time.Millisecond), false},
		{"the next regular slot at the minimum", end.Add(-time.Second), end.Add(-time.Second + busyRetryMinimum), true},
		{"the lease window end 10 ms after the retry", end.Add(-10 * time.Millisecond), end.Add(time.Minute), false},
		{"the lease window end at the minimum", end.Add(-busyRetryMinimum), end.Add(time.Minute), true},
	} {
		selection, _ := worker.busyRetrySelection(busy, testCase.now, testCase.next)
		if runs := len(selection) == 1; runs != testCase.runs {
			t.Errorf("%s: the retry runs = %t; want %t", testCase.name, runs, testCase.runs)
		}
	}
}

func TestABusyRetryDeadlineIsTheEarliestOfTheBoundTheSlotAndTheWindowEnd(t *testing.T) {
	fake := &fakeHeartbeat{answer: func(_ int, tasks []string) (map[string]ownershipStatus, error) {
		return statusesFor(tasks, workerOwnershipBusy, nil), nil
	}}
	// The regular slot falls due long after the test, so the window end does not move. The test
	// gives each instant, so no timer or scheduler delay can change the result.
	worker := newBusyHeartbeatWorker(t, time.Minute, 30*time.Second, fake)
	member := superviseAttempt(t, worker, "task", 1).member()
	if member == nil {
		t.Fatal("the attempt did not register for heartbeats")
	}
	end := *member.leaseEnd.Load()
	bound := worker.heartbeatRoundBound
	busy := []*heartbeatMember{member}
	for _, testCase := range []struct {
		name string
		now  time.Time
		next time.Time
		want time.Time
	}{
		{"the next regular slot before the round bound", end.Add(-40 * time.Second), end.Add(-39 * time.Second), end.Add(-39 * time.Second)},
		{"the round bound before the next regular slot", end.Add(-40 * time.Second), end.Add(-40*time.Second + bound + time.Second), end.Add(-40*time.Second + bound)},
		{"the lease window end before the bound and the slot", end.Add(-time.Second), end.Add(time.Minute), end},
	} {
		selection, deadline := worker.busyRetrySelection(busy, testCase.now, testCase.next)
		if len(selection) != 1 {
			t.Errorf("%s: the retry selected %d leases; want 1", testCase.name, len(selection))
		}
		if !deadline.Equal(testCase.want) {
			t.Errorf("%s: the retry deadline is %s after now; want %s",
				testCase.name, deadline.Sub(testCase.now), testCase.want.Sub(testCase.now))
		}
	}
}

func TestABusyRetryWithoutTheMinimumBeforeTheNextSlotLeavesTheLeaseToTheRegularRound(t *testing.T) {
	// A busy retry falls due 2 to 4 ms after a round, and the next regular slot is 16 ms after it.
	// So no retry has the minimum before its deadline, and every round is a regular round.
	const interval = 16 * time.Millisecond
	fake := &fakeHeartbeat{answer: func(call int, tasks []string) (map[string]ownershipStatus, error) {
		if call == 0 {
			return statusesFor(tasks, workerOwnershipAccepted, map[string]ownershipStatus{"busy": workerOwnershipBusy}), nil
		}
		return statusesFor(tasks, workerOwnershipAccepted, nil), nil
	}}
	worker := newBusyHeartbeatWorker(t, 4*time.Second, interval, fake)
	busy := superviseAttempt(t, worker, "busy", 1)
	superviseAttempt(t, worker, "free", 1)
	member := busy.member()
	if member == nil {
		t.Fatal("the attempt did not register for heartbeats")
	}
	endBefore := *member.leaseEnd.Load()

	rounds := fake.waitForRounds(t, 4, 100*interval)
	for index, round := range rounds {
		if !slices.Equal(round.tasks, []string{"busy", "free"}) {
			t.Fatalf("round %d sent %v; want the regular round with both leases", index, round.tasks)
		}
	}
	if gap := rounds[1].at.Sub(rounds[0].at); gap < interval-4*time.Millisecond {
		t.Fatalf("the round after the busy round came %s after it; want the regular slot", gap)
	}
	// The regular round after the busy round renewed the busy lease. The supervisor applies the
	// renewal, so the test waits for it.
	for until := time.Now().Add(time.Second); !member.leaseEnd.Load().After(endBefore); {
		if time.Now().After(until) {
			t.Fatal("the regular round did not renew the lease that the skipped retry left")
		}
		time.Sleep(time.Millisecond)
	}
	if busy.cause() != nil {
		t.Fatalf("a skipped busy retry aborted the attempt: %v", busy.cause())
	}
}
