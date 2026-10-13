package workhorse

import (
	"context"
	"errors"
	"math"
	"strings"
	"sync"
	"testing"
	"time"
)

// checkpointInputExecutor returns the stored checkpoint row of a name, or nothing, and answers each
// save with the configured row. It records the arguments of each save. A saved row becomes the
// stored row of its name, so a call that starts after the save reads it.
type checkpointInputExecutor struct {
	mutex  sync.Mutex
	stored map[string]Row
	saved  Row
	saves  [][]any
}

func (executor *checkpointInputExecutor) Query(_ context.Context, statement string, arguments ...any) ([]Row, error) {
	executor.mutex.Lock()
	defer executor.mutex.Unlock()
	switch statement {
	case adminStatementRegistry[getCheckpointStatementName]:
		if stored, ok := executor.stored[arguments[1].(string)]; ok {
			return []Row{stored}, nil
		}
		return nil, nil
	case protocolStatementRegistry[saveCheckpointStatementName]:
		executor.saves = append(executor.saves, arguments)
		if executor.saved[rowStatusField] == durableSavedValue {
			if executor.stored == nil {
				executor.stored = make(map[string]Row)
			}
			executor.stored[arguments[3].(string)] = Row{
				rowCheckpointValueField: executor.saved[rowCheckpointValueField], rowInputFingerprintField: arguments[5],
			}
		}
		return []Row{executor.saved}, nil
	default:
		return nil, errors.New("unexpected statement " + statement)
	}
}

func newCheckpointInputHandler(executor Executor) *HandlerContext {
	return &HandlerContext{
		Task:     ClaimedTask{ID: "task", Queue: "defaults", FenceToken: 1},
		context:  context.Background(),
		executor: executor,
		workerID: "worker",
	}
}

var (
	chargeInput     = map[string]any{"amountCents": 1000, "currency": "EUR"}
	discountedInput = map[string]any{"amountCents": 900, "currency": "EUR"}
)

const chargeFingerprint = "f5e4dce1a6a38b7186257335fb274c4221391505f139b60596c5f57ce4924471"

// storedCharge stores the charge-card checkpoint with the given fingerprint.
func storedCharge(fingerprint any) map[string]Row {
	return map[string]Row{"charge-card": {
		rowCheckpointValueField: []byte(`{"charged":1000}`), rowInputFingerprintField: fingerprint,
	}}
}

func refusedOperation(t *testing.T) func() (any, error) {
	return func() (any, error) {
		t.Error("the operation ran")
		return nil, nil
	}
}

func requireStoredCharge(t *testing.T, value any, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
	if charged, _ := value.(map[string]any)["charged"].(float64); charged != 1000 {
		t.Fatalf("returned %#v, want the stored value", value)
	}
}

func requireInputConflict(t *testing.T, err error, stored, requested string) {
	t.Helper()
	var conflict *CheckpointInputConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("returned %v, want CheckpointInputConflictError", err)
	}
	want := CheckpointInputConflictError{
		TaskID: "task", CheckpointName: "charge-card", StoredFingerprint: stored, RequestedFingerprint: requested,
	}
	if *conflict != want {
		t.Fatalf("conflict %#v, want %#v", *conflict, want)
	}
	if err.Error() != "checkpoint charge-card for task task stores the result of a different input" {
		t.Fatalf("message %q", err.Error())
	}
	if name := durableReplayConflictName(err); name != "CheckpointInputConflictError" {
		t.Fatalf("the worker names the conflict %q", name)
	}
}

func TestCheckpointReturnsTheStoredValueWhenTheInputMatches(t *testing.T) {
	handler := newCheckpointInputHandler(&checkpointInputExecutor{stored: storedCharge(chargeFingerprint)})
	value, err := handler.Checkpoint("charge-card", refusedOperation(t), CheckpointOptions{
		Input: map[string]any{"currency": "EUR", "amountCents": 1000.0},
	})
	requireStoredCharge(t, value, err)
}

func TestCheckpointRefusesAStoredValueForADifferentInput(t *testing.T) {
	handler := newCheckpointInputHandler(&checkpointInputExecutor{stored: storedCharge(chargeFingerprint)})
	_, err := handler.Checkpoint("charge-card", refusedOperation(t), CheckpointOptions{Input: discountedInput})
	requireInputConflict(t, err, chargeFingerprint, mustFingerprint(t, discountedInput))
}

func TestCheckpointWithoutAnInputComparesNothing(t *testing.T) {
	handler := newCheckpointInputHandler(&checkpointInputExecutor{stored: storedCharge(chargeFingerprint)})
	value, err := handler.Checkpoint("charge-card", refusedOperation(t))
	requireStoredCharge(t, value, err)
	value, err = handler.Checkpoint("charge-card", refusedOperation(t), CheckpointOptions{})
	requireStoredCharge(t, value, err)
}

