package workhorse

import (
	"encoding/json"
	"errors"
	"math"
	"os"
	"strings"
	"testing"
)

// checkpointFingerprintVector is one vector of protocol/v1/checkpoint-fingerprints.json, which every
// SDK must give.
type checkpointFingerprintVector struct {
	ID      string `json:"id"`
	Input   string `json:"input"`
	Digest  string `json:"digest"`
	Refusal string `json:"refusal"`
}

// Each input is JSON text, so the raw message keeps its number tokens and its escapes.
func TestCheckpointInputFingerprintGivesTheSharedVectors(t *testing.T) {
	contents, err := os.ReadFile("../protocol/v1/checkpoint-fingerprints.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Vectors []checkpointFingerprintVector `json:"vectors"`
	}
	if err := json.Unmarshal(contents, &fixture); err != nil || len(fixture.Vectors) == 0 {
		t.Fatalf("read %d vectors: %v", len(fixture.Vectors), err)
	}
	refusals := map[string]string{
		"loneSurrogate": invalidUTF8CheckpointInputMessage,
		"nonFinite":     nonFiniteCheckpointInputMessage,
		"unsafeNumber":  unsafeCheckpointInputNumberMessage,
	}
	for _, vector := range fixture.Vectors {
		digest, err := CheckpointInputFingerprint(json.RawMessage(vector.Input))
		if vector.Refusal == "" {
			if err != nil || digest != vector.Digest {
				t.Errorf("vector %s: digest %s, %v; want %s", vector.ID, digest, err, vector.Digest)
			}
			continue
		}
		message, known := refusals[vector.Refusal]
		if !known || err == nil || !strings.HasPrefix(err.Error(), message) ||
			!errors.Is(err, ErrInvalidCheckpointInput) {
			t.Errorf("vector %s gave %q, %v; want the %s refusal", vector.ID, digest, err, vector.Refusal)
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
		if err == nil || !strings.HasPrefix(err.Error(), nonFiniteCheckpointInputMessage) ||
			!errors.Is(err, ErrInvalidCheckpointInput) {
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

// encoding/json writes each invalid UTF-8 byte of a string or a key as the escape \ufffd, and a
// json.RawMessage keeps the byte. Both are refused, as invalid text is refused in the other SDKs.
func TestCheckpointInputFingerprintRefusesInvalidUTF8(t *testing.T) {
	type charge struct {
		Currency string `json:"currency"`
	}
	invalid := string([]byte{'E', 0xff, 'R'})
	for _, input := range []any{
		invalid,
		[]any{"EUR", invalid},
		map[string]any{invalid: 1},
		map[string]string{"currency": string([]byte{0xed, 0xa0, 0x80})},
		charge{Currency: invalid},
		json.RawMessage([]byte{'"', 0xff, '"'}),
		// A MarshalJSON method or a json.RawMessage cannot write U+FFFD as an escape.
		json.RawMessage(`"\ufffd"`),
		json.RawMessage(`{"\uFFFD": 1}`),
		json.RawMessage(`["\\\uFfFd"]`),
		// encoding/json decodes a lone surrogate escape as U+FFFD, and the other SDKs refuse it.
		json.RawMessage(`"\ud800"`),
		json.RawMessage(`{"\uDC00": 1}`),
		json.RawMessage(`"\ud83d\u0041"`),
		json.RawMessage(`"\ud83d\\ude00"`),
		json.RawMessage(`["\ud83d"]`),
	} {
		digest, err := CheckpointInputFingerprint(input)
		if err == nil || err.Error() != invalidUTF8CheckpointInputMessage ||
			!errors.Is(err, ErrInvalidCheckpointInput) {
			t.Fatalf("input %#v gave %q, %v; want the invalid UTF-8 refusal", input, digest, err)
		}
	}
	// A valid escape gives the digest of its text.
	for raw, text := range map[string]string{`"\ud83d\ude00"`: "\U0001F600", `"\u00e9"`: "é"} {
		if mustFingerprint(t, json.RawMessage(raw)) != mustFingerprint(t, text) {
			t.Fatalf("the escape %s and its text gave different digests", raw)
		}
	}
	// U+FFFD itself and the text of its escape are valid input.
	for input, digest := range map[string]string{
		"\ufffd": "568601070314e0f4489c9944b3c151d5251d379330008293bb7e1a826a22a845",
		`\ufffd`: "895773028bd43a8a742bca41a13138847dbb7cdb915d06563ea8d5c6aff0186f",
	} {
		if got := mustFingerprint(t, input); got != digest {
			t.Fatalf("input %q: digest %s, want %s", input, got, digest)
		}
	}
}

func TestCheckpointInputFingerprintRefusesANumberAboveTheSafeRange(t *testing.T) {
	for _, input := range []any{
		int64(maxSafeCheckpointInteger + 1),
		-(maxSafeCheckpointInteger + 1),
		map[string]any{"id": int64(maxSafeCheckpointInteger + 2)},
		uint64(math.MaxUint64),
		int64(math.MinInt64),
		float64(maxSafeCheckpointInteger + 1),
		[]any{1e21},
		-math.MaxFloat64,
		json.Number("9007199254740993"),
		json.RawMessage(`{"id": 9007199254740992}`),
	} {
		digest, err := CheckpointInputFingerprint(input)
		if err == nil || err.Error() != unsafeCheckpointInputNumberMessage ||
			!errors.Is(err, ErrInvalidCheckpointInput) {
			t.Fatalf("input %#v gave %q, %v; want the range refusal", input, digest, err)
		}
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
