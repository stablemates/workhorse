package workhorse

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"
)

// TaskValueSizeLimitError reports a payload or result whose stored JSON exceeds the task's size
// limit. The worker fails the attempt with it before any completion statement, so the task's retry
// policy applies.
type TaskValueSizeLimitError struct {
	TaskType string
	// Kind is "payload" or "result".
	Kind        string
	ActualBytes int
	MaxBytes    int
}

func (err *TaskValueSizeLimitError) Error() string {
	return fmt.Sprintf(valueSizeLimitErrorFormat, err.TaskType, err.Kind)
}

// checkValueSize refuses a value whose jsonb text exceeds maxBytes. PostgreSQL enforces the limit
// on octet_length(value::jsonb::text). Without exponent notation, that text is at most twice as
// long as the compact encoding, so most values skip the exact measure. A limit below one leaves the
// check to PostgreSQL.
func checkValueSize(taskType string, kind string, encoded []byte, decoded any, maxBytes int) error {
	if maxBytes <= 0 || (len(encoded)*2 <= maxBytes && !hasExponentNumber(encoded)) {
		return nil
	}
	if actual := jsonbTextBytes(decoded); actual > maxBytes {
		return &TaskValueSizeLimitError{TaskType: taskType, Kind: kind, ActualBytes: actual, MaxBytes: maxBytes}
	}
	return nil
}

// checkStorable refuses a value whose JSON holds a string or key that jsonb cannot store: one with
// NUL or with a surrogate outside a pair. The error carries no part of the value, so the failure
// envelope that reports it stays storable.
func checkStorable(taskType string, kind string, encoded []byte) error {
	if hasUnstorableEscape(encoded) {
		return fmt.Errorf(unstorableValueErrorFormat, taskType, kind)
	}
	return nil
}

// hasUnstorableEscape scans valid JSON for a \u escape jsonb refuses. encoding/json writes NUL as
// \u0000 and replaces invalid UTF-8, so a surrogate escape can only come from a json.RawMessage or
// a custom MarshalJSON. A high surrogate is stored only when a low surrogate escape follows it at
// once.
func hasUnstorableEscape(encoded []byte) bool {
	if !mayHoldUnstorableEscape(encoded) {
		return false
	}
	lowExpectedAt := -1
	for index := 0; index < len(encoded); index++ {
		if encoded[index] != '\\' {
			continue
		}
		if lowExpectedAt >= 0 && index != lowExpectedAt {
			return true
		}
		if index+1 >= len(encoded) || encoded[index+1] != 'u' || index+6 > len(encoded) {
			if lowExpectedAt >= 0 {
				return true
			}
			index++
			continue
		}
		unit, err := strconv.ParseUint(string(encoded[index+2:index+6]), 16, 16)
		if err != nil {
			return false
		}
		switch {
		case lowExpectedAt >= 0:
			if unit < 0xDC00 || unit > 0xDFFF {
				return true
			}
			lowExpectedAt = -1
		case unit == 0 || (unit >= 0xDC00 && unit <= 0xDFFF):
			return true
		case unit >= 0xD800 && unit <= 0xDBFF:
			lowExpectedAt = index + 6
		}
		index += 5
	}
	return lowExpectedAt >= 0
}

// mayHoldUnstorableEscape keeps ordinary text off the full scan. encoding/json escapes <, > and &,
// so most results hold some \u escape, but every refused escape is \u0000 or starts with \ud or \uD.
// One pass over the backslashes looks only at the character each one escapes.
func mayHoldUnstorableEscape(encoded []byte) bool {
	for rest := encoded; ; {
		index := bytes.IndexByte(rest, '\\')
		if index < 0 || index+3 > len(rest) {
			return false
		}
		escape := rest[index+1:]
		if escape[0] == 'u' && (escape[1] == 'd' || escape[1] == 'D' || isNulEscapeDigits(escape[1:])) {
			return true
		}
		rest = escape[1:]
	}
}

