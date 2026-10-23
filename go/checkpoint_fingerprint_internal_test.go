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
	ID            string `json:"id"`
	Input         string `json:"input"`
	Digest        string `json:"digest"`
	Refusal       string `json:"refusal"`
	RoundedDigest string `json:"roundedDigest"`
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
		// The raw message keeps the exact number text, so this SDK refuses a vector that has a
		// rounded digest. An SDK that decodes each number to a double gives that digest (ADR 0098).
		if vector.RoundedDigest != "" && vector.Refusal != "unsafeNumber" {
			t.Errorf("vector %s has a rounded digest without the unsafeNumber refusal", vector.ID)
		}
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

// invalidText is a MarshalText method that gives invalid UTF-8.
type invalidText struct{}

func (invalidText) MarshalText() ([]byte, error) { return []byte{'E', 0xff, 'R'}, nil }

// invalidPointerText has a MarshalText method on its pointer, which encoding/json calls for an
// addressable value only.
type invalidPointerText struct{}

func (*invalidPointerText) MarshalText() ([]byte, error) { return []byte{0xff}, nil }

// flakyText gives invalid UTF-8 on its first call only.
type flakyText struct {
	calls *int
}

func (text flakyText) MarshalText() ([]byte, error) {
	*text.calls++
	if *text.calls == 1 {
		return []byte{0xff}, nil
	}
	return []byte("valid"), nil
}

// zeroText is always zero, so a field tagged omitzero leaves it out.
type zeroText string

func (zeroText) IsZero() bool { return true }

// cyclicNode embeds a pointer to its own type. encoding/json encodes only Escape.
type cyclicNode struct {
	*cyclicNode
	Escape string
}

// hiddenRaw is hidden by the X field of withHiddenRaw, so encoding/json does not encode it.
type hiddenRaw struct {
	X json.RawMessage
}

type withHiddenRaw struct {
	hiddenRaw
	X string
}

// textWithRaw has a MarshalText method that gives invalid UTF-8, and a raw field that
// encoding/json does not encode.
type textWithRaw struct {
	Raw json.RawMessage
}

func (textWithRaw) MarshalText() ([]byte, error) { return []byte{0xff}, nil }

// keyText is a map key with a MarshalText method.
type keyText struct {
	name string
}

func (key keyText) MarshalText() ([]byte, error) { return []byte(key.name), nil }

// collidingKey gives the same map key text for each value.
type collidingKey int

func (collidingKey) MarshalText() ([]byte, error) { return []byte("same"), nil }

// valueMarshaler has a MarshalJSON method on its value.
type valueMarshaler struct{}

func (valueMarshaler) MarshalJSON() ([]byte, error) { return []byte("1"), nil }

// panicJSON is always zero, and its MarshalJSON method panics if anything calls it.
type panicJSON struct{}

func (panicJSON) IsZero() bool { return true }

func (panicJSON) MarshalJSON() ([]byte, error) { panic("MarshalJSON of an omitted field") }

type innerText struct {
	Text string
}

// outerText hides the Text field of innerText, so encoding/json encodes only the outer field.
type outerText struct {
	innerText
	Text string
}

// escapedReplacementCharacter is a MarshalJSON method that writes U+FFFD as an escape.
type escapedReplacementCharacter struct{}

func (escapedReplacementCharacter) MarshalJSON() ([]byte, error) {
	return []byte(`"\ufffd"`), nil
}

type checkpointCharge struct {
	Currency string `json:"currency"`
}

