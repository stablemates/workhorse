package workhorse

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
)

// protocol/v1/failures.json owns the shape PostgreSQL stores for a handler failure. TypeScript,
// Python, and Go each run this table, so an operator grouping a dead letter by name reads the same
// field in every language.

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
		DeclaresName  bool   `json:"declaresName"`
		DeclaresStack bool   `json:"declaresStack"`
		Message       string `json:"message"`
	} `json:"error"`
	RedactErrorDetails bool `json:"redactErrorDetails"`
	Envelope           struct {
		Name    string `json:"name"`
		Message string `json:"message"`
		Stack   string `json:"stack"`
	} `json:"envelope"`
}

const declaredFailureName = "PaymentDeclined"

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
	if !fixture.Error.DeclaresName {
		return errors.New(fixture.Error.Message)
	}
	declared := &paymentDeclined{message: fixture.Error.Message}
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
