package workhorse

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// MaxTaskGroupMembers is the largest number of member tasks one task group holds (ADR 0095).
const MaxTaskGroupMembers = 100_000

// MaxTaskGroupPageSize is the largest number of members or events one task group read returns.
const MaxTaskGroupPageSize = 1_000

// MaxTaskGroupDriftLimit is the largest number of groups one drift read or repair examines.
const MaxTaskGroupDriftLimit = 10_000

const (
	defaultTaskGroupMemberLimit = 100
	defaultTaskGroupAdminLimit  = 1_000
)

// TaskGroupState is the lifecycle state of a task group. An open group accepts tasks. A sealed
// group accepts tasks only from a running member task. A finished group has every member task
// finished and its callbacks enqueued.
type TaskGroupState string

const (
	TaskGroupOpen     TaskGroupState = taskGroupOpenValue
	TaskGroupSealed   TaskGroupState = taskGroupSealedValue
	TaskGroupFinished TaskGroupState = taskGroupFinishedValue
)

// TaskGroupResult is TaskGroupSucceeded when every member task succeeded, otherwise
// TaskGroupFailed.
type TaskGroupResult string

const (
	TaskGroupSucceeded TaskGroupResult = taskSucceededValue
	TaskGroupFailed    TaskGroupResult = taskFailedValue
)

// TaskGroupCallbackKind names one of the three callbacks of a task group.
type TaskGroupCallbackKind string

const (
	TaskGroupOnFinish  TaskGroupCallbackKind = taskGroupOnFinishField
	TaskGroupOnSuccess TaskGroupCallbackKind = taskGroupOnSuccessField
	TaskGroupOnFailure TaskGroupCallbackKind = taskGroupOnFailureField
)

// TaskGroupMemberOutcome is the outcome a group counted for one member task.
type TaskGroupMemberOutcome string

const (
	TaskGroupMemberSucceeded TaskGroupMemberOutcome = taskSucceededValue
	TaskGroupMemberFailed    TaskGroupMemberOutcome = taskFailedValue
	TaskGroupMemberCanceled  TaskGroupMemberOutcome = taskCanceledValue
)

// TaskGroupCallbacks holds the callbacks of a task group. Each one is an ordinary enqueue request
// without enqueue idempotency, debounce, or throttle. A callback can be on any queue, the fast tier
// included. A nil callback is not requested.
type TaskGroupCallbacks struct {
	// OnFinish runs when every member task is finished.
	OnFinish *EnqueueRequest
	// OnSuccess runs when every member task is finished and every member task succeeded.
	OnSuccess *EnqueueRequest
	// OnFailure runs when every member task is finished and one or more member tasks did not
	// succeed.
	OnFailure *EnqueueRequest
}

// TaskGroupCounts counts the member tasks of a group by outcome.
type TaskGroupCounts struct {
	Total     int
	Succeeded int
	Failed    int
	Canceled  int
	Pending   int
}

// TaskGroupCallback is a requested callback and the task the finished group enqueued for it.
type TaskGroupCallback struct {
	Kind TaskGroupCallbackKind
	// TaskID is nil until the group finishes, and nil for a callback that the result does not
	// select.
	TaskID *string
}

// TaskGroup is the state, counts, and callbacks of one task group.
type TaskGroup struct {
	ID           string
	State        TaskGroupState
	Result       *TaskGroupResult
	Counts       TaskGroupCounts
	CreatedAt    time.Time
	SealedAt     *time.Time
	FinishedAt   *time.Time
	CanceledAt   *time.Time
	CanceledBy   *string
	CancelReason *string
	// Callbacks lists the requested callbacks in the order OnFinish, OnSuccess, OnFailure.
	Callbacks []TaskGroupCallback
}

// TaskGroupMember is one member task of a group.
type TaskGroupMember struct {
	// Position is the one-based order in which the member joined its group.
	Position int
	TaskID   string
	// Queue, Type, and State are nil after the task is deleted, by a purge or by retention.
	Queue *string
	Type  *string
	State *TaskState
	// Outcome is the outcome the group counted, or nil while the member is pending.
	Outcome   *TaskGroupMemberOutcome
	AddedAt   time.Time
	CountedAt *time.Time
}

// TaskGroupMemberQuery selects one page of members. A zero Limit reads 100 members.
type TaskGroupMemberQuery struct {
	// After returns members after this position.
	After int
	Limit int
}

// TaskGroupMemberPage is one page of members.
type TaskGroupMemberPage struct {
	Members []TaskGroupMember
	// NextAfter is the After value of the next page, or nil on the last page.
	NextAfter *int
}

// TaskGroupRole says how a task belongs to its group.
type TaskGroupRole string

const (
	TaskGroupMemberRole   TaskGroupRole = taskGroupMemberRoleValue
	TaskGroupCallbackRole TaskGroupRole = taskGroupCallbackRoleValue
)

// TaskGroupLink is the group of a task, as a member task or as a callback task.
type TaskGroupLink struct {
	Role TaskGroupRole
	// Callback is the kind of callback for a callback task, and nil for a member task.
	Callback *TaskGroupCallbackKind
	Group    TaskGroup
}