// encoding/json writes each invalid UTF-8 byte of a string or a key as the escape of U+FFFD, and a
// json.RawMessage keeps the byte. Both are refused, as invalid text is refused in the other SDKs.
func TestCheckpointInputFingerprintRefusesInvalidUTF8(t *testing.T) {
	type embedsCharge struct {
		checkpointCharge
	}
	type quotedCurrency struct {
		Currency string `json:"currency,string"`
	}
	calls := 0
	escape := json.RawMessage(`"\ufffd"`)
	invalid := string([]byte{'E', 0xff, 'R'})
	for _, input := range []any{
		invalid,
		[]any{"EUR", invalid},
		map[string]any{invalid: 1},
		map[string]string{"currency": string([]byte{0xed, 0xa0, 0x80})},
		checkpointCharge{Currency: invalid},
		json.RawMessage([]byte{'"', 0xff, '"'}),
		// An escape of U+FFFD in the same input does not hide the invalid text.
		[]any{json.RawMessage(`"\ufffd"`), invalid},
		[]any{escapedReplacementCharacter{}, map[string]any{"currency": invalid}},
		invalidText{},
		map[invalidText]int{{}: 1},
		[]invalidPointerText{{}},
		embedsCharge{checkpointCharge{Currency: invalid}},
		// The check does not call MarshalText again, so a second result cannot hide the first.
		flakyText{calls: &calls},
		// An escape that encoding/json does not write cannot hide an invalid byte.
		withHiddenRaw{hiddenRaw{escape}, invalid},
		map[string]json.RawMessage{invalid: escape},
		textWithRaw{Raw: escape},
		// Two keys give one name, so the check cannot pair each value with its member.
		map[collidingKey]any{0: invalid, 1: "\ufffd"},
		map[collidingKey]any{0: "\ufffd", 1: escape},
		// encoding/json writes a field with the string option as a string of JSON text.
		&quotedCurrency{Currency: invalid},
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
	// An escape of U+FFFD in JSON text gives U+FFFD, in each letter case (ADR 0098).
	for raw, input := range map[string]any{
		`"\ufffd"`:      "\ufffd",
		`{"\uFFFD": 1}`: map[string]int{"\ufffd": 1},
		`["\\\uFfFd"]`:  []string{"\\\ufffd"},
	} {
		if mustFingerprint(t, json.RawMessage(raw)) != mustFingerprint(t, input) {
			t.Fatalf("the escape %s and its text gave different digests", raw)
		}
	}
	// encoding/json does not encode an unexported field or a field tagged "-", so their text is not
	// read. A MarshalJSON method gives JSON text, and its escape of U+FFFD gives U+FFFD.
	type skipsFields struct {
		Currency string `json:"currency"`
		Note     string `json:"-"`
		note     string
	}
	skipped := skipsFields{Currency: "\ufffd", Note: invalid, note: invalid}
	if mustFingerprint(t, []any{json.RawMessage(`"\ufffd"`), skipped}) !=
		mustFingerprint(t, []any{"\ufffd", map[string]string{"currency": "\ufffd"}}) {
		t.Fatal("a field that encoding/json skips changed the outcome")
	}
	if mustFingerprint(t, escapedReplacementCharacter{}) != mustFingerprint(t, "\ufffd") {
		t.Fatal("the escape of a MarshalJSON method and its text gave different digests")
	}
	// Only a field that encoding/json encodes can cause a refusal. A cycle that encoding/json does
	// not encode ends the check, and a raw message that occurs twice gives two escapes.
	node := &cyclicNode{Escape: "a"}
	overlapping := []any{escape, nil}
	overlapping[1] = overlapping[:1]
	type omitsPanic struct {
		Panic panicJSON `json:",omitzero"`
	}
	node.cyclicNode = node
	type omitsZero struct {
		Note zeroText `json:",omitzero"`
	}
	// The digits of the escape without its backslash do not block two map keys with one name.
	if _, err := CheckpointInputFingerprint([]any{escape, map[collidingKey]string{0: "ufffd", 1: "a"}}); err != nil {
		t.Fatalf("two map keys with one name and the digits of the escape: %v", err)
	}
	for input, want := range map[string]struct{ input, text any }{
		"a cycle that is not encoded": {
			[]any{escape, node}, []any{"\ufffd", map[string]string{"Escape": "a"}},
		},
		"a hidden embedded field": {
			[]any{escape, outerText{innerText{invalid}, "valid"}},
			[]any{"\ufffd", map[string]string{"Text": "valid"}},
		},
		"an omitted zero field": {
			[]any{escape, omitsZero{zeroText(invalid)}}, []any{"\ufffd", map[string]string{}},
		},
		"a shared raw message": {
			[]any{&escape, &escape}, []string{"\ufffd", "\ufffd"},
		},
		"overlapping slices": {
			overlapping, []any{"\ufffd", []string{"\ufffd"}},
		},
		"a nil pointer with a MarshalJSON method": {
			[]any{escape, struct{ M any }{(*valueMarshaler)(nil)}},
			[]any{"\ufffd", map[string]any{"M": nil}},
		},
		"a map key with a MarshalText method": {
			map[keyText]any{{"a"}: escape}, map[string]string{"a": "\ufffd"},
		},
		"two map keys with one name and no escape": {
			[]any{escape, map[collidingKey]string{0: "a", 1: "a"}},
			[]any{"\ufffd", map[string]string{"same": "a"}},
		},
		"an omitted field with a MarshalJSON method": {
			[]any{escape, omitsPanic{}}, []any{"\ufffd", map[string]any{}},
		},
	} {
		if mustFingerprint(t, want.input) != mustFingerprint(t, want.text) {
			t.Fatalf("%s changed the digest", input)
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
		// ParseFloat rounds each of these down to 2^53 - 1, but the exact value is larger.
		json.Number("9007199254740991.25"),
		json.RawMessage(`[-9007199254740991.0000001]`),
		json.Number("900719925474099.15E1"),
		json.RawMessage(`{"id": 0.90071992547409910000000001e16}`),
	} {
		digest, err := CheckpointInputFingerprint(input)
		if err == nil || err.Error() != unsafeCheckpointInputNumberMessage ||
			!errors.Is(err, ErrInvalidCheckpointInput) {
			t.Fatalf("input %#v gave %q, %v; want the range refusal", input, digest, err)
		}
	}
}

// The exact check refuses no value at or below 2^53 - 1, in any number form.
func TestCheckpointInputFingerprintAcceptsTheSafeRangeInEachNumberForm(t *testing.T) {
	want := mustFingerprint(t, maxSafeCheckpointInteger)
	for _, text := range []string{
		"9007199254740991.000",
		"0.9007199254740991e16",
		"90071992547409910E-1",
		"0.0009007199254740991e19",
	} {
		if got := mustFingerprint(t, json.Number(text)); got != want {
			t.Fatalf("number %s: digest %s, want %s", text, got, want)
		}
	}
	for _, text := range []string{"9007199254740990.75", "0e99999999999999999999", "1e-99999999999999999999"} {
		if _, err := CheckpointInputFingerprint(json.Number(text)); err != nil {
			t.Fatalf("number %s: %v", text, err)
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
