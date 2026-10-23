package workhorse

import (
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// reporterFailureInterval bounds the log output of a reporter callback that always fails: the
// worker logs at most one failure of each callback in this interval.
const reporterFailureInterval = time.Minute

// reporterFailures records when the worker last logged a failure of one reporter callback.
type reporterFailures struct {
	mu         sync.Mutex
	reported   bool
	reportedAt time.Time
	// Failures since reportedAt that the worker did not log.
	suppressed int
}

// admit reports whether the worker logs this failure, and how many failures it did not log since
// the last one it logged.
func (failures *reporterFailures) admit(now time.Time) (bool, int) {
	failures.mu.Lock()
	defer failures.mu.Unlock()
	if failures.reported && now.Sub(failures.reportedAt) < reporterFailureInterval {
		failures.suppressed++
		return false, 0
	}
	suppressed := failures.suppressed
	failures.reported, failures.reportedAt, failures.suppressed = true, now, 0
	return true, suppressed
}

// callReporter calls an application reporter callback so that its panic never reaches the run. A
// reporter observes the worker. It is not part of the dispatch contract, so its failure must not
// stop claims or change the result of the run. The logger is the diagnostic path, so the worker
// never calls the failed reporter again for its own failure.
func callReporter(logger *slog.Logger, name string, failures *reporterFailures, call func()) {
	defer func() {
		if failure := recover(); failure != nil {
			reportReporterFailure(logger, name, failures, failure)
		}
	}()
	call()
}

func reportReporterFailure(logger *slog.Logger, name string, failures *reporterFailures, failure any) {
	report, suppressed := failures.admit(time.Now())
	if !report {
		return
	}
	// A logger handler can panic too. The diagnostic path must not become a second failure.
	defer func() { _ = recover() }()
	var detail string
	if suppressed > 0 {
		detail = fmt.Sprintf(reporterFailureDetail, suppressed)
	}
	logger.Error(fmt.Sprintf(reporterFailureMessage, name, detail), reporterFailureErrorKey, failure)
}
