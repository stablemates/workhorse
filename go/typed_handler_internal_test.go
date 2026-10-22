package workhorse

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

type typedInvoice struct {
	Amount int    `json:"amount"`
	Email  string `json:"email"`
}

// A Typed handler receives the claimed payload as its struct, decoded with the worker's JSON rules.
func TestTypedDecodesTheClaimedPayloadIntoItsType(t *testing.T) {
	// A field the payload omits keeps its zero value.
	omitted, err := Typed(func(_ context.Context, invoice typedInvoice, _ *HandlerContext) (any, error) {
		return invoice, nil
	})(context.Background(), map[string]any{"amount": 5.0}, nil)
	if err != nil || omitted != (typedInvoice{Amount: 5}) {
		t.Fatalf("omitted field: %#v err=%v", omitted, err)
	}

	payload, err := decodedJSON([]byte(`{"amount":5,"email":"ada@example.com","extra":true}`))
	if err != nil {
		t.Fatal(err)
	}
	var received typedInvoice
	handler := Typed(func(_ context.Context, invoice typedInvoice, _ *HandlerContext) (any, error) {
		received = invoice
		return invoice.Email, nil
	})
	result, err := handler(context.Background(), payload, nil)
	if err != nil || result != "ada@example.com" {
		t.Fatalf("result %#v err=%v", result, err)
	}
	if received != (typedInvoice{Amount: 5, Email: "ada@example.com"}) {
		t.Fatalf("received %#v", received)
	}
}

// A payload that does not fit the handler's type fails the attempt with the same error as a
// payload that is not JSON, and the handler does not run.
func TestTypedFailsAPayloadOfTheWrongShapeWithoutCallingTheHandler(t *testing.T) {
	called := false
	handler := Typed(func(context.Context, typedInvoice, *HandlerContext) (any, error) {
		called = true
		return nil, nil
	})
	_, err := handler(context.Background(), map[string]any{"amount": "five"}, nil)
	var decodeError *PayloadDecodeError
	if !errors.As(err, &decodeError) || called {
		t.Fatalf("err=%v called=%v", err, called)
	}
	var typeError *json.UnmarshalTypeError
	if !errors.As(err, &typeError) {
		t.Fatalf("the decode error does not unwrap to the JSON error: %v", err)
	}
	if name := handlerErrorName(err); name != "PayloadDecodeError" {
		t.Fatalf("envelope name %q", name)
	}
	if !strings.Contains(err.Error(), "could not decode the task payload") {
		t.Fatalf("message %q", err.Error())
	}
}

func TestTypedSettlesAWrongShapeThroughTheFailurePath(t *testing.T) {
	task, err := claimedTask(claimRow([]byte(`{"amount":"five"}`)), "defaults")
	if err != nil {
		t.Fatal(err)
	}
	task.claimSentAt = time.Now()
	worker := newDefaultWorker(t, WorkerOptions{})
	executor := &failureRecordingExecutor{}
	called := false
	err = worker.execute(context.Background(), executor, task, Typed(func(context.Context, typedInvoice, *HandlerContext) (any, error) {
		called = true
		return nil, nil
	}))
	if err != nil || called {
		t.Fatalf("execute returned %v, called=%v", err, called)
	}
	if len(executor.envelopes) != 1 || !strings.Contains(executor.envelopes[0], `"name":"PayloadDecodeError"`) {
		t.Fatalf("unexpected failure settlement: %q", executor.envelopes)
	}
}

// A durable operation returns decoded JSON. DecodeValue gives the same T for that JSON and for a
// value that encodes as it.
func TestDecodeValueGivesTheSameResultForDecodedJSONAndAStruct(t *testing.T) {
	live := typedInvoice{Amount: 5, Email: "ada@example.com"}
	stored, err := decodedJSON([]byte(`{"amount":5,"email":"ada@example.com"}`))
	if err != nil {
		t.Fatal(err)
	}
	for label, value := range map[string]any{"struct": live, "decoded JSON": stored} {
		decoded, err := DecodeValue[typedInvoice](value)
		if err != nil || decoded != live {
			t.Fatalf("%s: decoded %#v err=%v", label, decoded, err)
		}
	}
	approved, err := DecodeValue[bool](true)
	if err != nil || !approved {
		t.Fatalf("decoded %v err=%v", approved, err)
	}
}

func TestDecodeValueReportsAValueOfTheWrongShape(t *testing.T) {
	_, err := DecodeValue[typedInvoice]([]any{"not", "an", "object"})
	var typeError *json.UnmarshalTypeError
	if !errors.As(err, &typeError) || !strings.Contains(err.Error(), "could not decode the value") {
		t.Fatalf("err=%v", err)
	}
	var decodeError *PayloadDecodeError
	if errors.As(err, &decodeError) {
		t.Fatal("a value error must not claim to be a payload error")
	}
}

func TestTypedRejectsANilHandler(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("Typed accepted a nil handler")
		}
	}()
	Typed[typedInvoice](nil)
}