// TaskGroupEventType names one entry in the history of a group.
type TaskGroupEventType string

const (
	TaskGroupCreatedEvent          TaskGroupEventType = taskGroupCreatedEventValue
	TaskGroupSealedEvent           TaskGroupEventType = taskGroupSealedEventValue
	TaskGroupCanceledEvent         TaskGroupEventType = taskGroupCanceledEventValue
	TaskGroupFinishedEvent         TaskGroupEventType = taskGroupFinishedEventValue
	TaskGroupCallbackEnqueuedEvent TaskGroupEventType = taskGroupCallbackEnqueuedEventValue
	TaskGroupCallbackFailedEvent   TaskGroupEventType = taskGroupCallbackFailedEventValue
	TaskGroupCounterRepairedEvent  TaskGroupEventType = taskGroupCounterRepairedEventValue
)

// TaskGroupEvent is one entry in the history of a group.
type TaskGroupEvent struct {
	ID         string
	Type       TaskGroupEventType
	Details    any
	OccurredAt time.Time
}

// TaskGroupBuilder collects the tasks of the block form Queue.TaskGroup.
type TaskGroupBuilder struct {
	requests []EnqueueRequest
}

// Add collects up to MaxEnqueueBatchSize requests. The group holds at most MaxTaskGroupMembers.
func (builder *TaskGroupBuilder) Add(requests ...EnqueueRequest) error {
	if err := validateTaskGroupRequests(requests); err != nil {
		return err
	}
	if len(builder.requests)+len(requests) > MaxTaskGroupMembers {
		return fmt.Errorf(taskGroupBuilderLimitFormat, ErrTaskGroupLimitExceeded, MaxTaskGroupMembers)
	}
	builder.requests = append(builder.requests, requests...)
	return nil
}

// TaskGroupBlockResult is the group the block form created and one result for each added request,
// in order.
type TaskGroupBlockResult struct {
	Group TaskGroup
	Tasks []EnqueueResult
}

// TaskGroupRepairAction says what a repair does to one drifted group.
type TaskGroupRepairAction string

const (
	TaskGroupRepairRecounted TaskGroupRepairAction = taskGroupRecountedValue
	TaskGroupRepairFinished  TaskGroupRepairAction = taskGroupFinishedValue
)

// TaskGroupRecordedCounts are the counters that a group row records.
type TaskGroupRecordedCounts struct {
	Total     int
	Succeeded int
	Failed    int
	Canceled  int
}

// TaskGroupDrift is one group whose counters disagree with its member outcomes, or a sealed group
// that has no pending member and is not finished.
type TaskGroupDrift struct {
	GroupID  string
	State    TaskGroupState
	Recorded TaskGroupRecordedCounts
	// Counted holds the counts that the member outcomes give.
	Counted TaskGroupCounts
	Action  TaskGroupRepairAction
}

// TaskGroupRepair is the change a repair made to one group.
type TaskGroupRepair struct {
	GroupID         string
	RecordedPending int
	Pending         int
	Action          TaskGroupRepairAction
}

// TaskGroupRefusal says why a task group refused an add.
type TaskGroupRefusal string

const (
	TaskGroupRefusedSealed           TaskGroupRefusal = taskGroupSealedValue
	TaskGroupRefusedFinished         TaskGroupRefusal = taskGroupFinishedValue
	TaskGroupRefusedCanceled         TaskGroupRefusal = taskCanceledValue
	TaskGroupRefusedNotRunningMember TaskGroupRefusal = taskGroupNotRunningMemberValue
)

// ErrTaskGroupClosed matches an add to a group that is sealed, finished, or canceled (P1008).
var ErrTaskGroupClosed = errors.New(taskGroupClosedMessage)

// ErrTaskGroupLimitExceeded matches an add that would take a group above MaxTaskGroupMembers
// (P1009).
var ErrTaskGroupLimitExceeded = errors.New(taskGroupLimitExceededMessage)

// ErrTaskGroupMembershipConflict matches an enqueue idempotency hit that returned a task that is
// not a member of the group (P1010).
var ErrTaskGroupMembershipConflict = errors.New(taskGroupMembershipConflictMessage)

// ErrNotTaskGroupMember matches HandlerContext.AddToTaskGroup in a task that is not a member task.
var ErrNotTaskGroupMember = errors.New(notTaskGroupMemberMessage)

// TaskGroupClosedDetails is PostgreSQL's diagnosis of a refused add.
type TaskGroupClosedDetails struct {
	GroupID string           `json:"groupId"`
	State   TaskGroupState   `json:"state"`
	Reason  TaskGroupRefusal `json:"reason"`
}

// TaskGroupClosedError reports a group that does not accept tasks.
type TaskGroupClosedError struct{ Details TaskGroupClosedDetails }

func (err *TaskGroupClosedError) Error() string {
	return fmt.Sprintf(taskGroupClosedFormat, err.Details.GroupID, err.Details.Reason)
}

func (err *TaskGroupClosedError) Unwrap() error { return ErrTaskGroupClosed }

