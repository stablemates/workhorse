package workhorse

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

// CheckpointInputFingerprint returns the input fingerprint that a checkpoint stores for input: the
// SHA-256 digest of the canonical JSON form of the input (RFC 8785), as 64 lowercase hexadecimal
// characters (ADR 0098).
//
// The input is encoded with encoding/json first, as a checkpoint value is, so MarshalJSON methods
// and struct tags apply. The canonical form then sorts the keys of each object by their UTF-16 code
// units and writes no whitespace. Each number is an IEEE 754 double in the ECMAScript form, so 1,
// 1.0, and 1e0 give one digest, and an integer above 2^53 loses its exact value. Thus two inputs
// that differ only in key order have the same fingerprint, and every SDK gives the same digest for
// the same input. An input with a non-finite number returns an error. encoding/json replaces
// invalid UTF-8 with U+FFFD before the canonical form is written.
func CheckpointInputFingerprint(input any) (string, error) {
	canonical, err := canonicalCheckpointInput(input)
	if err != nil {
		return emptyString, err
	}
	digest := sha256.Sum256(canonical)
	return hex.EncodeToString(digest[:]), nil
}

func canonicalCheckpointInput(input any) ([]byte, error) {
	encoded, err := json.Marshal(input)
	if err != nil {
		var unsupported *json.UnsupportedValueError
		if errors.As(err, &unsupported) && isNonFiniteText(unsupported.Str) {
			return nil, fmt.Errorf(wrappedErrorFormat, nonFiniteCheckpointInputMessage, err)
		}
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	var out bytes.Buffer
	if err := writeCanonicalJSON(&out, value); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// isNonFiniteText reports whether encoding/json refused a float as NaN or an infinity.
func isNonFiniteText(text string) bool {
	return text == jsonNaNText || text == jsonPositiveInfinityText || text == jsonNegativeInfinityText
}

func writeCanonicalJSON(out *bytes.Buffer, value any) error {
	switch value := value.(type) {
	case nil:
		out.WriteString(jsonNullText)
	case bool:
		out.WriteString(strconv.FormatBool(value))
	case json.Number:
		number, err := strconv.ParseFloat(string(value), 64)
		if err != nil {
			// A json.Number or a json.RawMessage can hold a number outside the double range.
			return fmt.Errorf(wrappedErrorFormat, nonFiniteCheckpointInputMessage, err)
		}
		out.WriteString(ecmaScriptNumber(number))
	case string:
		writeCanonicalString(out, value)
	case []any:
		out.WriteByte('[')
		for index, item := range value {
			if index > 0 {
				out.WriteByte(',')
			}
			if err := writeCanonicalJSON(out, item); err != nil {
				return err
			}
		}
		out.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(value))
		for key := range value {
			keys = append(keys, key)
		}
		// RFC 8785 orders keys by UTF-16 code units, which differs from byte order above U+FFFF.
		sort.Slice(keys, func(left, right int) bool {
			return slices.Compare(utf16.Encode([]rune(keys[left])), utf16.Encode([]rune(keys[right]))) < 0
		})
		out.WriteByte('{')
		for index, key := range keys {
			if index > 0 {
				out.WriteByte(',')
			}
			writeCanonicalString(out, key)
			out.WriteByte(':')
			if err := writeCanonicalJSON(out, value[key]); err != nil {
				return err
			}
		}
		out.WriteByte('}')
	default:
		return fmt.Errorf(unsupportedCheckpointInputFormat, value)
	}
	return nil
}

// writeCanonicalString writes a string as JSON.stringify does. RFC 8785 escapes only the quote, the
// backslash, and the control characters. A control character without a short escape uses six
// characters with lowercase hexadecimal digits. encoding/json escapes more characters, such as
// '<' and U+2028, so it does not give this form.
func writeCanonicalString(out *bytes.Buffer, text string) {
	out.WriteByte('"')
	for _, char := range text {
		switch char {
		case '"':
			out.WriteString(jsonEscapedQuote)
		case '\\':
			out.WriteString(jsonEscapedBackslash)
		case '\b':
			out.WriteString(jsonEscapedBackspace)
		case '\f':
			out.WriteString(jsonEscapedFormFeed)
		case '\n':
			out.WriteString(jsonEscapedNewline)
		case '\r':
			out.WriteString(jsonEscapedCarriageReturn)
		case '\t':
			out.WriteString(jsonEscapedTab)
		default:
			if char < 0x20 {
				out.WriteString(jsonControlEscapePrefix)
				out.WriteByte(jsonHexDigits[char>>4])
				out.WriteByte(jsonHexDigits[char&0xf])
			} else {
				out.WriteRune(char)
			}
		}
	}
	out.WriteByte('"')
}

// ecmaScriptNumber formats a finite double as ECMAScript Number::toString does.
//
// strconv gives the shortest digits that read back as the same double, and when two such digit
// strings are equally near the value it takes the even one, as ECMAScript requires. Only the
// layout differs, so this function writes the ECMAScript layout from those digits.
func ecmaScriptNumber(value float64) string {
	if value == 0 {
		// ECMAScript writes -0 as "0".
		return jsonZeroDigit
	}
	sign := emptyString
	if value < 0 {
		sign = jsonMinusSign
		value = -value
	}
	// The 'e' form is d.ddde±xx, or de±xx for one digit.
	scientific := strconv.FormatFloat(value, 'e', -1, 64)
	mantissa, exponentText, _ := strings.Cut(scientific, jsonExponentMarker)
	exponent, _ := strconv.Atoi(exponentText)
	digits := strings.Replace(mantissa, jsonDecimalPoint, emptyString, 1)
	count := len(digits)
	// The value is 0.digits * 10^point.
	point := exponent + 1
	switch {
	case count <= point && point <= 21:
		return sign + digits + strings.Repeat(jsonZeroDigit, point-count)
	case 0 < point && point <= 21:
		return sign + digits[:point] + jsonDecimalPoint + digits[point:]
	case -6 < point && point <= 0:
		return sign + jsonFractionPrefix + strings.Repeat(jsonZeroDigit, -point) + digits
	}
	notation := digits[:1]
	if count > 1 {
		notation += jsonDecimalPoint + digits[1:]
	}
	exponentSign := jsonPlusSign
	if point-1 < 0 {
		exponentSign = jsonMinusSign
	}
	return sign + notation + jsonExponentMarker + exponentSign + strconv.Itoa(abs(point-1))
}

func abs(value int) int {
	if value < 0 {
		return -value
	}
	return value
}
