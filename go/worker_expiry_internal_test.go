package workhorse

import (
	"context"
	"errors"
	"testing"
	"time"
)

// These tests order the answer of the supervisor's expire_owned request against heartbeat answers
// (SM-1651). A fake round replaces the heartbeat statement, and a fake request replaces
// expire_owned, so each test controls which answer arrives first.

// expiringAttempt is one attempt whose execution timeout is already due on the worker clock.
type expiringAttempt struct {
	cause    func() error
	returned func() ownershipResult
	release  func()
}

func superviseExpiringAttempt(t *testing.T, worker *Worker, id string) *expiringAttempt {
	t.Helper()
	// The run context stays live, so only the supervisor can end the expiry request.
	run, stop := context.WithCancel(context.Background())
	handler, cancel := context.WithCancelCause(context.Background())
	due := time.Now()
	task := ClaimedTask{ID: id, FenceToken: 1, Attempt: 1, AttemptTimeout: &due, claimSentAt: time.Now()}
	returned, release := worker.superviseOwnership(run, task, cancel)
	t.Cleanup(stop)
	t.Cleanup(release)
	t.Cleanup(func() { cancel(nil) })
	return &expiringAttempt{
		cause:    func() error { return context.Cause(handler) },
		returned: returned,
		release:  release,
	}
}

// blockedExpiry is a fake expire_owned request that waits for the test's answer.
type blockedExpiry struct {
	asked   chan struct{}
	answers chan ownershipStatus
}

func newBlockedExpiry() *blockedExpiry {
	return &blockedExpiry{asked: make(chan struct{}, 8), answers: make(chan ownershipStatus, 1)}
}

func (expiry *blockedExpiry) request(ctx context.Context, _ ClaimedTask) (ownershipStatus, error) {
	expiry.asked <- struct{}{}
	select {
	case status := <-expiry.answers:
		return status, nil
	case <-ctx.Done():
		return emptyString, ctx.Err()
	}
}

func waitFor(t *testing.T, signal <-chan struct{}, message string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(5 * time.Second):
		t.Fatal(message)
	}
}

// waitForUnregistered waits until no attempt of worker is in the heartbeat batch.
func waitForUnregistered(t *testing.T, worker *Worker) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		worker.heartbeatMu.Lock()
		registered := len(worker.heartbeatMembers)
		worker.heartbeatMu.Unlock()
		if registered == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("the supervisor never received the stale heartbeat answer")
		}
		time.Sleep(time.Millisecond)
	}
}

// A stale heartbeat answer that arrives while the request runs does not cancel the handler. The
// expiry answer then selects the cause: a confirmed timeout, or a lost lease for not_due.
func TestAStaleHeartbeatDuringAnExpiryRequestWaitsForTheExpiryAnswer(t *testing.T) {
	for _, testCase := range []struct {
		answer  ownershipStatus
		status  ownershipStatus
		cause   error
		settled bool
	}{
		{answer: workerOwnershipTimeout, status: workerOwnershipTimeout, cause: ErrExecutionTimeout, settled: true},
		{answer: workerOwnershipNotDue, status: workerOwnershipStale, cause: ErrLeaseLost},
	} {
		t.Run(string(testCase.answer), func(t *testing.T) {
			expiry := newBlockedExpiry()
			staleSent := make(chan struct{})
			fake := &fakeHeartbeat{answerMembers: func(members []*heartbeatMember) []ownershipStatus {
				statuses := make([]ownershipStatus, len(members))
				for index, member := range members {
					statuses[index] = workerOwnershipAccepted
					if member.expiring.Load() {
						statuses[index] = workerOwnershipStale
						defer func() {
							select {
							case <-staleSent:
							default:
								close(staleSent)
							}
						}()
					}
				}
				return statuses
			}}
			worker := newBusyHeartbeatWorker(t, 4*time.Second, 20*time.Millisecond, fake)
			worker.expireOwned = expiry.request
			attempt := superviseExpiringAttempt(t, worker, "expiring")

			waitFor(t, expiry.asked, "the supervisor never asked PostgreSQL to expire the attempt")
			waitFor(t, staleSent, "no heartbeat round answered stale during the request")
			// The supervisor leaves the heartbeat batch when it receives the stale answer, so the
			// expiry answer below arrives after it.
			waitForUnregistered(t, worker)
			if cause := attempt.cause(); cause != nil {
				t.Fatalf("the handler was cancelled before the expiry answer: %v", cause)
			}
			expiry.answers <- testCase.answer
			result := attempt.returned()
			if result.status != testCase.status || result.expirationSettled != testCase.settled {
				t.Fatalf("ownership %+v; want status %s, settled %t", result, testCase.status, testCase.settled)
			}
			if cause := attempt.cause(); !errors.Is(cause, testCase.cause) {
				t.Fatalf("the handler was cancelled with %v; want %v", cause, testCase.cause)
			}
		})
	}
}

// A not_due answer leaves the handler running and renewing, and the supervisor asks again.
func TestANotDueExpiryKeepsTheHandlerRunningAndAsksAgain(t *testing.T) {
	expiry := newBlockedExpiry()
	fake := &fakeHeartbeat{answer: func(_ int, tasks []string) (map[string]ownershipStatus, error) {
		return statusesFor(tasks, workerOwnershipAccepted, nil), nil
	}}
	worker := newBusyHeartbeatWorker(t, 4*time.Second, 20*time.Millisecond, fake)
	worker.expireOwned = expiry.request
	attempt := superviseExpiringAttempt(t, worker, "not-due")

	waitFor(t, expiry.asked, "the supervisor never asked PostgreSQL to expire the attempt")
	expiry.answers <- workerOwnershipNotDue
	waitFor(t, expiry.asked, "the supervisor did not ask again after not_due")
	rounds := len(fake.snapshot())
	fake.waitForRounds(t, rounds+2, 5*time.Second)
	if cause := attempt.cause(); cause != nil {
		t.Fatalf("a not_due answer cancelled the handler: %v", cause)
	}
	expiry.answers <- workerOwnershipDeadline
	if result := attempt.returned(); result.status != workerOwnershipDeadline || !result.expirationSettled {
		t.Fatalf("ownership %+v; want a settled deadline", result)
	}
	if cause := attempt.cause(); !errors.Is(cause, ErrDeadlineExceeded) {
		t.Fatalf("the handler was cancelled with %v; want the deadline", cause)
	}
}

// The request ends with the supervisor, so a blocked request does not outlive its attempt.
func TestAnExpiryRequestEndsWhenTheLeaseWatchdogEndsTheAttempt(t *testing.T) {
	ended := make(chan struct{})
	asked := make(chan struct{})
	fake := &fakeHeartbeat{answer: func(_ int, tasks []string) (map[string]ownershipStatus, error) {
		return statusesFor(tasks, workerOwnershipBusy, nil), nil
	}}
	worker := newBusyHeartbeatWorker(t, minimumWorkerLease, 20*time.Millisecond, fake)
	worker.expireOwned = func(ctx context.Context, _ ClaimedTask) (ownershipStatus, error) {
		close(asked)
		<-ctx.Done()
		close(ended)
		return emptyString, ctx.Err()
	}
	attempt := superviseExpiringAttempt(t, worker, "watchdog")

	waitFor(t, asked, "the supervisor never asked PostgreSQL to expire the attempt")
	waitFor(t, ended, "the expiry request outlived the attempt that the watchdog ended")
	if cause := attempt.cause(); !errors.Is(cause, ErrLeaseLost) {
		t.Fatalf("the handler was cancelled with %v; want a lost lease", cause)
	}
}