// TaskGroupLimitDetails is PostgreSQL's diagnosis of an add above the member limit.
type TaskGroupLimitDetails struct {
	GroupID   string `json:"groupId"`
	Limit     int    `json:"limit"`
	Total     int    `json:"total"`
	Requested int    `json:"requested"`
}

// TaskGroupLimitExceededError reports an add that would take a group above its member limit.
type TaskGroupLimitExceededError struct{ Details TaskGroupLimitDetails }

func (err *TaskGroupLimitExceededError) Error() string {
	return fmt.Sprintf(taskGroupLimitExceededFormat, err.Details.GroupID, err.Details.Total, err.Details.Limit)
}

func (err *TaskGroupLimitExceededError) Unwrap() error { return ErrTaskGroupLimitExceeded }

// TaskGroupMembershipConflictDetails is PostgreSQL's diagnosis of an idempotency hit outside the
// group.
type TaskGroupMembershipConflictDetails struct {
	GroupID string `json:"groupId"`
	TaskID  string `json:"taskId"`
	Ordinal int    `json:"ordinal"`
	// MemberOf is the group the existing task belongs to, or nil.
	MemberOf *string `json:"memberOf"`
}

// TaskGroupMembershipConflictError reports an enqueue idempotency hit that returned a task that is
// not a member of the group.
type TaskGroupMembershipConflictError struct {
	Details TaskGroupMembershipConflictDetails
}

func (err *TaskGroupMembershipConflictError) Error() string {
	return fmt.Sprintf(taskGroupMembershipConflictFormat, err.Details.TaskID, err.Details.GroupID)
}

func (err *TaskGroupMembershipConflictError) Unwrap() error { return ErrTaskGroupMembershipConflict }

// taskGroupRejection translates the task group SQLSTATEs into their errors, or returns nil. A DETAIL
// that does not decode, or that lacks a field, gives the same placeholder details as the other SDKs.
func taskGroupRejection(databaseError *pgconn.PgError) error {
	detail := []byte(databaseError.Detail)
	switch databaseError.Code {
	case taskGroupClosedSQLState:
		var decoded struct {
			GroupID *string `json:"groupId"`
			State   *string `json:"state"`
			Reason  *string `json:"reason"`
		}
		details := TaskGroupClosedDetails{
			GroupID: unknownTaskGroupValue, State: TaskGroupFinished, Reason: TaskGroupRefusedFinished,
		}
		if json.Unmarshal(detail, &decoded) == nil && decoded.GroupID != nil && decoded.State != nil && decoded.Reason != nil {
			details = TaskGroupClosedDetails{
				GroupID: *decoded.GroupID, State: TaskGroupState(*decoded.State), Reason: TaskGroupRefusal(*decoded.Reason),
			}
		}
		return &TaskGroupClosedError{Details: details}
	case taskGroupLimitExceededSQLState:
		var decoded struct {
			GroupID   *string `json:"groupId"`
			Limit     *int    `json:"limit"`
			Total     *int    `json:"total"`
			Requested *int    `json:"requested"`
		}
		details := TaskGroupLimitDetails{GroupID: unknownTaskGroupValue, Limit: MaxTaskGroupMembers}
		if json.Unmarshal(detail, &decoded) == nil && decoded.GroupID != nil && decoded.Limit != nil &&
			decoded.Total != nil && decoded.Requested != nil {
			details = TaskGroupLimitDetails{
				GroupID: *decoded.GroupID, Limit: *decoded.Limit, Total: *decoded.Total, Requested: *decoded.Requested,
			}
		}
		return &TaskGroupLimitExceededError{Details: details}
	case taskGroupMembershipConflictSQLState:
		var decoded struct {
			GroupID  *string         `json:"groupId"`
			TaskID   *string         `json:"taskId"`
			Ordinal  *int            `json:"ordinal"`
			MemberOf json.RawMessage `json:"memberOf"`
		}
		details := TaskGroupMembershipConflictDetails{GroupID: unknownTaskGroupValue, TaskID: unknownTaskGroupValue}
		var memberOf *string
		if json.Unmarshal(detail, &decoded) == nil && decoded.GroupID != nil && decoded.TaskID != nil &&
			decoded.Ordinal != nil && decoded.MemberOf != nil && json.Unmarshal(decoded.MemberOf, &memberOf) == nil {
			details = TaskGroupMembershipConflictDetails{
				GroupID: *decoded.GroupID, TaskID: *decoded.TaskID, Ordinal: *decoded.Ordinal, MemberOf: memberOf,
			}
		}
		return &TaskGroupMembershipConflictError{Details: details}
	default:
		return nil
	}
}

func validateTaskGroupRequests(requests []EnqueueRequest) error {
	if len(requests) > MaxEnqueueBatchSize {
		return ErrEnqueueBatchTooLarge
	}
	for _, request := range requests {
		if request.Options.Debounce != nil || request.Options.Throttle != nil {
			return fmt.Errorf(taskGroupCoalescingMessage, ErrInvalidEnqueueOptions)
		}
	}
	return nil
}

func taskGroupLimit(value, fallback, maximum int) (int, error) {
	if value == 0 {
		return fallback, nil
	}
	if value < 1 || value > maximum {
		return 0, fmt.Errorf(taskGroupLimitRangeFormat, maximum)
	}
	return value, nil
}

