package dashboard

import "testing"

func TestGeneratedInputValidators(t *testing.T) {
	t.Run("accepts valid input", func(t *testing.T) {
		if err := ValidateEventDetailInput(map[string]any{"id": "event:018f0000-0000-7000-8000-000000000042"}); err != nil {
			t.Fatalf("ValidateEventDetailInput returned %v", err)
		}
	})

	t.Run("rejects input outside a schema constraint", func(t *testing.T) {
		if err := ValidateEventDetailInput(map[string]any{"id": "42"}); err == nil {
			t.Fatal("ValidateEventDetailInput accepted an invalid event id")
		}
	})

	t.Run("rejects input for an empty procedure", func(t *testing.T) {
		if err := ValidateMetaInput(map[string]any{}); err == nil {
			t.Fatal("ValidateMetaInput accepted an input object")
		}
	})
}
