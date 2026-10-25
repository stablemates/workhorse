package workhorse

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// externalWaitZeros holds 30,000 zeros. Compact JSON writes them in 60,001 bytes. PostgreSQL's jsonb
// text puts a space after each comma, so it writes the same array in 90,000 bytes, which is above
// the limit.
var externalWaitZeros = make([]int, 30_000)

// refusingExecutor counts each statement and fails it, so a test can prove that none ran.
type refusingExecutor struct {
	statements int
}

func (executor *refusingExecutor) Query(context.Context, string, ...any) ([]Row, error) {
	executor.statements++
	return nil, fmt.Errorf("the size check must refuse the value before a statement runs")
}

func TestExternalWaitValueIsBelowTheLimitAsCompactJSON(t *testing.T) {
	encoded, err := json.Marshal(externalWaitZeros)
	if err != nil {
		t.Fatal(err)
	}
	if len(encoded) >= maximumExternalWaitBytes {
		t.Fatalf("compact JSON is %d bytes, want fewer than %d", len(encoded), maximumExternalWaitBytes)
	}
}

func TestExternalWaitValuesAreMeasuredAsJSONBText(t *testing.T) {
	delivery := ExternalWaitDelivery{IdempotencyKey: "oversized", RequestedBy: "approval-service"}
	taskID := "00000000-0000-4000-8000-000000000001"
	cases := []struct {
		label string
		send  func(*Queue) error
	}{
		{signalPayloadLabelValue, func(queue *Queue) error {
			_, err := queue.SendSignal(context.Background(), taskID, "approval", externalWaitZeros, delivery)
			return err
		}},
		{humanWaitResultLabelValue, func(queue *Queue) error {
			_, err := queue.CompleteHumanWait(context.Background(), taskID, "review", externalWaitZeros, delivery)
			return err
		}},
		// HandlerContext.WaitForHuman encodes its context with this function before its statement.
		{humanWaitContextLabelValue, func(*Queue) error {
			_, err := encodeExternalWaitValue(externalWaitZeros, humanWaitContextLabelValue)
			return err
		}},
	}
	for _, testCase := range cases {
		t.Run(testCase.label, func(t *testing.T) {
			executor := &refusingExecutor{}
			err := testCase.send(NewQueue(executor, "default"))
			want := fmt.Sprintf(externalWaitValueSizeFormat, testCase.label)
			if err == nil || err.Error() != want {
				t.Fatalf("error = %v, want %q", err, want)
			}
			if executor.statements != 0 {
				t.Fatalf("%d statements ran, want none", executor.statements)
			}
		})
	}
}

func TestExternalWaitValueAcceptsADeeplyNestedValue(t *testing.T) {
	// json.Marshal writes 10,001 nested arrays, deeper than the decoder accepts. PostgreSQL stores
	// them in 20,003 bytes.
	var deep any = 0
	for level := 0; level < 10_001; level++ {
		deep = []any{deep}
	}
	encoded, err := encodeExternalWaitValue(deep, signalPayloadLabelValue)
	if err != nil {
		t.Fatal(err)
	}
	if len(encoded) != 20_003 {
		t.Fatalf("encoded %d bytes, want 20003", len(encoded))
	}
}

func TestExternalWaitValueMeasuresADeepValueFromItsTokens(t *testing.T) {
	// The outer array holds 10,001 nested arrays, deeper than the decoder accepts, and 20,000 zeros.
	// Compact JSON writes 60,007 bytes. PostgreSQL's jsonb text is 80,007 bytes, above the limit.
	var deep any = 0
	for level := 0; level < 10_001; level++ {
		deep = []any{deep}
	}
	value := []any{deep, make([]int, 20_000)}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if len(encoded) >= maximumExternalWaitBytes {
		t.Fatalf("compact JSON is %d bytes, want fewer than %d", len(encoded), maximumExternalWaitBytes)
	}
	if actual := scannedJSONBTextBytes(encoded); actual != 80_007 {
		t.Fatalf("measured %d bytes, want 80007", actual)
	}
	executor := &refusingExecutor{}
	_, err = NewQueue(executor, "default").SendSignal(context.Background(), "00000000-0000-4000-8000-000000000001",
		"approval", value, ExternalWaitDelivery{IdempotencyKey: "oversized", RequestedBy: "approval-service"})
	want := fmt.Sprintf(externalWaitValueSizeFormat, signalPayloadLabelValue)
	if err == nil || err.Error() != want {
		t.Fatalf("error = %v, want %q", err, want)
	}
	if executor.statements != 0 {
		t.Fatalf("%d statements ran, want none", executor.statements)
	}
}

func TestScannedJSONBTextBytesMatchesTheDecodedMeasure(t *testing.T) {
	documents := []string{
		`{"a":[1,2.50,-0,1e3,"x\"y",true,false,null],"b":{"c":"\u003c\u00e9"}}`,
		`[[],{},"",0.000,-1.5E-2]`,
		` { "k" : [ 1 , 2 ] } `,
		`{"x":"a long value","y":[{"x":1,"x":[2,3]}],"x":0}`,
		`[{"\u0078":1,"x":22},{}]`,
	}
	for _, document := range documents {
		var decoded any
		if err := decodeContractJSON([]byte(document), &decoded); err != nil {
			t.Fatal(err)
		}
		if scanned, want := scannedJSONBTextBytes([]byte(document)), jsonbTextBytes(decoded); scanned != want {
			t.Fatalf("%s: scanned %d bytes, want %d", document, scanned, want)
		}
	}
}

func TestExternalWaitValueMeasuresDuplicateKeysAsPostgreSQLKeepsThem(t *testing.T) {
	// The value is nested deeper than the decoder accepts. Its object repeats the key "x": the first
	// member holds 50,000 characters, and PostgreSQL keeps only the last member, so its jsonb text is
	// 20,015 bytes, below the limit.
	var deep any = 0
	for level := 0; level < 10_001; level++ {
		deep = []any{deep}
	}
	duplicate := json.RawMessage(`{"x":"` + strings.Repeat("a", 50_000) + `","x":0}`)
	encoded, err := encodeExternalWaitValue([]any{deep, duplicate}, signalPayloadLabelValue)
	if err != nil {
		t.Fatal(err)
	}
	if actual := scannedJSONBTextBytes(encoded); actual != 20_015 {
		t.Fatalf("measured %d bytes, want 20015", actual)
	}
}
