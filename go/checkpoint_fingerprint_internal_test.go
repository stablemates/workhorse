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
// keys by UTF-16 code units: U+1F600 encodes as D83D DE00, before U+FB33. 2^53 - 1 is the largest
// number magnitude that an input can hold.
func TestCheckpointInputFingerprintGivesTheSharedVectors(t *testing.T) {
	vectors := []struct {
		input  any
		digest string
	}{
		{nil, "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"},
		{true, "b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b"},
		{0, "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9"},
		{1.5, "9f29a130438b81170b92a42650f9a94291ecad60bd47af2a3886e75f7f728725"},
		{int64(maxSafeCheckpointInteger), "f40b423c2dd95ff2b2f027e22208f438cf7242862e5e746860e697308c9add26"},
		{-maxSafeCheckpointInteger, "4c933a456bb8f2e9894b2d0b26480439cd72d52fb8a27cbf8fd7f323f22c7815"},
		{float64(maxSafeCheckpointInteger), "f40b423c2dd95ff2b2f027e22208f438cf7242862e5e746860e697308c9add26"},
		{json.Number("9007199254740991"), "f40b423c2dd95ff2b2f027e22208f438cf7242862e5e746860e697308c9add26"},
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
