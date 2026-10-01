package workhorse

import (
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
