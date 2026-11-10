package workhorse

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
)

// A release after the shutdown cancellation fails, as in a short database outage. The worker logs
// the catalogued event that the TypeScript and Python workers log, and lease recovery settles the
// task.
func TestWorkerLogsTheShutdownSettlementFailedEvent(t *testing.T) {
	var output bytes.Buffer
	worker := &Worker{
		workerID: "shutdown-worker",
		logger:   slog.New(slog.NewTextHandler(&output, nil)),
	}
	task := ClaimedTask{
		ID:         "11111111-1111-1111-1111-111111111111",
		Type:       "send-invoice",
		Queue:      "billing",
		Attempt:    2,
		FenceToken: 7,
	}

	outcome := worker.settleAfterShutdown(
		context.Background(),
		failingRegistryExecutor{},
		task,
		nil,
		nil,
		errors.New("handler stopped"),
	)

	if outcome != handlerOutcomeCanceled {
		t.Fatalf("expected the canceled outcome, received %v", outcome)
	}
	logged := output.String()
	for _, field := range []string{
		"level=WARN",
		`msg="Shutdown settlement failed; lease recovery will settle the task"`,
		"event.name=workhorse.worker.shutdown_settlement_failed",
		"workhorse.task.id=" + task.ID,
		"workhorse.queue.name=billing",
		"workhorse.worker.id=shutdown-worker",
		"error.type=*errors.errorString",
		`error="registry is offline"`,
	} {
		if !strings.Contains(logged, field) {
			t.Fatalf("expected %s in the warning:\n%s", field, logged)
		}
	}
}
