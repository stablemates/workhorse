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

func TestContractSchemaNamesThePatternKeywordItRefuses(t *testing.T) {
	for path, schema := range map[string]any{
		"$.properties.a.pattern":    map[string]any{"properties": map[string]any{"a": map[string]any{"type": "string", "pattern": "^a$"}}},
		"$.items.patternProperties": map[string]any{"items": map[string]any{"patternProperties": map[string]any{"^a": true}}},
	} {
		_, err := compileContractSchema(schema)
		if err == nil || err.Error() != path+" is outside the Workhorse contract profile" {
			t.Fatalf("expected the profile to name %s, got %v", path, err)
		}
	}
}

func TestContractSchemaRefusesAReferenceOutsideTheSchemaTree(t *testing.T) {
	schema := map[string]any{
		"default":    map[string]any{"pattern": "^a$"},
		"properties": map[string]any{"a": map[string]any{"$ref": "#/default"}},
	}
	_, err := compileContractSchema(schema)
	if err == nil || err.Error() != "$.properties.a.$ref must point at a subschema of the contract" {
		t.Fatalf("expected the profile to refuse the reference, got %v", err)
	}
}

func TestContractSchemaNamesTheDuplicateAnchor(t *testing.T) {
	schema := map[string]any{"$defs": map[string]any{
		"one": map[string]any{"$anchor": "same"},
		"two": map[string]any{"$anchor": "same"},
	}}
	_, err := compileContractSchema(schema)
	if err == nil || err.Error() != "$.$defs.two.$anchor must declare a unique anchor" {
		t.Fatalf("expected the profile to refuse the duplicate anchor, got %v", err)
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
