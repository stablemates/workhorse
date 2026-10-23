package workhorse

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
)

// protocol/v1/failures.json owns the shape PostgreSQL stores for a handler failure. Each SDK runs
// this table, so an operator grouping a dead letter by name reads the same field in every language.

type failureEnvelopeTable struct {
	Envelope struct {
		Fields         []string `json:"fields"`
		RedactedFields []string `json:"redactedFields"`
		Redacted       struct {
			Name    string `json:"name"`
			Message string `json:"message"`
		} `json:"redacted"`
		GenericName             map[string]string `json:"genericName"`
		ForbiddenNameCharacters []string          `json:"forbiddenNameCharacters"`
	} `json:"envelope"`
	Fixtures []failureEnvelopeFixture `json:"fixtures"`
}

type failureEnvelopeFixture struct {
	ID    string `json:"id"`
	Error struct {
		DeclaresName  bool           `json:"declaresName"`
		DeclaresStack bool           `json:"declaresStack"`
		Message       fixtureMessage `json:"message"`
	} `json:"error"`
	RedactErrorDetails bool `json:"redactErrorDetails"`
	Envelope           struct {
		Name    string `json:"name"`
		Message string `json:"message"`
		Stack   string `json:"stack"`
	} `json:"envelope"`
}

const declaredFailureName = "PaymentDeclined"

// fixtureMessage is the message a fixture describes: text, or an array of text parts and unpaired
// surrogates. A Go string holds bytes, so an unpaired surrogate becomes the byte 0xFF, which is not
// UTF-8.
type fixtureMessage string

func (message *fixtureMessage) UnmarshalJSON(data []byte) error {
	var text string
	if json.Unmarshal(data, &text) == nil {
		*message = fixtureMessage(text)
		return nil
	}
	var parts []json.RawMessage
	if err := json.Unmarshal(data, &parts); err != nil {
		return err
	}
	var built strings.Builder
	for _, part := range parts {
		if json.Unmarshal(part, &text) == nil {
			built.WriteString(text)
			continue
		}
		var surrogate struct {
			UnpairedSurrogate string `json:"unpairedSurrogate"`
		}
		if err := json.Unmarshal(part, &surrogate); err != nil || surrogate.UnpairedSurrogate == emptyString {
			return fmt.Errorf("message part %s is neither text nor an unpaired surrogate", part)
		}
		built.WriteByte(0xff)
	}
	*message = fixtureMessage(built.String())
	return nil
}

// paymentDeclined names itself and optionally carries a stack, the way a Go handler declares a
// failure through ErrorNamer and ErrorStacker.
type paymentDeclined struct {
	message string
	stack   string
}

func (err *paymentDeclined) Error() string     { return err.message }
func (err *paymentDeclined) ErrorName() string { return declaredFailureName }
func (err *paymentDeclined) ErrorStack() string {
	return err.stack
}

func readFailureEnvelopeTable(t *testing.T) failureEnvelopeTable {
	t.Helper()
	contents, err := os.ReadFile("../protocol/v1/failures.json")
	if err != nil {
		t.Fatal(err)
	}
	var table failureEnvelopeTable
	if err := json.Unmarshal(contents, &table); err != nil {
		t.Fatal(err)
	}
	return table
}

func fixtureFailureError(fixture failureEnvelopeFixture) error {
	message := string(fixture.Error.Message)
	if !fixture.Error.DeclaresName {
		return errors.New(message)
	}
	declared := &paymentDeclined{message: message}
	if fixture.Error.DeclaresStack {
		declared.stack = "goroutine 1 [running]:\nfixture stack\n"
	}
	return declared
}

func TestFailureEnvelopeMatchesSharedTable(t *testing.T) {
	table := readFailureEnvelopeTable(t)
	for _, fixture := range table.Fixtures {
		t.Run(fixture.ID, func(t *testing.T) {
			envelope := handlerErrorEnvelope(fixtureFailureError(fixture), fixture.RedactErrorDetails)
			expectedFields := table.Envelope.Fields
			if fixture.RedactErrorDetails {
				expectedFields = table.Envelope.RedactedFields
			}
			if len(envelope) != len(expectedFields) {
				t.Fatalf("envelope has fields %v, expected %v", envelope, expectedFields)
			}
			for _, field := range expectedFields {
				if _, ok := envelope[field]; !ok {
					t.Fatalf("envelope is missing %q", field)
				}
			}
			if envelope[errorMessageField] != fixture.Envelope.Message {
				t.Fatalf("message is %v", envelope[errorMessageField])
			}
			expectedName := fixture.Envelope.Name
			if expectedName == "$generic" {
				expectedName = table.Envelope.GenericName["go"]
			}
			if envelope[errorNameField] != expectedName {
				t.Fatalf("name is %v, expected %q", envelope[errorNameField], expectedName)
			}
			switch fixture.Envelope.Stack {
			case "string":
				stack, ok := envelope[errorStackField].(string)
				if !ok || stack == emptyString {
					t.Fatalf("stack is %v, expected a non-empty string", envelope[errorStackField])
				}
			case "stringOrNull":
				if value := envelope[errorStackField]; value != nil {
					if _, ok := value.(string); !ok {
						t.Fatalf("stack is %v, expected a string or null", value)
					}
				}
			}
		})
	}
}

