package workhorse

import (
	"encoding/json"
	"os"
	"testing"
)

type contractFixture struct {
	ID          string `json:"id"`
	Schema      any    `json:"schema"`
	SchemaError bool   `json:"schemaError"`
	Instances   []struct {
		Value any  `json:"value"`
		Valid bool `json:"valid"`
	} `json:"instances"`
}

func TestContractSchemaProfile(t *testing.T) {
	contents, err := os.ReadFile("../protocol/v1/contracts.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []contractFixture
	if err := json.Unmarshal(contents, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		t.Run(fixture.ID, func(t *testing.T) {
			validator, err := compileContractSchema(fixture.Schema)
			if fixture.SchemaError {
				if err == nil {
					t.Fatal("expected schema error")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			for _, instance := range fixture.Instances {
				actual := validator.Validate(instance.Value) == nil
				if actual != instance.Valid {
					t.Fatalf("expected valid=%t", instance.Valid)
				}
			}
		})
	}
}

func TestContractJSONNormalizationPreservesLargeIntegers(t *testing.T) {
	var value any
	if err := decodeContractJSON([]byte(`{"id":9007199254740993}`), &value); err != nil {
		t.Fatal(err)
	}
	document, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("decoded value is %T", value)
	}
	number, ok := document["id"].(json.Number)
	if !ok || number.String() != "9007199254740993" {
		t.Fatalf("large integer lost precision: %#v", document["id"])
	}
}
