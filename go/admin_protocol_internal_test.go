package workhorse

import (
	"reflect"
	"testing"
)

// The pgx executor decodes uuid as [16]byte. Every Admin field that holds a uuid column, such as
// WorkerRegistryEntry.InstanceID, reads it through stringValue or stringValues.
func TestAdminStringValueFormatsUUIDBytes(t *testing.T) {
	value := [16]byte{0x30, 0xf9, 0x22, 0xa4, 0x43, 0x17, 0x4e, 0x53, 0x80, 0xb2, 0x3b, 0x61, 0xbd, 0x0f, 0xba, 0x15}
	expected := "30f922a4-4317-4e53-80b2-3b61bd0fba15"
	if text := stringValue(value); text != expected {
		t.Fatalf("stringValue = %q, expected %q", text, expected)
	}
	if text := optionalStringValue(value); text == nil || *text != expected {
		t.Fatalf("optionalStringValue = %v, expected %q", text, expected)
	}
	if texts := stringValues([]any{value}); !reflect.DeepEqual(texts, []string{expected}) {
		t.Fatalf("stringValues = %q, expected [%q]", texts, expected)
	}
}
