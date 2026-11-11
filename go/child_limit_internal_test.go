package workhorse

import (
	"errors"
	"fmt"
	"testing"
)

// The limit error of a second child set ends the task also when another child limit error comes
// first in a joined error or a wrapped chain.
func TestSecondChildSetLimitIsFoundBehindAnotherLimit(t *testing.T) {
	plain := &ChildLimitExceededError{ParentTaskID: "parent"}
	second := &ChildLimitExceededError{ParentTaskID: "parent", secondSet: true}
	for name, err := range map[string]error{
		"joined":  errors.Join(plain, second),
		"wrapped": fmt.Errorf("round: %w", errors.Join(plain, fmt.Errorf("set: %w", second))),
	} {
		if got := durableReplayConflictName(err); got != childLimitExceededErrorName {
			t.Fatalf("%s: name = %q", name, got)
		}
	}
	for name, err := range map[string]error{
		"plain":        plain,
		"joined plain": errors.Join(plain, errors.New("other")),
	} {
		if got := durableReplayConflictName(err); got != emptyString {
			t.Fatalf("%s: name = %q, want no terminal name", name, got)
		}
	}
}