// isNulEscapeDigits reports whether the hex digits of a \u escape start with the four zeros of NUL.
func isNulEscapeDigits(digits []byte) bool {
	return len(digits) >= 4 && digits[0] == '0' && digits[1] == '0' && digits[2] == '0' && digits[3] == '0'
}

// hasExponentNumber reports a digit followed by an exponent marker. A match inside a string only
// costs the exact measure.
func hasExponentNumber(encoded []byte) bool {
	for index := 1; index < len(encoded); index++ {
		if (encoded[index] == 'e' || encoded[index] == 'E') && encoded[index-1] >= '0' && encoded[index-1] <= '9' {
			return true
		}
	}
	return false
}

// jsonbTextBytes returns the UTF-8 length of PostgreSQL's jsonb text for a value decoded with
// UseNumber. That text puts a space after each ':' and ',', escapes only '"', '\', and control
// characters, and writes numbers in plain decimal notation. Decoding already kept the last of any
// duplicate keys, as jsonb does.
func jsonbTextBytes(value any) int {
	switch typed := value.(type) {
	case nil:
		return len(jsonNullText)
	case bool:
		if typed {
			return len(jsonTrueText)
		}
		return len(jsonFalseText)
	case json.Number:
		return numericTextBytes(string(typed))
	case string:
		return jsonbStringBytes(typed)
	case []any:
		if len(typed) == 0 {
			return 2
		}
		bytes := 2 + (len(typed)-1)*2
		for _, element := range typed {
			bytes += jsonbTextBytes(element)
		}
		return bytes
	case map[string]any:
		if len(typed) == 0 {
			return 2
		}
		bytes := 2 + (len(typed)-1)*2
		for key, element := range typed {
			bytes += jsonbStringBytes(key) + 2 + jsonbTextBytes(element)
		}
		return bytes
	default:
		return 0
	}
}

// jsonbStringBytes measures a string as PostgreSQL's escape_json writes it: two-character escapes
// for '"', '\', and \b \f \n \r \t, a \u00XX escape for any other control character, and every
// other character as raw UTF-8.
func jsonbStringBytes(value string) int {
	bytes := 2
	for index := 0; index < len(value); {
		character, width := utf8.DecodeRuneInString(value[index:])
		index += width
		switch {
		case character == '"' || character == '\\' || character == '\b' || character == '\f' ||
			character == '\n' || character == '\r' || character == '\t':
			bytes += 2
		case character < 0x20:
			bytes += 6
		default:
			bytes += utf8.RuneLen(character)
		}
	}
	return bytes
}

// numericTextBytes measures numeric_out for a JSON number token. numeric_out writes the integer
// part without leading zeros and as many fraction digits as the token had after its decimal point,
// less the exponent. Zero has no sign.
func numericTextBytes(token string) int {
	mantissa, exponentText, hasExponent := strings.Cut(strings.ToLower(token), jsonExponentMarker)
	exponent := 0
	if hasExponent {
		parsed, err := strconv.Atoi(strings.TrimPrefix(exponentText, jsonPlusSign))
		if err != nil {
			// PostgreSQL refuses an exponent this large, so the database reports the value.
			return len(token)
		}
		exponent = parsed
	}
	negative := strings.HasPrefix(mantissa, jsonMinusSign)
	mantissa = strings.TrimPrefix(mantissa, jsonMinusSign)
	integerDigits, fractionDigits, _ := strings.Cut(mantissa, jsonDecimalPoint)
	digits := integerDigits + fractionDigits
	point := len(integerDigits) + exponent
	integerLength := 1
	if point > 0 {
		available := min(point, len(digits))
		leadingZeros := len(digits[:available]) - len(strings.TrimLeft(digits[:available], jsonZeroDigit))
		if leadingZeros < available {
			integerLength = point - leadingZeros
		}
	}
	scale := max(0, len(fractionDigits)-exponent)
	bytes := integerLength
	if scale > 0 {
		bytes += 1 + scale
	}
	if negative && strings.Trim(digits, jsonZeroDigit) != emptyString {
		bytes++
	}
	return bytes
}
