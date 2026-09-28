package workhorse

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// pgx decodes a jsonb column before the worker reads it, so a JSON string value arrives as a Go
// string. database/sql hands over the raw document as bytes instead.
func TestDecodedJSONKeepsADecodedStringAndDecodesRawBytes(t *testing.T) {
	for label, testCase := range map[string]struct {
		value    any
		expected any
	}{
		"decoded string":         {value: "before", expected: "before"},
		"decoded numeric string": {value: "42", expected: "42"},
		"decoded JSON text":      {value: `{"a":1}`, expected: `{"a":1}`},
		"raw string document":    {value: []byte(`"before"`), expected: "before"},
	} {
		decoded, err := decodedJSON(testCase.value)
		if err != nil || decoded != testCase.expected {
			t.Fatalf("%s: decoded %#v err=%v, expected %#v", label, decoded, err, testCase.expected)
		}
		if value := jsonValue(testCase.value); value != testCase.expected {
			t.Fatalf("%s: admin read %#v, expected %#v", label, value, testCase.expected)
		}
	}
}

func claimRow(payload any) Row {
	return Row{
		rowTaskIDField: "00000000-0000-4000-8000-000000000001", rowTaskTypeField: "payload.task",
		rowPriorityField: int32(0), rowAttemptField: int32(1), rowMaxAttemptsField: int32(3),
		rowResultMaxBytesField: int32(1024), rowFenceTokenField: int64(7),
		rowLeaseExpiresAtField: time.Now().Add(time.Minute), rowPayloadField: payload,
	}
}

type failureRecordingExecutor struct {
	statements []string
	envelopes  []string
}

func (executor *failureRecordingExecutor) Query(_ context.Context, statement string, arguments ...any) ([]Row, error) {
	executor.statements = append(executor.statements, statement)
	if statement == protocolStatementRegistry[failStatementName] {
		for _, argument := range arguments {
			if encoded, ok := argument.([]byte); ok {
				executor.envelopes = append(executor.envelopes, string(encoded))
			}
		}
		return []Row{{rowStateField: workerFailureScheduled}}, nil
	}
	return nil, nil
}

// A payload the worker cannot decode belongs to one task. Its attempt fails through the ordinary
// failure path instead of stopping the claim loop and stranding the lease.
func TestAnUndecodablePayloadFailsItsAttemptWithoutCallingTheHandler(t *testing.T) {
	task, err := claimedTask(claimRow([]byte(`{`)), "defaults")
	if err != nil {
		t.Fatalf("an undecodable payload ended the claim: %v", err)
	}
	if task.payloadError == nil {
		t.Fatal("the undecodable payload was not recorded on the task")
	}
	task.claimSentAt = time.Now()

	worker := newDefaultWorker(t, WorkerOptions{})
	called := false
	executor := &failureRecordingExecutor{}
	err = worker.execute(context.Background(), executor, task, func(context.Context, any, *HandlerContext) (any, error) {
		called = true
		return nil, nil
	})
	if err != nil {
		t.Fatalf("execute returned %v", err)
	}
	if called {
		t.Fatal("the handler ran with an undecodable payload")
	}
	if len(executor.envelopes) != 1 || !json.Valid([]byte(executor.envelopes[0])) ||
		!strings.Contains(executor.envelopes[0], "could not decode the task payload") {
		t.Fatalf("unexpected failure settlement: statements=%q envelopes=%q", executor.statements, executor.envelopes)
	}
}