// CreateTaskGroup creates an open task group (ADR 0095). Add tasks with AddToTaskGroup, then seal
// the group with SealTaskGroup. When the group is sealed and every member task is finished,
// Workhorse enqueues the callbacks that the result selects. Use a queue over a transaction executor
// to create the group in the caller's transaction.
func (queue *Queue) CreateTaskGroup(ctx context.Context, callbacks TaskGroupCallbacks) (TaskGroup, error) {
	result, err := queue.createTaskGroup(ctx, callbacks, nil, false)
	return result.Group, err
}

// TaskGroup creates a task group, adds the tasks that build collects, and seals the group, in one
// statement and so in one transaction. A group with no tasks finishes at the seal. If build returns
// an error, TaskGroup creates nothing and returns that error.
func (queue *Queue) TaskGroup(
	ctx context.Context,
	callbacks TaskGroupCallbacks,
	build func(*TaskGroupBuilder) error,
) (TaskGroupBlockResult, error) {
	builder := &TaskGroupBuilder{}
	if err := build(builder); err != nil {
		return TaskGroupBlockResult{}, err
	}
	return queue.createTaskGroup(ctx, callbacks, builder.requests, true)
}

func (queue *Queue) createTaskGroup(
	ctx context.Context,
	callbacks TaskGroupCallbacks,
	requests []EnqueueRequest,
	seal bool,
) (TaskGroupBlockResult, error) {
	if err := validateTaskGroupCallbacks(callbacks); err != nil {
		return TaskGroupBlockResult{}, err
	}
	var groupID string
	// A contract mismatch of a member or a callback creates nothing, and the retry serializes the
	// callbacks again under the contract versions that the mismatch refreshed.
	tasks, err := queue.submitEnqueueRequests(ctx, requests, func(ctx context.Context, input []byte) ([]Row, error) {
		serializedCallbacks, err := queue.serializeTaskGroupCallbacks(ctx, callbacks)
		if err != nil {
			return nil, err
		}
		rows, err := queue.executor.Query(
			ctx, internalStatementRegistry[createTaskGroupStatementName], serializedCallbacks, input, seal,
		)
		if err != nil {
			return nil, err
		}
		groupID = emptyString
		if len(rows) > 0 {
			groupID, _ = uuidString(rows[0][rowGroupIDField])
		}
		requestRows := make([]Row, 0, len(rows))
		for _, row := range rows {
			if row[rowOrdinalField] != nil {
				requestRows = append(requestRows, row)
			}
		}
		return requestRows, nil
	})
	if err != nil {
		return TaskGroupBlockResult{}, err
	}
	if groupID == emptyString {
		return TaskGroupBlockResult{}, errors.New(taskGroupCreatedNoGroupMessage)
	}
	group, err := queue.GetTaskGroup(ctx, groupID)
	if err != nil {
		return TaskGroupBlockResult{}, err
	}
	if group == nil {
		return TaskGroupBlockResult{}, fmt.Errorf(taskGroupDisappearedFormat, groupID)
	}
	return TaskGroupBlockResult{Group: *group, Tasks: tasks}, nil
}

func validateTaskGroupCallbacks(callbacks TaskGroupCallbacks) error {
	for _, request := range []*EnqueueRequest{callbacks.OnFinish, callbacks.OnSuccess, callbacks.OnFailure} {
		if request == nil {
			continue
		}
		options := request.Options
		if options.Idempotency != nil || options.Debounce != nil || options.Throttle != nil {
			return fmt.Errorf(taskGroupCallbackCoalescingMessage, ErrInvalidEnqueueOptions)
		}
	}
	return nil
}

// serializeTaskGroupCallbacks renders the callbacks as the JSON object create_task_group_v1 reads.
// A callback is enqueued later, so it carries no run time unless the caller set one.
func (queue *Queue) serializeTaskGroupCallbacks(ctx context.Context, callbacks TaskGroupCallbacks) ([]byte, error) {
	kinds := []TaskGroupCallbackKind{TaskGroupOnFinish, TaskGroupOnSuccess, TaskGroupOnFailure}
	requests := []*EnqueueRequest{callbacks.OnFinish, callbacks.OnSuccess, callbacks.OnFailure}
	serialized := make(map[TaskGroupCallbackKind]enqueueInput, len(kinds))
	traceContext := injectTraceContext(ctx)
	for index, request := range requests {
		if request == nil {
			continue
		}
		input, err := serializeEnqueueRequest(*request, queue.defaultQueue, time.Now().UTC())
		if err != nil {
			return nil, err
		}
		input.TraceContext = traceContext
		inputs := []enqueueInput{input}
		if err := queue.applyPayloadContracts(ctx, inputs); err != nil {
			return nil, err
		}
		if request.Options.RunAt == nil {
			inputs[0].RunAt = nil
		}
		serialized[kinds[index]] = inputs[0]
	}
	return json.Marshal(serialized)
}

