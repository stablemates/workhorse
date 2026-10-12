package workhorse

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"testing"
)

// The shared vectors of typescript/core/test/checkpoint-fingerprint.test.ts. The last vector orders
// keys by UTF-16 code units: U+1F600 encodes as D83D DE00, before U+FB33.
func TestCheckpointInputFingerprintGivesTheSharedVectors(t *testing.T) {
	vectors := []struct {
		input  any
		digest string
	}{
		{nil, "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"},
		{true, "b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b"},
		{0, "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9"},
		{1.5, "9f29a130438b81170b92a42650f9a94291ecad60bd47af2a3886e75f7f728725"},
		{1e21, "241c4643fa70b1dcde1205b71be4e3bebb17e9f880c8e1a33d0ead6c27271d3c"},
		{1e-7, "5b33e02f2c5103a05d32f6ba9cb058294452bfbf393967f68bb30c1bdcbbab22"},
		{"é", "f2886017e9c7abacf804b54d64787dce2b611c9544ba21f3affdd126a6e50086"},
		{[]any{}, "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"},
		{map[string]any{}, "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"},
		{
			map[string]any{"amountCents": 1000, "currency": "EUR"},
			"f5e4dce1a6a38b7186257335fb274c4221391505f139b60596c5f57ce4924471",
		},
		{
			map[string]any{"b": []any{1, map[string]any{"d": 2, "c": 3}}, "a": "x"},
			"4bc2f0faf907fa5fdaedde9cbf7002e3cbf041208b96a4ab4ce6693fbf4bea67",
		},
		{
			map[string]any{"\U0001F600": 1, "דּ": 2},
			"2aa3f5086e32bb90ce39c508a6f40fd72e792684f130d0f3b896ea191368f1e3",
		},
	}
	for _, vector := range vectors {
		digest, err := CheckpointInputFingerprint(vector.input)
		if err != nil {
			t.Fatalf("input %#v: %v", vector.input, err)
		}
		if digest != vector.digest {
			t.Fatalf("input %#v: digest %s, want %s", vector.input, digest, vector.digest)
		}
	}
}

func TestCheckpointInputFingerprintIgnoresKeyOrderAndNumberForm(t *testing.T) {
	type charge struct {
		Currency    string `json:"currency"`
		AmountCents int    `json:"amountCents"`
	}
	want := mustFingerprint(t, map[string]any{"amountCents": 1000, "currency": "EUR"})
	for _, input := range []any{
		charge{Currency: "EUR", AmountCents: 1000},
		map[string]any{"currency": "EUR", "amountCents": 1000.0},
		json.RawMessage(`{ "currency": "EUR", "amountCents": 1e3 }`),
	} {
		if got := mustFingerprint(t, input); got != want {
			t.Fatalf("input %#v: digest %s, want %s", input, got, want)
		}
	}
	if mustFingerprint(t, charge{Currency: "EUR", AmountCents: 900}) == want {
		t.Fatal("a different amount gave the same digest")
	}
	if mustFingerprint(t, math.Copysign(0, -1)) != mustFingerprint(t, 0) {
		t.Fatal("-0 and 0 gave different digests")
	}
	if mustFingerprint(t, json.RawMessage("null")) != mustFingerprint(t, nil) {
		t.Fatal("the raw JSON null and nil gave different digests")
	}
}

func TestCheckpointInputFingerprintWritesNumbersInTheECMAScriptForm(t *testing.T) {
	cases := []struct {
		value float64
		text  string
	}{
		{1, "1"},
		{-1.5, "-1.5"},
		{100, "100"},
		{123456789012345680000, "123456789012345680000"},
		{1e21, "1e+21"},
		{1.25e22, "1.25e+22"},
		{0.000001, "0.000001"},
		{1e-7, "1e-7"},
		{-2.5e-8, "-2.5e-8"},
		{0.1, "0.1"},
		{123.456, "123.456"},
		{float64(math.MaxUint64), "18446744073709552000"},
		{math.MaxFloat64, "1.7976931348623157e+308"},
		{5e-324, "5e-324"},
		// The exact value ends in .25, between two shortest forms. ECMAScript takes the even
		// digit, .2.
		{-1010086764207289.2, "-1010086764207289.2"},
	}
	for _, testCase := range cases {
		if text := ecmaScriptNumber(testCase.value); text != testCase.text {
			t.Fatalf("number %v: text %s, want %s", testCase.value, text, testCase.text)
		}
	}
	// An integer above 2^53 becomes the nearest double, as it does in ECMAScript.
	canonical, err := canonicalCheckpointInput(uint64(math.MaxUint64))
	if err != nil || string(canonical) != "18446744073709552000" {
		t.Fatalf("uint64 max gave %s, %v", canonical, err)
	}
}

func TestCheckpointInputFingerprintWritesStringsInTheJSONStringifyForm(t *testing.T) {
	var out bytes.Buffer
	writeCanonicalString(&out, "a\"\\\b\f\n\r\t\x01\x1f\x7f <>&é")
	want := `"a\"\\\b\f\n\r\t\u0001\u001f` + "\x7f <>&é" + `"`
	if out.String() != want {
		t.Fatalf("string form %q, want %q", out.String(), want)
	}
}

func TestCheckpointInputFingerprintRefusesANonFiniteNumber(t *testing.T) {
	for _, input := range []any{
		math.NaN(),
		[]any{1.0, math.Inf(1)},
		map[string]any{"amount": math.Inf(-1)},
		json.Number("1e400"),
		json.RawMessage(`[-1e400]`),
	} {
		digest, err := CheckpointInputFingerprint(input)
		if err == nil || !strings.HasPrefix(err.Error(), nonFiniteCheckpointInputMessage) {
			t.Fatalf("input %#v gave %q, %v; want the non-finite refusal", input, digest, err)
		}
	}
	var unsupported *json.UnsupportedValueError
	if _, err := CheckpointInputFingerprint(math.NaN()); !errors.As(err, &unsupported) {
		t.Fatalf("the refusal hides the encoding/json error: %v", err)
	}
	if _, err := CheckpointInputFingerprint(make(chan int)); err == nil {
		t.Fatal("an input that is not JSON gave a digest")
	}
}

func mustFingerprint(t *testing.T, input any) string {
	t.Helper()
	digest, err := CheckpointInputFingerprint(input)
	if err != nil {
		t.Fatalf("input %#v: %v", input, err)
	}
	return digest
}
