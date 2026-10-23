package workhorse

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"
)

// failingRegistryExecutor fails every registry write, as a short database outage does.
type failingRegistryExecutor struct{}

func (failingRegistryExecutor) Query(context.Context, string, ...any) ([]Row, error) {
	return nil, errors.New("registry is offline")
}

func reporterTestWorker(output *bytes.Buffer, reporter func(error)) *Worker {
	return &Worker{
		registryEnabled:     true,
		logger:              slog.New(slog.NewTextHandler(output, nil)),
		onRegistrationError: reporter,
	}
}

func TestWorkerIsolatesAPanickingRegistrationReporter(t *testing.T) {
	var output bytes.Buffer
	calls := 0
	worker := reporterTestWorker(&output, func(error) {
		calls++
		panic("alert client is offline")
	})

	for range 3 {
		worker.refreshRegistration(context.Background(), failingRegistryExecutor{}, false)
	}

	if calls != 3 {
		t.Fatalf("expected the reporter for each failed registration, received %d calls", calls)
	}
	if worker.registered.Load() {
		t.Fatal("a failed registration must not mark the worker registered")
	}
	logged := output.String()
	if count := strings.Count(logged, "Workhorse worker OnRegistrationError reporter failed"); count != 1 {
		t.Fatalf("expected one bounded report, received %d:\n%s", count, logged)
	}
	if !strings.Contains(logged, "alert client is offline") {
		t.Fatalf("expected the panic value in the report:\n%s", logged)
	}

	// After the interval, the next report states the failures that the worker did not log.
	worker.registrationReporter.reportedAt = time.Now().Add(-reporterFailureInterval)
	worker.refreshRegistration(context.Background(), failingRegistryExecutor{}, false)
	if !strings.Contains(output.String(), "reporter failed after 2 unreported failures") {
		t.Fatalf("expected the count of unreported failures:\n%s", output.String())
	}
}

func TestWorkerIgnoresAPanickingLoggerForAReporterFailure(t *testing.T) {
	worker := &Worker{
		registryEnabled:     true,
		logger:              slog.New(panickingHandler{}),
		onRegistrationError: func(error) { panic("alert client is offline") },
	}

	worker.refreshRegistration(context.Background(), failingRegistryExecutor{}, false)
}

type panickingHandler struct{ slog.Handler }

func (panickingHandler) Enabled(context.Context, slog.Level) bool { return true }

func (panickingHandler) Handle(context.Context, slog.Record) error { panic("handler failed") }
