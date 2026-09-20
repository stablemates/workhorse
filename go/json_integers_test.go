package workhorse

import (
	"encoding/json"
	"testing"
)

// docs/parity.md states the bound: an integer keeps its exact value across the three SDKs only up
// to 2^53 - 1 in magnitude. These tests hold Go to both halves of that statement, so the published
// bound cannot drift away from what the runtime does.

const portableIntegerBound = 9007199254740991

func TestDecodedJSONRoundTripsInsideThePortableBound(t *testing.T) {
	for _, value := range []int64{0, 1, -1, 1 << 31, portableIntegerBound, -portableIntegerBound} {
		encoded, err := json.Marshal(map[string]int64{"id": value})
		if err != nil {
			t.Fatal(err)
		}
		decoded, err := decodedJSON(encoded)
		if err != nil {
			t.Fatal(err)
		}
		number, ok := decoded.(map[string]any)["id"].(float64)
		if !ok || int64(number) != value {
			t.Fatalf("decoded %v, expected %d", decoded.(map[string]any)["id"], value)
		}
	}
}

// A claimed payload is read as a double, so a value beyond the bound arrives rounded. A Python
// client can enqueue it and PostgreSQL stores it exactly, which is why the bound is documented.
func TestDecodedJSONRoundsBeyondThePortableBound(t *testing.T) {
	decoded, err := decodedJSON([]byte(`{"id":9007199254740993}`))
	if err != nil {
		t.Fatal(err)
	}
	number, ok := decoded.(map[string]any)["id"].(float64)
	if !ok || int64(number) != 9007199254740992 {
		t.Fatalf("decoded %v, expected the rounded value", decoded.(map[string]any)["id"])
	}
}

// Contract validation reads the same bytes without rounding, because a schema bound has to be
// checked against the value PostgreSQL stores rather than against a double.
func TestContractDecodingKeepsAnIntegerBeyondThePortableBound(t *testing.T) {
	var value any
	if err := decodeContractJSON([]byte(`{"id":9007199254740993}`), &value); err != nil {
		t.Fatal(err)
	}
	number, ok := value.(map[string]any)["id"].(json.Number)
	if !ok || number.String() != "9007199254740993" {
		t.Fatalf("decoded %v", value.(map[string]any)["id"])
	}
}