// AddToTaskGroup enqueues up to MaxEnqueueBatchSize tasks as members of an open group. A sealed group
// accepts tasks only from a running member task, through HandlerContext.AddToTaskGroup.
func (queue *Queue) AddToTaskGroup(
	ctx context.Context,
	groupID string,
	requests []EnqueueRequest,
) ([]EnqueueResult, error) {
	return queue.addToTaskGroup(ctx, groupID, requests, nil)
}

func (queue *Queue) addToTaskGroup(
	ctx context.Context,
	groupID string,
	requests []EnqueueRequest,
	member *fencedLease,
) ([]EnqueueResult, error) {
	if err := validateTaskGroupRequests(requests); err != nil {
		return nil, err
	}
	if len(requests) == 0 {
		return []EnqueueResult{}, nil
	}
	arguments := []any{groupID, nil, nil, nil, nil}
	if member != nil {
		arguments[2], arguments[3], arguments[4] = member.taskID, member.workerID, member.fenceToken
	}
	return queue.submitEnqueueRequests(ctx, requests, func(ctx context.Context, input []byte) ([]Row, error) {
		arguments[1] = input
		return queue.executor.Query(ctx, internalStatementRegistry[addTaskGroupMembersStatementName], arguments...)
	})
}

// SealTaskGroup seals an open group. Sealing a sealed or finished group changes nothing.
func (queue *Queue) SealTaskGroup(ctx context.Context, groupID string) (TaskGroup, error) {
	if err := queue.compatibility.Assert(ctx); err != nil {
		return TaskGroup{}, err
	}
	rows, err := queue.executor.Query(ctx, internalStatementRegistry[sealTaskGroupStatementName], groupID)
	if err != nil {
		return TaskGroup{}, err
	}
	if len(rows) != 1 {
		return TaskGroup{}, fmt.Errorf(invalidTaskGroupRowCountFormat, sealTaskGroupStatementName, len(rows))
	}
	return taskGroupFromRow(rows[0], sealTaskGroupStatementName)
}

// GetTaskGroup reads the state, counts, and callbacks of a group, or returns nil for an unknown
// group.
func (queue *Queue) GetTaskGroup(ctx context.Context, groupID string) (*TaskGroup, error) {
	if err := queue.compatibility.Assert(ctx); err != nil {
		return nil, err
	}
	return getTaskGroup(ctx, queue.executor, internalStatementRegistry[getTaskGroupStatementName], groupID)
}

// ListTaskGroupMembers reads one page of the member tasks of a group, in the order they joined.
func (queue *Queue) ListTaskGroupMembers(
	ctx context.Context,
	groupID string,
	query TaskGroupMemberQuery,
) (TaskGroupMemberPage, error) {
	if err := queue.compatibility.Assert(ctx); err != nil {
		return TaskGroupMemberPage{}, err
	}
	return listTaskGroupMembers(
		ctx, queue.executor, internalStatementRegistry[listTaskGroupMembersStatementName], groupID, query,
	)
}

// FindTaskGroup reads the group a task is a member of, or whose callback the task is. It returns
// nil for a task with no group.
func (queue *Queue) FindTaskGroup(ctx context.Context, taskID string) (*TaskGroupLink, error) {
	if err := queue.compatibility.Assert(ctx); err != nil {
		return nil, err
	}
	return findTaskGroup(ctx, queue.executor, taskID)
}

func getTaskGroup(ctx context.Context, executor Executor, statement, groupID string) (*TaskGroup, error) {
	rows, err := executor.Query(ctx, statement, groupID)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	group, err := taskGroupFromRow(rows[0], getTaskGroupStatementName)
	if err != nil {
		return nil, err
	}
	return &group, nil
}

func findTaskGroup(ctx context.Context, executor Executor, taskID string) (*TaskGroupLink, error) {
	rows, err := executor.Query(ctx, internalStatementRegistry[taskGroupForTaskStatementName], taskID)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	row := rows[0]
	invalid := fmt.Errorf(invalidTaskGroupResultFormat, taskGroupForTaskStatementName)
	group, err := taskGroupFromRow(row, taskGroupForTaskStatementName)
	if err != nil {
		return nil, err
	}
	role, ok := row[rowRoleField].(string)
	if !ok || (TaskGroupRole(role) != TaskGroupMemberRole && TaskGroupRole(role) != TaskGroupCallbackRole) {
		return nil, invalid
	}
	link := &TaskGroupLink{Role: TaskGroupRole(role), Group: group}
	if row[rowCallbackKindField] != nil {
		column, _ := row[rowCallbackKindField].(string)
		kind, ok := taskGroupCallbackKind(column)
		if !ok {
			return nil, invalid
		}
		link.Callback = &kind
	}
	return link, nil
}

