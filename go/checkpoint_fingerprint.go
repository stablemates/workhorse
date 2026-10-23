package workhorse

import (
	"bytes"
	"crypto/sha256"
	"encoding"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"reflect"
	"slices"
	"sort"
	"strconv"
	"strings"
	"unicode"
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

// maxSafeCheckpointIntegerText is the decimal text of maxSafeCheckpointInteger.
var maxSafeCheckpointIntegerText = strconv.FormatInt(maxSafeCheckpointInteger, 10)

var (
	jsonMarshalerType = reflect.TypeFor[json.Marshaler]()
	textMarshalerType = reflect.TypeFor[encoding.TextMarshaler]()
)

// encodedField is a struct field that encoding/json can encode under a JSON name.
type encodedField struct {
	index  []int
	tagged bool
	quoted bool
}

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
// The limit applies to the exact value of a json.Number or of a number in a json.RawMessage, so
// 9007199254740991.25 is refused, although it rounds to 2^53 - 1.
//
// A json.RawMessage or the output of a MarshalJSON method is JSON text, so its escapes give their
// characters: the escape of U+FFFD gives U+FFFD. A lone surrogate escape in that text is refused.
// A MarshalJSON method that encodes invalid UTF-8 with encoding/json gets the escape of U+FFFD, so
// such a method must refuse invalid text itself. The MarshalText method of a map key must give the
// same text on each call, because the check calls it again. If two map keys give the same text,
// the check cannot pair each value with its encoded member. Then, if one of these members holds
// the lowercase escape of U+FFFD, CheckpointInputFingerprint refuses the input.
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
	// encoding/json writes each invalid byte of a string, a key, or MarshalText output as the escape
	// of U+FFFD, in lowercase. It copies the text of a MarshalJSON method as it is. Thus an escape of
	// U+FFFD outside such text marks an invalid byte. A field with the string option escapes the
	// backslash of that escape again, so the check starts for any text that holds its digits.
	invalid, _ := scanEscapes(encoded)
	if invalid || bytes.Contains(encoded, []byte(jsonReplacementEscapeDigits)) &&
		hasReplacedText(reflect.ValueOf(input), encoded) {
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

// scanEscapes reads JSON text. It reports whether the text holds text that is not valid Unicode,
// and it counts the escapes of U+FFFD in the text. A json.RawMessage or a MarshalJSON method can
// keep an invalid byte, or write a lone surrogate escape that encoding/json decodes as U+FFFD.
func scanEscapes(encoded []byte) (invalid bool, replacements int) {
	if !utf8.Valid(encoded) {
		return true, 0
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
		case unit >= lowSurrogateStart && unit <= lowSurrogateEnd:
			return true, replacements
		case utf16.IsSurrogate(unit):
			low, isPaired := escapedCodeUnit(encoded, index+unicodeEscapeLength)
			if !isPaired || low < lowSurrogateStart || low > lowSurrogateEnd {
				return true, replacements
			}
			index += 2*unicodeEscapeLength - 1
		default:
			if unit == utf8.RuneError {
				replacements++
			}
			index += unicodeEscapeLength - 1
		}
	}
	return false, replacements
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

// hasReplacedText reports whether encoding/json replaced an invalid byte in the encoded text of
// value. The function reads value and its encoded text together. Text that a MarshalJSON method
// gives is copied, so its escapes of U+FFFD are valid. Any other escape of U+FFFD replaced an
// invalid byte of a string, a key, or MarshalText output. The function follows the encoded text,
// so a field that encoding/json leaves out and a cycle that it does not encode have no effect. It
// calls no MarshalJSON method, and it calls a MarshalText method only for a map key.
func hasReplacedText(value reflect.Value, encoded []byte) bool {
	if !value.IsValid() || bytes.Equal(encoded, []byte(jsonNullText)) || implementsMethod(value, jsonMarshalerType) {
		return false
	}
	if implementsMethod(value, textMarshalerType) {
		return hasReplacementEscape(encoded)
	}
	switch value.Kind() {
	case reflect.String:
		return hasReplacementEscape(encoded)
	case reflect.Interface, reflect.Pointer:
		return hasReplacedText(value.Elem(), encoded)
	case reflect.Slice, reflect.Array:
		// encoding/json writes a byte slice as a base64 string, which holds no escape.
		if encoded[0] != '[' {
			return false
		}
		items, err := jsonElements(encoded)
		if err != nil || len(items) != value.Len() {
			return true
		}
		for index, item := range items {
			if hasReplacedText(value.Index(index), item) {
				return true
			}
		}
	case reflect.Map:
		return hasReplacedMapText(value, encoded)
	case reflect.Struct:
		return hasReplacedFieldText(value, encoded)
	}
	return false
}

// hasReplacedMapText checks the members of an encoded map. A key is never copied text, so any escape
// of U+FFFD in a key replaced an invalid byte. Each value pairs with the member that has its key.
// Two MarshalText keys can give the same name, and then no pairing is reliable. If a member of such
// a name holds the lowercase escape of U+FFFD, the function reports a replacement. encoding/json
// writes each replacement in that form, and the string option keeps it in the text.
func hasReplacedMapText(value reflect.Value, encoded []byte) bool {
	keys, members, err := jsonMembers(encoded)
	if err != nil {
		return true
	}
	byKey := make(map[string][][]byte, len(keys))
	for index, key := range keys {
		var name string
		if hasReplacementEscape(key) || json.Unmarshal(key, &name) != nil {
			return true
		}
		byKey[name] = append(byKey[name], members[index])
	}
	for _, named := range byKey {
		if len(named) > 1 && slices.ContainsFunc(named, func(member []byte) bool {
			return bytes.Contains(member, []byte(jsonReplacementEscape))
		}) {
			return true
		}
	}
	entries := value.MapRange()
	for entries.Next() {
		name, isResolved := encodedMapKey(entries.Key())
		named := byKey[name]
		if !isResolved || len(named) == 0 {
			return true
		}
		if len(named) == 1 && hasReplacedText(entries.Value(), named[0]) {
			return true
		}
	}
	return false
}

// encodedMapKey returns the JSON key that encoding/json writes for a map key whose text is valid.
func encodedMapKey(key reflect.Value) (string, bool) {
	if key.Kind() == reflect.String {
		return key.String(), true
	}
	if key.CanInterface() {
		if marshaler, isMarshaler := key.Interface().(encoding.TextMarshaler); isMarshaler {
			if key.Kind() == reflect.Pointer && key.IsNil() {
				return emptyString, true
			}
			text, err := marshaler.MarshalText()
			return string(text), err == nil
		}
	}
	switch key.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return strconv.FormatInt(key.Int(), 10), true
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		return strconv.FormatUint(key.Uint(), 10), true
	}
	return emptyString, false
}

// hasReplacedFieldText checks the members of an encoded struct. Each member pairs with the field that
// encoding/json encodes under its key.
func hasReplacedFieldText(value reflect.Value, encoded []byte) bool {
	keys, members, err := jsonMembers(encoded)
	if err != nil {
		return true
	}
	fields := encodedFields(value.Type())
	for index, key := range keys {
		var name string
		if hasReplacementEscape(key) || json.Unmarshal(key, &name) != nil {
			return true
		}
		field, found := fields[name]
		if !found {
			return true
		}
		fieldValue, err := value.FieldByIndexErr(field.index)
		if err != nil {
			return true
		}
		member := members[index]
		// A field with the string option holds the JSON text of its value as a JSON string. A
		// MarshalJSON or MarshalText method ignores the option.
		if field.quoted && member[0] == '"' && !implementsMethod(fieldValue, jsonMarshalerType) &&
			!implementsMethod(fieldValue, textMarshalerType) {
			var inner string
			if json.Unmarshal(member, &inner) != nil || hasReplacementEscape([]byte(inner)) {
				return true
			}
			continue
		}
		if hasReplacedText(fieldValue, member) {
			return true
		}
	}
	return false
}

// encodedFields returns the fields of structType that encoding/json can encode, by JSON name. It
// follows the rules of encoding/json. An embedded struct without a JSON name gives its fields. For
// one name, the field at the smallest depth wins, and a tagged field wins over an untagged one.
// encoding/json leaves out a name that two such fields share, so that name is not in the encoded
// text.
func encodedFields(structType reflect.Type) map[string]encodedField {
	type embedded struct {
		structType reflect.Type
		index      []int
	}
	fields := map[string]encodedField{}
	visited := map[reflect.Type]bool{}
	next := []embedded{{structType: structType}}
	for len(next) > 0 {
		current := next
		next = nil
		found := map[string]encodedField{}
		for _, parent := range current {
			if visited[parent.structType] {
				continue
			}
			visited[parent.structType] = true
			for fieldIndex := range parent.structType.NumField() {
				structField := parent.structType.Field(fieldIndex)
				fieldType := structField.Type
				if fieldType.Name() == emptyString && fieldType.Kind() == reflect.Pointer {
					fieldType = fieldType.Elem()
				}
				if structField.Anonymous && !structField.IsExported() && fieldType.Kind() != reflect.Struct ||
					!structField.Anonymous && !structField.IsExported() {
					continue
				}
				tag := structField.Tag.Get(jsonStructTagKey)
				if tag == jsonSkippedFieldTag {
					continue
				}
				name, options, _ := strings.Cut(tag, jsonTagSeparator)
				if !isValidJSONTagName(name) {
					name = emptyString
				}
				index := append(slices.Clone(parent.index), fieldIndex)
				if name == emptyString && structField.Anonymous && fieldType.Kind() == reflect.Struct {
					next = append(next, embedded{structType: fieldType, index: index})
					continue
				}
				tagged := name != emptyString
				if !tagged {
					name = structField.Name
				}
				quoted := slices.Contains(strings.Split(options, jsonTagSeparator), jsonQuotedOption) &&
					isQuotableKind(fieldType.Kind())
				if previous, exists := found[name]; !exists || tagged && !previous.tagged {
					found[name] = encodedField{index: index, tagged: tagged, quoted: quoted}
				}
			}
		}
		for name, field := range found {
			if _, exists := fields[name]; !exists {
				fields[name] = field
			}
		}
	}
	return fields
}

// isValidJSONTagName reports whether encoding/json uses name from a struct tag as a JSON name.
func isValidJSONTagName(name string) bool {
	if name == emptyString {
		return false
	}
	for _, char := range name {
		if !strings.ContainsRune(jsonTagNamePunctuation, char) && !unicode.IsLetter(char) && !unicode.IsDigit(char) {
			return false
		}
	}
	return true
}

// isQuotableKind reports whether encoding/json applies the string option to a field of kind.
func isQuotableKind(kind reflect.Kind) bool {
	switch kind {
	case reflect.Bool, reflect.String, reflect.Float32, reflect.Float64,
		reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		return true
	}
	return false
}

// implementsMethod reports whether encoding/json encodes value with the method of methodType. It
// uses a method of the pointer only for an addressable value, as encoding/json does.
func implementsMethod(value reflect.Value, methodType reflect.Type) bool {
	valueType := value.Type()
	return valueType.Implements(methodType) ||
		valueType.Kind() != reflect.Pointer && value.CanAddr() && reflect.PointerTo(valueType).Implements(methodType)
}

// hasReplacementEscape reports whether JSON text holds an escape of U+FFFD.
func hasReplacementEscape(encoded []byte) bool {
	_, replacements := scanEscapes(encoded)
	return replacements > 0
}

// jsonElements returns the text of each element of a JSON array.
func jsonElements(encoded []byte) ([][]byte, error) {
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	if _, err := decoder.Token(); err != nil {
		return nil, err
	}
	var items [][]byte
	for decoder.More() {
		var item json.RawMessage
		if err := decoder.Decode(&item); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, nil
}

// jsonMembers returns the key text and the value text of each member of a JSON object.
func jsonMembers(encoded []byte) (keys, members [][]byte, err error) {
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	if _, err := decoder.Token(); err != nil {
		return nil, nil, err
	}
	for decoder.More() {
		start := decoder.InputOffset()
		if _, err := decoder.Token(); err != nil {
			return nil, nil, err
		}
		key := bytes.TrimLeft(encoded[start:decoder.InputOffset()], jsonMemberSeparators)
		var member json.RawMessage
		if err := decoder.Decode(&member); err != nil {
			return nil, nil, err
		}
		keys = append(keys, key)
		members = append(members, member)
	}
	return keys, members, nil
}

// exceedsSafeInteger reports whether the exact value of the JSON number text is more than 2^53 - 1
// in magnitude. ParseFloat rounds a text such as 9007199254740991.25 to 2^53 - 1, so this function
// reads the digits.
func exceedsSafeInteger(text string) bool {
	mantissa, exponentText, hasExponent := strings.Cut(strings.ToLower(strings.TrimPrefix(text, jsonMinusSign)), jsonExponentMarker)
	whole, fraction, _ := strings.Cut(mantissa, jsonDecimalPoint)
	digits := strings.TrimLeft(whole+fraction, jsonZeroDigit)
	if digits == emptyString {
		return false
	}
	exponent := 0
	if hasExponent {
		parsed, err := strconv.Atoi(exponentText)
		if err != nil {
			// The exponent is outside the int range. ParseFloat has refused a large value already.
			return !strings.HasPrefix(exponentText, jsonMinusSign)
		}
		exponent = parsed
	}
	if exponent < -len(text) {
		return false
	}
	// The value is 0.digits * 10^point.
	point := len(whole) - (len(whole) + len(fraction) - len(digits)) + exponent
	if point > len(maxSafeCheckpointIntegerText) {
		return true
	}
	if point < len(maxSafeCheckpointIntegerText) {
		return false
	}
	digits = strings.TrimRight(digits, jsonZeroDigit)
	integer := digits[:min(point, len(digits))] + strings.Repeat(jsonZeroDigit, max(point-len(digits), 0))
	if integer != maxSafeCheckpointIntegerText {
		return integer > maxSafeCheckpointIntegerText
	}
	// The integer part is 2^53 - 1, so a fraction digit other than zero makes the value larger.
	return len(digits) > point
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
		// larger integer text rounds to such a double. A text such as 9007199254740991.25 rounds down
		// to 2^53 - 1, so the exact text is checked too.
		if math.Abs(number) > maxSafeCheckpointInteger || exceedsSafeInteger(string(value)) {
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
