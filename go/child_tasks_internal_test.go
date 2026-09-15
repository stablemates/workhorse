package workhorse

import (
	"testing"
)

func TestOrderedChildResultsDecodesRawAndPreDecodedChildren(t *testing.T) {
	raw := []byte(`[{"name":"a","result":{"ok":true},"outcome":{"status":"succeeded","result":{"ok":true}}},` +
		`{"name":"b","result":null,"outcome":{"status":"failed","error":{"message":"boom"}}},` +
		`{"name":"c","result":null,"outcome":{"status":"canceled","error":null}}]`)
	decoded := []any{
		map[string]any{"name": "a", "result": map[string]any{"ok": true}, "outcome": map[string]any{"status": "succeeded", "result": map[string]any{"ok": true}}},
		map[string]any{"name": "b", "result": nil, "outcome": map[string]any{"status": "failed", "error": map[string]any{"message": "boom"}}},
		map[string]any{"name": "c", "result": nil, "outcome": map[string]any{"status": "canceled", "error": nil}},
	}
	for label, value := range map[string]any{"bytes": raw, "string": string(raw), "decoded": decoded} {
		settled, err := orderedChildResults(value, childSettledModeValue)
		if err != nil {
			t.Fatalf("%s: %v", label, err)
		}
		results := settled.([]ChildResult)
		if len(results) != 3 || results[0].Name != "a" || results[1].Name != "b" || results[2].Name != "c" {
			t.Fatalf("%s: unexpected names: %#v", label, results)
		}
		if _, ok := results[0].Outcome.(ChildSucceeded); !ok {
			t.Fatalf("%s: first outcome is %T", label, results[0].Outcome)
		}
		if failed, ok := results[1].Outcome.(ChildFailed); !ok || failed.Error.(map[string]any)["message"] != "boom" {
			t.Fatalf("%s: second outcome is %#v", label, results[1].Outcome)
		}
		if _, ok := results[2].Outcome.(ChildCanceled); !ok {
			t.Fatalf("%s: third outcome is %T", label, results[2].Outcome)
		}
		successes, err := orderedChildResults(value, childAllSuccessModeValue)
		if err != nil {
			t.Fatalf("%s: %v", label, err)
		}
		all := successes.([]ChildSuccessResult)
		if len(all) != 3 || all[0].Result.(map[string]any)["ok"] != true {
			t.Fatalf("%s: unexpected success results: %#v", label, all)
		}
	}
	for _, invalid := range []any{[]byte(`{"not":"a list"}`), []any{"x"}, 42, []any{map[string]any{"name": "d", "outcome": map[string]any{"status": "weird"}}}} {
		if _, err := orderedChildResults(invalid, childSettledModeValue); err == nil {
			t.Fatalf("expected %#v to be rejected", invalid)
		}
	}
}
