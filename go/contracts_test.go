package workhorse

import (
	"encoding/json"
	"os"
	"testing"
)

type contractFixture struct {
	ID          string `json:"id"`
	Schema      any    `json:"schema"`
	SchemaJSON  string `json:"schemaJson"`
	SchemaError bool   `json:"schemaError"`
	Instances   []struct {
		Value any    `json:"value"`
		JSON  string `json:"json"`
		Needs string `json:"needs"`
		Valid bool   `json:"valid"`
	} `json:"instances"`
}

// unheldContractNumbers lists the kinds of number a Go value cannot hold. A json.Number holds every
// fraction and every integer exactly, so Go runs every instance of the shared table.
var unheldContractNumbers = map[string]bool{}

func TestContractSchemaProfile(t *testing.T) {
	contents, err := os.ReadFile("../protocol/v1/contracts.json")
	if err != nil {
		t.Fatal(err)
	}
	// Queue and Worker decode a payload, a result, and a stored schema with UseNumber, so the
	// table decodes the same way.
	var fixtures []contractFixture
	if err := decodeContractJSON(contents, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		t.Run(fixture.ID, func(t *testing.T) {
			// A schema in JSON text reads the way a schema that PostgreSQL stores does.
			schema := fixture.Schema
			if fixture.SchemaJSON != "" {
				if err := decodeContractJSON([]byte(fixture.SchemaJSON), &schema); err != nil {
					t.Fatal(err)
				}
			}
			validator, err := compileContractSchema(schema)
			if fixture.SchemaError {
				if err == nil {
					t.Fatal("expected schema error")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			for index, instance := range fixture.Instances {
				if unheldContractNumbers[instance.Needs] {
					continue
				}
				value := instance.Value
				if instance.JSON != "" {
					if err := decodeContractJSON([]byte(instance.JSON), &value); err != nil {
						t.Fatal(err)
					}
				}
				actual := validator.Validate(value) == nil
				if actual != instance.Valid {
					t.Fatalf("instance %d: expected valid=%t", index, instance.Valid)
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

func TestContractSchemaNamesTheAnchorAndDefinitionFormsItRefuses(t *testing.T) {
	for message, schema := range map[string]any{
		"$.items.$anchor is outside the Workhorse contract profile":                 map[string]any{"items": map[string]any{"$anchor": "a"}},
		"$.items.$defs must appear only on the root schema":                         map[string]any{"items": map[string]any{"$defs": map[string]any{}}},
		"$.$defs.a b must be a definition name matching ^[A-Za-z_][-A-Za-z0-9._]*$": map[string]any{"$defs": map[string]any{"a b": true}},
	} {
		_, err := compileContractSchema(schema)
		if err == nil || err.Error() != message {
			t.Fatalf("expected %q, got %v", message, err)
		}
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
