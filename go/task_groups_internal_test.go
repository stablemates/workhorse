package workhorse

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestTaskGroupRejectionsDecodeTheirDetails(t *testing.T) {
	closed := translateEnqueueError(&pgconn.PgError{
		Code: taskGroupClosedSQLState, Detail: `{"groupId":"g","state":"sealed","reason":"not_running_member"}`,
	})
	var closedError *TaskGroupClosedError
	if !errors.As(closed, &closedError) || !errors.Is(closed, ErrTaskGroupClosed) ||
		closedError.Details != (TaskGroupClosedDetails{GroupID: "g", State: TaskGroupSealed, Reason: TaskGroupRefusedNotRunningMember}) {
		t.Fatalf("unexpected P1008 translation: %#v", closed)
	}
	limit := translateEnqueueError(&pgconn.PgError{
		Code: taskGroupLimitExceededSQLState, Detail: `{"groupId":"g","limit":100000,"total":99999,"requested":2}`,
	})
	var limitError *TaskGroupLimitExceededError
	if !errors.As(limit, &limitError) || !errors.Is(limit, ErrTaskGroupLimitExceeded) ||
		limitError.Details != (TaskGroupLimitDetails{GroupID: "g", Limit: 100000, Total: 99999, Requested: 2}) {
		t.Fatalf("unexpected P1009 translation: %#v", limit)
	}
	conflict := translateEnqueueError(&pgconn.PgError{
		Code: taskGroupMembershipConflictSQLState, Detail: `{"groupId":"g","taskId":"t","ordinal":3,"memberOf":"o"}`,
	})
	var conflictError *TaskGroupMembershipConflictError
	if !errors.As(conflict, &conflictError) || !errors.Is(conflict, ErrTaskGroupMembershipConflict) ||
		conflictError.Details.Ordinal != 3 || conflictError.Details.MemberOf == nil || *conflictError.Details.MemberOf != "o" {
		t.Fatalf("unexpected P1010 translation: %#v", conflict)
	}
}

// An ORM or PostgreSQL can supply DETAIL text that is not the JSON document. The error keeps its
// type, with the same placeholder details the other SDKs use.
func TestTaskGroupRejectionsUsePlaceholderDetailsForUnrelatedText(t *testing.T) {
	for _, detail := range []string{
		"", "not json", `{"groupId":1}`, `{"groupId":"g"}`,
		`{"groupId":"g","state":"sealed","limit":1,"total":1,"taskId":"t","ordinal":1}`,
	} {
		var closed *TaskGroupClosedError
		if err := translateEnqueueError(&pgconn.PgError{Code: taskGroupClosedSQLState, Detail: detail}); !errors.As(err, &closed) ||
			closed.Details != (TaskGroupClosedDetails{GroupID: unknownTaskGroupValue, State: TaskGroupFinished, Reason: TaskGroupRefusedFinished}) {
			t.Fatalf("unexpected P1008 placeholder for %q: %#v", detail, err)
		}
		var limit *TaskGroupLimitExceededError
		if err := translateEnqueueError(&pgconn.PgError{Code: taskGroupLimitExceededSQLState, Detail: detail}); !errors.As(err, &limit) ||
			limit.Details != (TaskGroupLimitDetails{GroupID: unknownTaskGroupValue, Limit: MaxTaskGroupMembers}) {
			t.Fatalf("unexpected P1009 placeholder for %q: %#v", detail, err)
		}
		var conflict *TaskGroupMembershipConflictError
		if err := translateEnqueueError(&pgconn.PgError{Code: taskGroupMembershipConflictSQLState, Detail: detail}); !errors.As(err, &conflict) ||
			conflict.Details != (TaskGroupMembershipConflictDetails{GroupID: unknownTaskGroupValue, TaskID: unknownTaskGroupValue}) {
			t.Fatalf("unexpected P1010 placeholder for %q: %#v", detail, err)
		}
	}
}