func listTaskGroupMembers(
	ctx context.Context,
	executor Executor,
	statement string,
	groupID string,
	query TaskGroupMemberQuery,
) (TaskGroupMemberPage, error) {
	limit, err := taskGroupLimit(query.Limit, defaultTaskGroupMemberLimit, MaxTaskGroupPageSize)
	if err != nil {
		return TaskGroupMemberPage{}, err
	}
	if query.After < 0 {
		return TaskGroupMemberPage{}, errors.New(taskGroupAfterRangeMessage)
	}
	rows, err := executor.Query(ctx, statement, groupID, query.After, limit)
	if err != nil {
		return TaskGroupMemberPage{}, err
	}
	invalid := fmt.Errorf(invalidTaskGroupResultFormat, listTaskGroupMembersStatementName)
	members := make([]TaskGroupMember, 0, len(rows))
	for _, row := range rows {
		position, positionOK := integer(row[rowPositionField])
		taskID, taskOK := uuidString(row[rowTaskIDField])
		addedAt, addedOK := row[rowAddedAtField].(time.Time)
		queueName, queueOK := optionalString(row[rowQueueNameField])
		taskType, typeOK := optionalString(row[rowTaskTypeField])
		state, stateOK := optionalTaskState(row[rowStateField])
		outcome, outcomeOK := optionalTaskGroupMemberOutcome(row[rowOutcomeField])
		countedAt, countedOK := optionalTime(row[rowCountedAtField])
		if !positionOK || !taskOK || !addedOK || !queueOK || !typeOK || !stateOK || !outcomeOK || !countedOK {
			return TaskGroupMemberPage{}, invalid
		}
		members = append(members, TaskGroupMember{
			Position: position, TaskID: taskID, Queue: queueName, Type: taskType, State: state,
			Outcome: outcome, AddedAt: addedAt, CountedAt: countedAt,
		})
	}
	page := TaskGroupMemberPage{Members: members}
	if len(members) == limit {
		next := members[len(members)-1].Position
		page.NextAfter = &next
	}
	return page, nil
}

func optionalTaskGroupMemberOutcome(value any) (*TaskGroupMemberOutcome, bool) {
	if value == nil {
		return nil, true
	}
	text, ok := value.(string)
	outcome := TaskGroupMemberOutcome(text)
	switch outcome {
	case TaskGroupMemberSucceeded, TaskGroupMemberFailed, TaskGroupMemberCanceled:
		return &outcome, ok
	default:
		return nil, false
	}
}

func taskGroupCallbackKind(column string) (TaskGroupCallbackKind, bool) {
	switch column {
	case taskGroupOnFinishColumnValue:
		return TaskGroupOnFinish, true
	case taskGroupOnSuccessColumnValue:
		return TaskGroupOnSuccess, true
	case taskGroupOnFailureColumnValue:
		return TaskGroupOnFailure, true
	default:
		return emptyString, false
	}
}

// taskGroupFromRow reads the columns that get_task_group_v1 and the statements built on it return.
func taskGroupFromRow(row Row, statement string) (TaskGroup, error) {
	invalid := fmt.Errorf(invalidTaskGroupResultFormat, statement)
	groupID, idOK := uuidString(row[rowGroupIDField])
	state, stateOK := row[rowStateField].(string)
	total, totalOK := integer(row[rowTotalField])
	succeeded, succeededOK := integer(row[rowSucceededField])
	failed, failedOK := integer(row[rowFailedField])
	canceled, canceledOK := integer(row[rowCanceledField])
	pending, pendingOK := integer(row[rowPendingField])
	createdAt, createdOK := row[rowCreatedAtField].(time.Time)
	sealedAt, sealedOK := optionalTime(row[rowSealedAtField])
	finishedAt, finishedOK := optionalTime(row[rowFinishedAtField])
	canceledAt, canceledAtOK := optionalTime(row[rowCanceledAtField])
	canceledBy, canceledByOK := optionalString(row[rowCanceledByField])
	cancelReason, reasonOK := optionalString(row[rowCancelReasonField])
	if !idOK || !stateOK || !totalOK || !succeededOK || !failedOK || !canceledOK || !pendingOK ||
		!createdOK || !sealedOK || !finishedOK || !canceledAtOK || !canceledByOK || !reasonOK {
		return TaskGroup{}, invalid
	}
	switch TaskGroupState(state) {
	case TaskGroupOpen, TaskGroupSealed, TaskGroupFinished:
	default:
		return TaskGroup{}, invalid
	}
	group := TaskGroup{
		ID: groupID, State: TaskGroupState(state),
		Counts: TaskGroupCounts{
			Total: total, Succeeded: succeeded, Failed: failed, Canceled: canceled, Pending: pending,
		},
		CreatedAt: createdAt, SealedAt: sealedAt, FinishedAt: finishedAt, CanceledAt: canceledAt,
		CanceledBy: canceledBy, CancelReason: cancelReason, Callbacks: []TaskGroupCallback{},
	}
	if row[rowResultField] != nil {
		result, ok := row[rowResultField].(string)
		if !ok || (TaskGroupResult(result) != TaskGroupSucceeded && TaskGroupResult(result) != TaskGroupFailed) {
			return TaskGroup{}, invalid
		}
		value := TaskGroupResult(result)
		group.Result = &value
	}
	decoded, err := decodedJSON(row[rowCallbacksField])
	if err != nil {
		return TaskGroup{}, invalid
	}
	callbacks, ok := decoded.(map[string]any)
	if !ok {
		return TaskGroup{}, invalid
	}
	for _, column := range []string{taskGroupOnFinishColumnValue, taskGroupOnSuccessColumnValue, taskGroupOnFailureColumnValue} {
		value, requested := callbacks[column]
		if !requested {
			continue
		}
		callback, ok := value.(map[string]any)
		if !ok {
			return TaskGroup{}, invalid
		}
		kind, _ := taskGroupCallbackKind(column)
		entry := TaskGroupCallback{Kind: kind}
		if callback[taskGroupCallbackTaskIDField] != nil {
			taskID, ok := uuidString(callback[taskGroupCallbackTaskIDField])
			if !ok {
				return TaskGroup{}, invalid
			}
			entry.TaskID = &taskID
		}
		group.Callbacks = append(group.Callbacks, entry)
	}
	return group, nil
}