func TestFailureEnvelopeNeverRecordsATypeSystemArtifact(t *testing.T) {
	table := readFailureEnvelopeTable(t)
	for _, fixture := range table.Fixtures {
		name, ok := handlerErrorEnvelope(
			fixtureFailureError(fixture),
			fixture.RedactErrorDetails,
		)[errorNameField].(string)
		if !ok || name == emptyString {
			t.Fatalf("%s recorded no name", fixture.ID)
		}
		for _, character := range table.Envelope.ForbiddenNameCharacters {
			if strings.Contains(name, character) {
				t.Fatalf("%s recorded %q, which contains %q", fixture.ID, name, character)
			}
		}
	}
}

// PostgreSQL jsonb stores no NUL, and a Go string can hold bytes that are not UTF-8 (SM-1650). A
// handler names its error and supplies its stack, so the worker cleans every field.
func TestFailureEnvelopeReplacesTheTextJsonbCannotStore(t *testing.T) {
	envelope := handlerErrorEnvelope(&namedFailure{
		name: "Payment\x00Declined", message: "a\x00b \xff c \U0001F600 \uFFFD", stack: "at\x00\xed\xa0\x80",
	}, false)
	want := map[string]any{
		errorNameField:    "Payment\uFFFDDeclined",
		errorMessageField: "a\uFFFDb \uFFFD c \U0001F600 \uFFFD",
		errorStackField:   "at\uFFFD\uFFFD\uFFFD\uFFFD",
	}
	for field, value := range want {
		if envelope[field] != value {
			t.Fatalf("%s is %q, want %q", field, envelope[field], value)
		}
	}
	// encoding/json writes the same text that the envelope holds, so jsonb stores it unchanged.
	encoded, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	for field, value := range want {
		if decoded[field] != value {
			t.Fatalf("encoded %s is %q, want %q", field, decoded[field], value)
		}
	}
	if storableText("plain") != "plain" {
		t.Fatal("ordinary text changed")
	}
}

type namedFailure struct{ name, message, stack string }

func (err *namedFailure) Error() string      { return err.message }
func (err *namedFailure) ErrorName() string  { return err.name }
func (err *namedFailure) ErrorStack() string { return err.stack }

// A wrapped error still names the failure it reports, because errors.As walks the chain.
func TestFailureEnvelopeReadsAWrappedName(t *testing.T) {
	wrapped := errors.Join(errors.New("context"), &paymentDeclined{message: "card declined"})
	envelope := handlerErrorEnvelope(wrapped, false)
	if envelope[errorNameField] != declaredFailureName {
		t.Fatalf("name is %v", envelope[errorNameField])
	}
}

// An exported error type names itself without implementing ErrorNamer, so a declared type stays
// legible while errors.New stays generic.
func TestFailureEnvelopeNamesAnExportedErrorType(t *testing.T) {
	envelope := handlerErrorEnvelope(&WaitLimitExceededError{TaskID: "task"}, false)
	if envelope[errorNameField] != "WaitLimitExceededError" {
		t.Fatalf("name is %v", envelope[errorNameField])
	}
	if envelope[errorStackField] != nil {
		t.Fatalf("stack is %v, expected null", envelope[errorStackField])
	}
}

// A recovered panic keeps its message and gains the stack captured where it was recovered.
func TestFailureEnvelopeCarriesAPanicStack(t *testing.T) {
	_, err := callHandler(
		"panics.task",
		func(context.Context, any, *HandlerContext) (any, error) { panic("boom") },
		context.Background(),
		nil,
		nil,
	)
	if err == nil {
		t.Fatal("expected a recovered panic")
	}
	envelope := handlerErrorEnvelope(err, false)
	if envelope[errorNameField] != "HandlerPanicError" {
		t.Fatalf("name is %v", envelope[errorNameField])
	}
	if envelope[errorMessageField] != "handler for panics.task panicked: boom" {
		t.Fatalf("message is %v", envelope[errorMessageField])
	}
	stack, ok := envelope[errorStackField].(string)
	if !ok || !strings.Contains(stack, "goroutine") {
		t.Fatalf("stack is %v", envelope[errorStackField])
	}
}