func TestCheckpointStoredWithoutAFingerprintAcceptsAnyInput(t *testing.T) {
	handler := newCheckpointInputHandler(&checkpointInputExecutor{stored: storedCharge(nil)})
	value, err := handler.Checkpoint("charge-card", refusedOperation(t), CheckpointOptions{Input: discountedInput})
	requireStoredCharge(t, value, err)
}

func TestCheckpointSavesTheInputFingerprint(t *testing.T) {
	executor := &checkpointInputExecutor{saved: Row{
		rowStatusField: durableSavedValue, rowCheckpointValueField: []byte(`{"charged":1000}`),
	}}
	handler := newCheckpointInputHandler(executor)
	operation := func() (any, error) { return map[string]any{"charged": 1000}, nil }
	value, err := handler.Checkpoint("charge-card", operation, CheckpointOptions{Input: chargeInput})
	requireStoredCharge(t, value, err)
	value, err = handler.Checkpoint("plain", operation)
	requireStoredCharge(t, value, err)
	if len(executor.saves) != 2 {
		t.Fatalf("%d saves, want 2", len(executor.saves))
	}
	if fingerprint := executor.saves[0][5]; fingerprint != chargeFingerprint {
		t.Fatalf("saved fingerprint %#v, want %s", fingerprint, chargeFingerprint)
	}
	if fingerprint := executor.saves[1][5]; fingerprint != nil {
		t.Fatalf("a call without an input saved fingerprint %#v", fingerprint)
	}
}

func TestCheckpointMapsTheInputConflictStatus(t *testing.T) {
	executor := &checkpointInputExecutor{saved: Row{
		rowStatusField: durableInputConflictValue, rowCheckpointValueField: []byte(`{"charged":1000}`),
		rowInputFingerprintField: chargeFingerprint,
	}}
	handler := newCheckpointInputHandler(executor)
	operation := func() (any, error) { return map[string]any{"charged": 900}, nil }
	_, err := handler.Checkpoint("charge-card", operation, CheckpointOptions{Input: discountedInput})
	requireInputConflict(t, err, chargeFingerprint, mustFingerprint(t, discountedInput))
}

func TestCheckpointRefusesAnInvalidInputBeforeARoundTrip(t *testing.T) {
	handler := newCheckpointInputHandler(&checkpointInputExecutor{stored: storedCharge(chargeFingerprint)})
	if _, err := handler.Checkpoint("charge-card", refusedOperation(t), CheckpointOptions{
		Input: map[string]any{"amount": math.NaN()},
	}); err == nil || !strings.HasPrefix(err.Error(), nonFiniteCheckpointInputMessage) {
		t.Fatalf("returned %v, want the non-finite refusal", err)
	}
	for _, input := range []any{uint64(maxSafeCheckpointInteger + 1), string([]byte{0xff})} {
		if _, err := handler.Checkpoint(
			"charge-card", refusedOperation(t), CheckpointOptions{Input: input},
		); !errors.Is(err, ErrInvalidCheckpointInput) {
			t.Fatalf("input %#v returned %v, want ErrInvalidCheckpointInput", input, err)
		}
	}
	if _, err := handler.Checkpoint(
		"charge-card", refusedOperation(t), CheckpointOptions{Input: 1}, CheckpointOptions{Input: 2},
	); err == nil || err.Error() != checkpointOptionsCountMessage {
		t.Fatalf("returned %v, want the options count refusal", err)
	}
}

func TestOverlappingCheckpointCallsCompareTheirInputs(t *testing.T) {
	handler := newCheckpointInputHandler(&checkpointInputExecutor{saved: Row{
		rowStatusField: durableSavedValue, rowCheckpointValueField: []byte(`"charged"`),
	}})
	entered := make(chan struct{})
	release := make(chan struct{})
	initiator := make(chan checkpointResult, 1)
	go func() {
		value, err := handler.Checkpoint("charge-card", func() (any, error) {
			close(entered)
			<-release
			return "charged", nil
		}, CheckpointOptions{Input: chargeInput})
		initiator <- checkpointResult{value, err}
	}()
	<-entered
	requireInFlight(t, handler, "charge-card")

	_, err := handler.Checkpoint("charge-card", refusedOperation(t), CheckpointOptions{Input: discountedInput})
	requireInputConflict(t, err, chargeFingerprint, mustFingerprint(t, discountedInput))

	// The same input and a call without an input join the call in flight.
	joined := make(chan checkpointResult, 2)
	for _, options := range [][]CheckpointOptions{{{Input: chargeInput}}, nil} {
		go func() {
			value, err := handler.Checkpoint("charge-card", refusedOperation(t), options...)
			joined <- checkpointResult{value, err}
		}()
	}
	// Let both calls join the call in flight. A call that starts after the save reads the stored
	// row, which gives the same result, so a slow start cannot make the test fail.
	time.Sleep(100 * time.Millisecond)
	close(release)
	for _, result := range []<-chan checkpointResult{initiator, joined, joined} {
		outcome := awaitDuplicate(t, result)
		if outcome.err != nil || outcome.value != "charged" {
			t.Fatalf("a call returned %v, %v; want the shared result", outcome.value, outcome.err)
		}
	}
}