// GetTaskGroup reads the group this task is a member of, or whose callback this task is, with its
// counts. It returns nil for a task with no group. The activation reads the group one time and
// keeps it.
func (handler *HandlerContext) GetTaskGroup() (*TaskGroupLink, error) {
	handler.taskGroup.Lock()
	defer handler.taskGroup.Unlock()
	if handler.taskGroupRead {
		return handler.taskGroupLink, nil
	}
	link, err := findTaskGroup(handler.context, handler.executor, handler.Task.ID)
	if err != nil {
		return nil, handler.childLookupError(err)
	}
	handler.taskGroupRead = true
	handler.taskGroupLink = link
	return link, nil
}

// AddToTaskGroup adds up to MaxEnqueueBatchSize tasks to the group of this member task, under the
// current fenced lease. A running member task can add tasks after the seal, until its group is
// canceled. A request without a queue goes to the default queue. ErrNotTaskGroupMember reports a
// task that is not a member task.
func (handler *HandlerContext) AddToTaskGroup(requests []EnqueueRequest) ([]EnqueueResult, error) {
	if err := validateTaskGroupRequests(requests); err != nil {
		return nil, err
	}
	link, err := handler.GetTaskGroup()
	if err != nil {
		return nil, err
	}
	if link == nil || link.Role != TaskGroupMemberRole {
		return nil, fmt.Errorf(notTaskGroupMemberFormat, ErrNotTaskGroupMember, handler.Task.ID)
	}
	if err := context.Cause(handler.context); err != nil {
		return nil, err
	}
	handler.taskGroup.Lock()
	if handler.taskGroupQueue == nil {
		// The queue shares the worker's contract cache, so a contracted task type is loaded once for
		// the worker and not once for each activation.
		compatibility := handler.compatibility
		if compatibility == nil {
			compatibility = NewCachedCompatibilityCheck(handler.executor)
		}
		contracts := handler.contracts
		if contracts == nil {
			cache := newContractCache()
			contracts = &cache
		}
		handler.taskGroupQueue = &Queue{
			executor: handler.executor, defaultQueue: defaultWorkerQueueValue,
			compatibility: compatibility, contracts: contracts,
		}
	}
	queue := handler.taskGroupQueue
	handler.taskGroup.Unlock()
	lease := fencedLease{taskID: handler.Task.ID, workerID: handler.workerID, fenceToken: handler.Task.FenceToken}
	results, err := queue.addToTaskGroup(handler.context, link.Group.ID, requests, &lease)
	if err != nil {
		return nil, handler.childLookupError(err)
	}
	return results, nil
}

// GetTaskGroup reads the state, counts, and callbacks of a group, or returns nil for an unknown
// group.
func (admin *Admin) GetTaskGroup(ctx context.Context, groupID string) (*TaskGroup, error) {
	if err := AssertSchemaCompatible(ctx, admin.executor); err != nil {
		return nil, err
	}
	return getTaskGroup(ctx, admin.executor, adminStatementRegistry[getTaskGroupStatementName], groupID)
}

// ListTaskGroupMembers reads one page of the member tasks of a group, in the order they joined.
func (admin *Admin) ListTaskGroupMembers(
	ctx context.Context,
	groupID string,
	query TaskGroupMemberQuery,
) (TaskGroupMemberPage, error) {
	if err := AssertSchemaCompatible(ctx, admin.executor); err != nil {
		return TaskGroupMemberPage{}, err
	}
	return listTaskGroupMembers(
		ctx, admin.executor, adminStatementRegistry[listTaskGroupMembersStatementName], groupID, query,
	)
}

// ListTaskGroupEvents reads the history of a group in time order: create, seal, cancel, finish,
// callbacks, and repairs. A zero limit reads 1,000 events.
func (admin *Admin) ListTaskGroupEvents(ctx context.Context, groupID string, limit int) ([]TaskGroupEvent, error) {
	limit, err := taskGroupLimit(limit, defaultTaskGroupAdminLimit, MaxTaskGroupPageSize)
	if err != nil {
		return nil, err
	}
	rows, err := admin.query(ctx, adminStatementRegistry[listTaskGroupEventsStatementName], groupID, limit)
	if err != nil {
		return nil, err
	}
	invalid := fmt.Errorf(invalidTaskGroupResultFormat, listTaskGroupEventsStatementName)
	events := make([]TaskGroupEvent, 0, len(rows))
	for _, row := range rows {
		eventID, idOK := uuidString(row[rowEventIDField])
		eventType, typeOK := row[rowEventTypeField].(string)
		occurredAt, occurredOK := row[rowOccurredAtField].(time.Time)
		details, err := decodedJSON(row[rowDetailsField])
		if !idOK || !typeOK || !occurredOK || err != nil {
			return nil, invalid
		}
		events = append(events, TaskGroupEvent{
			ID: eventID, Type: TaskGroupEventType(eventType), Details: details, OccurredAt: occurredAt,
		})
	}
	return events, nil
}

