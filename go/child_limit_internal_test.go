package workhorse

import (
	"errors"
	"fmt"
	"testing"
)

// A child limit error and a child result limit error end the task also when the handler wraps them
// or joins them behind another error (SM-2025).
func TestChildLimitErrorsAreFoundInAWrappedOrJoinedError(t *testing.T) {
	other := errors.New("other")
	for want, limit := range map[string]error{
		childLimitExceededErrorName:       &ChildLimitExceededError{ParentTaskID: "parent"},
		childResultLimitExceededErrorName: &ChildResultLimitExceededError{ParentTaskID: "parent"},
	} {
		for shape, err := range map[string]error{
			"plain":   limit,
			"wrapped": fmt.Errorf("round: %w", limit),
			"joined":  errors.Join(other, limit),
			"nested":  fmt.Errorf("round: %w", errors.Join(other, fmt.Errorf("set: %w", limit))),
		} {
			if got := durableReplayConflictName(err); got != want {
				t.Fatalf("%s %s: name = %q, want %q", want, shape, got, want)
			}
		}
	}
	if got := durableReplayConflictName(errors.Join(other, errors.New("transient"))); got != emptyString {
		t.Fatalf("a joined error with no terminal error: name = %q", got)
	}
}
