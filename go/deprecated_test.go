package workhorse_test

import (
	"context"
	"testing"

	workhorse "github.com/stablemates/workhorse/go"
)

// The 0.x aliases must keep resolving to their replacements until 1.0.0 removes them. Each method
// expression below fails to compile if an alias loses its receiver, its signature, or its name.
func TestDeprecatedAliasesResolveToTheirReplacements(t *testing.T) {
	var (
		runChild       = (*workhorse.HandlerContext).RunChild
		runChildren    = (*workhorse.HandlerContext).RunChildren
		runChildrenAll = (*workhorse.HandlerContext).RunChildrenAll
		assertSchema   = workhorse.AssertSchemaCompatible
	)
	runChild = (*workhorse.HandlerContext).CreateChild
	runChildren = (*workhorse.HandlerContext).CreateChildren
	runChildrenAll = (*workhorse.HandlerContext).CreateChildrenAll
	assertSchema = workhorse.AssertCompatible
	_, _, _, _ = runChild, runChildren, runChildrenAll, assertSchema

	reasons := map[workhorse.EnqueueNonReplaceableReason]workhorse.EnqueueNonReplaceableReason{
		workhorse.IncompatibleKeyMode:  workhorse.NonReplaceableIncompatibleKeyMode,
		workhorse.NotPending:           workhorse.NonReplaceableNotPending,
		workhorse.WindowElapsedPending: workhorse.NonReplaceableWindowElapsed,
	}
	if len(reasons) != 3 {
		t.Fatalf("expected three distinct reasons, got %d", len(reasons))
	}
	for alias, replacement := range reasons {
		if alias != replacement {
			t.Fatalf("alias %q does not equal its replacement %q", alias, replacement)
		}
	}
}

func TestDeprecatedAssertCompatibleQueriesLikeItsReplacement(t *testing.T) {
	executor := &recordingExecutor{rows: []workhorse.Row{{"kind": "schema", "version": int32(1)}, {"kind": "protocol", "version": int32(1)}}}

	if err := workhorse.AssertCompatible(context.Background(), executor); err != nil {
		t.Fatal(err)
	}

	if executor.calls != 1 {
		t.Fatalf("expected one compatibility query, got %d", executor.calls)
	}
}