// CancelTaskGroup seals an open group, so no task can join it after this call, not even from a
// running member task. Then it cancels every member task that is not terminal. The canceled
// members count as not succeeded, so the group finishes as usual and OnFinish and OnFailure run. A
// finished group stays unchanged. It returns nil for an unknown group.
func (admin *Admin) CancelTaskGroup(ctx context.Context, groupID string, audit AdminAudit) (*TaskGroup, error) {
	if err := validateAdminAudit(audit); err != nil {
		return nil, err
	}
	rows, err := admin.query(
		ctx, adminStatementRegistry[cancelTaskGroupStatementName], groupID, audit.Actor, audit.Reason, audit.RequestID,
	)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	group, err := taskGroupFromRow(rows[0], cancelTaskGroupStatementName)
	if err != nil {
		return nil, err
	}
	return &group, nil
}

// ListTaskGroupDrift lists groups that are not finished and whose counters disagree with their
// member outcomes, and sealed groups whose members are all finished. It writes nothing, so it is
// the dry run of RepairTaskGroupDrift. A zero limit examines 1,000 groups.
func (admin *Admin) ListTaskGroupDrift(ctx context.Context, limit int) ([]TaskGroupDrift, error) {
	limit, err := taskGroupLimit(limit, defaultTaskGroupAdminLimit, MaxTaskGroupDriftLimit)
	if err != nil {
		return nil, err
	}
	rows, err := admin.query(ctx, adminStatementRegistry[listTaskGroupDriftStatementName], limit)
	if err != nil {
		return nil, err
	}
	invalid := fmt.Errorf(invalidTaskGroupResultFormat, listTaskGroupDriftStatementName)
	drift := make([]TaskGroupDrift, 0, len(rows))
	for _, row := range rows {
		groupID, idOK := uuidString(row[rowGroupIDField])
		state, stateOK := row[rowStateField].(string)
		action, actionOK := row[rowActionField].(string)
		counts, countsOK := taskGroupIntegers(row,
			rowRecordedTotalField, rowRecordedSucceededField, rowRecordedFailedField, rowRecordedCanceledField,
			rowTotalField, rowSucceededField, rowFailedField, rowCanceledField, rowPendingField,
		)
		if !idOK || !stateOK || !actionOK || !countsOK {
			return nil, invalid
		}
		drift = append(drift, TaskGroupDrift{
			GroupID: groupID, State: TaskGroupState(state),
			Recorded: TaskGroupRecordedCounts{
				Total: counts[0], Succeeded: counts[1], Failed: counts[2], Canceled: counts[3],
			},
			Counted: TaskGroupCounts{
				Total: counts[4], Succeeded: counts[5], Failed: counts[6], Canceled: counts[7], Pending: counts[8],
			},
			Action: TaskGroupRepairAction(action),
		})
	}
	return drift, nil
}

// RepairTaskGroupDrift recounts each group that ListTaskGroupDrift reports from its member
// outcomes, and finishes a sealed group with no pending member. The counter_repaired event of each
// repaired group records the audit. A zero limit examines 1,000 groups.
func (admin *Admin) RepairTaskGroupDrift(ctx context.Context, audit AdminAudit, limit int) ([]TaskGroupRepair, error) {
	if err := validateAdminAudit(audit); err != nil {
		return nil, err
	}
	limit, err := taskGroupLimit(limit, defaultTaskGroupAdminLimit, MaxTaskGroupDriftLimit)
	if err != nil {
		return nil, err
	}
	rows, err := admin.query(
		ctx, adminStatementRegistry[repairTaskGroupDriftStatementName], limit, audit.Actor, audit.Reason, audit.RequestID,
	)
	if err != nil {
		return nil, err
	}
	invalid := fmt.Errorf(invalidTaskGroupResultFormat, repairTaskGroupDriftStatementName)
	repairs := make([]TaskGroupRepair, 0, len(rows))
	for _, row := range rows {
		groupID, idOK := uuidString(row[rowGroupIDField])
		action, actionOK := row[rowActionField].(string)
		counts, countsOK := taskGroupIntegers(row, rowRecordedPendingField, rowPendingField)
		if !idOK || !actionOK || !countsOK {
			return nil, invalid
		}
		repairs = append(repairs, TaskGroupRepair{
			GroupID: groupID, RecordedPending: counts[0], Pending: counts[1], Action: TaskGroupRepairAction(action),
		})
	}
	return repairs, nil
}

func taskGroupIntegers(row Row, columns ...string) ([]int, bool) {
	values := make([]int, len(columns))
	for index, column := range columns {
		value, ok := integer(row[column])
		if !ok {
			return nil, false
		}
		values[index] = value
	}
	return values, true
}
