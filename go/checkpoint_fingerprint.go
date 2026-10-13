package workhorse

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// ErrInvalidCheckpointInput reports a checkpoint input that has no fingerprint: a value that
// encoding/json cannot encode, a non-finite number, a number above 2^53 - 1 in magnitude, or text
// that is not valid UTF-8. Every SDK refuses the same inputs (ADR 0098). The error message is the
// message of the cause.
var ErrInvalidCheckpointInput = errors.New(invalidCheckpointInputMessage)

// maxSafeCheckpointInteger is the largest number magnitude that a checkpoint input can hold. I-JSON
// (RFC 7493) keeps integers to the range that an IEEE 754 double holds exactly.
const maxSafeCheckpointInteger = 1<<53 - 1

// A JSON escape \uXXXX has six bytes. A low surrogate code unit is the second unit of a pair.
const (
	unicodeEscapeLength = 6
	lowSurrogateStart   = 0xdc00
	lowSurrogateEnd     = 0xdfff
)

// invalidCheckpointInputError matches ErrInvalidCheckpointInput and the cause, with the message of
// the cause.
type invalidCheckpointInputError struct {
	cause error
}

func (err invalidCheckpointInputError) Error() string { return err.cause.Error() }

func (err invalidCheckpointInputError) Unwrap() []error {
	return []error{ErrInvalidCheckpointInput, err.cause}
}

// CheckpointInputFingerprint returns the input fingerprint that a checkpoint stores for input: the
// SHA-256 digest of the canonical JSON form of the input (RFC 8785), as 64 lowercase hexadecimal
// characters (ADR 0098).
//
// The input is encoded with encoding/json first, as a checkpoint value is, so MarshalJSON methods
// and struct tags apply. The canonical form then sorts the keys of each object by their UTF-16 code
// units and writes no whitespace. Each number is an IEEE 754 double in the ECMAScript form, so 1,
// 1.0, and 1e0 give one digest. Thus two inputs that differ only in key order have the same
// fingerprint, and every SDK gives the same digest for the same input.
//
// An input that has no fingerprint returns an error that wraps ErrInvalidCheckpointInput: a
// non-finite number, a number above 2^53 - 1 in magnitude, or a string or key with invalid UTF-8.
// A larger number can be an integer that a double does not hold exactly, so every SDK refuses it.
// encoding/json writes an invalid byte as the escape \ufffd, so a json.RawMessage or a MarshalJSON
// method that writes U+FFFD as an escape, in either case, is refused too. Such a method must write
// U+FFFD itself.
func CheckpointInputFingerprint(input any) (string, error) {
	canonical, err := canonicalCheckpointInput(input)
	if err != nil {
		return emptyString, invalidCheckpointInputError{cause: err}
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
	if hasInvalidUTF8(encoded) {
		return nil, errors.New(invalidUTF8CheckpointInputMessage)
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

// hasInvalidUTF8 reports whether the input held text that is not valid Unicode. encoding/json
// writes each invalid byte of a string or a key as the escape \ufffd, and it writes U+FFFD itself
// without an escape. Thus any escape of U+FFFD marks invalid text. A json.RawMessage or a
// MarshalJSON method can keep an invalid byte, or write a lone surrogate escape that encoding/json
// decodes as U+FFFD.
func hasInvalidUTF8(encoded []byte) bool {
	if !utf8.Valid(encoded) {
		return true
	}
	for index := 0; index < len(encoded); index++ {
		if encoded[index] != '\\' {
			continue
		}
		unit, isUnicodeEscape := escapedCodeUnit(encoded, index)
		switch {
		case !isUnicodeEscape:
			// The escaped character cannot start another escape, as in \\ufffd.
			index++
		case unit == utf8.RuneError || unit >= lowSurrogateStart && unit <= lowSurrogateEnd:
			return true
		case utf16.IsSurrogate(unit):
			low, isPaired := escapedCodeUnit(encoded, index+unicodeEscapeLength)
			if !isPaired || low < lowSurrogateStart || low > lowSurrogateEnd {
				return true
			}
			index += 2*unicodeEscapeLength - 1
		default:
			index += unicodeEscapeLength - 1
		}
	}
	return false
}

// escapedCodeUnit returns the UTF-16 code unit of the escape \uXXXX that starts at start, if
// there is one. encoding/json has checked that each such escape has four hexadecimal digits.
func escapedCodeUnit(encoded []byte, start int) (rune, bool) {
	if start+unicodeEscapeLength > len(encoded) || encoded[start] != '\\' || encoded[start+1] != 'u' {
		return 0, false
	}
	unit, err := strconv.ParseUint(string(encoded[start+2:start+unicodeEscapeLength]), 16, 16)
	return rune(unit), err == nil
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
		// Each double of 2^53 or more in magnitude is an integer, so this refuses no fraction. A
		// larger integer text rounds to such a double.
		if math.Abs(number) > maxSafeCheckpointInteger {
			return errors.New(unsafeCheckpointInputNumberMessage)
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
