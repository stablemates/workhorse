package workhorse

import (
	"testing"
	"time"
)

// SignalDeadlineForTest bounds each wait of a test on a signal from another goroutine, such as a
// handler that starts or a worker run that returns. A wait that reaches it fails the test instead
// of waiting for the go test timeout.
const SignalDeadlineForTest = time.Minute

// AwaitSignalForTest returns the next value from signal. If no value arrives within
// SignalDeadlineForTest, it calls each function in onTimeout, for example the stop of a running
// worker. Then it fails the test with waitingFor. Call it only from the test goroutine.
func AwaitSignalForTest[T any](t testing.TB, signal <-chan T, waitingFor string, onTimeout ...func()) T {
	t.Helper()
	deadline := time.NewTimer(SignalDeadlineForTest)
	defer deadline.Stop()
	select {
	case value := <-signal:
		return value
	case <-deadline.C:
		for _, release := range onTimeout {
			release()
		}
		t.Fatalf("no signal after %s: the test waited for %s", SignalDeadlineForTest, waitingFor)
		panic("unreachable")
	}
}

// awaitSignal is AwaitSignalForTest for the tests inside the package.
func awaitSignal[T any](t testing.TB, signal <-chan T, waitingFor string, onTimeout ...func()) T {
	t.Helper()
	return AwaitSignalForTest(t, signal, waitingFor, onTimeout...)
}
