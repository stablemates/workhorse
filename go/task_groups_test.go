package workhorse_test

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

type taskGroupFixture struct {
	ctx   context.Context
	pool  *pgxpool.Pool
	queue *workhorse.Queue
	admin *workhorse.Admin
}

func newTaskGroupFixture(t *testing.T, adapter string) taskGroupFixture {
	t.Helper()
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), adapter)
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	executor := workhorse.NewPGXExecutor(pool)
	return taskGroupFixture{
		ctx: ctx, pool: pool, queue: workhorse.NewQueue(executor, "default"), admin: workhorse.NewAdmin(executor),
	}
}

func groupMember(queueName string, payload int, options ...workhorse.EnqueueOptions) workhorse.EnqueueRequest {
	request := workhorse.EnqueueRequest{Type: "member", Payload: payload}
	if len(options) == 1 {
		request.Options = options[0]
	}
	request.Options.Queue = queueName
	request.Options.MaxAttempts = 1
	return request
}

func groupCallbacks(queueName string) workhorse.TaskGroupCallbacks {
	return workhorse.TaskGroupCallbacks{
		OnFinish:  &workhorse.EnqueueRequest{Type: "finished", Payload: map[string]any{"kind": "finish"}, Options: workhorse.EnqueueOptions{Queue: queueName}},
		OnSuccess: &workhorse.EnqueueRequest{Type: "succeeded", Payload: map[string]any{"kind": "success"}, Options: workhorse.EnqueueOptions{Queue: queueName}},
		OnFailure: &workhorse.EnqueueRequest{Type: "failed", Payload: map[string]any{"kind": "failure"}, Options: workhorse.EnqueueOptions{Queue: queueName}},
	}
}

func groupAudit(reason string) workhorse.AdminAudit {
	return workhorse.AdminAudit{Actor: "go-test", Reason: reason, RequestID: fmt.Sprintf("%s-%d", reason, time.Now().UnixNano())}
}

// runGroupWorker processes every ready task on queueName with handler, one task at a time.
func (fixture taskGroupFixture) runGroupWorker(
	t *testing.T,
	queueName string,
	handler workhorse.Handler,
) {
	t.Helper()
	worker, err := workhorse.NewWorker(fixture.pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: queueName + "-worker", LeaseDuration: 5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("member", handler)
	for {
		processed, err := worker.RunOnce(fixture.ctx)
		if err != nil {
			t.Fatal(err)
		}
		if !processed {
			return
		}
	}
}

func succeedMember(context.Context, any, *workhorse.HandlerContext) (any, error) { return nil, nil }

func (fixture taskGroupFixture) taskTypes(t *testing.T, queueName string) []string {
	t.Helper()
	rows, err := fixture.pool.Query(fixture.ctx, "SELECT task_type FROM workhorse.task WHERE queue_name = $1 ORDER BY task_type", queueName)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	types := []string{}
	for rows.Next() {
		var taskType string
		if err := rows.Scan(&taskType); err != nil {
			t.Fatal(err)
		}
		types = append(types, taskType)
	}
	return types
}

func (fixture taskGroupFixture) eventTypes(t *testing.T, groupID string) []workhorse.TaskGroupEventType {
	t.Helper()
	events, err := fixture.admin.ListTaskGroupEvents(fixture.ctx, groupID, 0)
	if err != nil {
		t.Fatal(err)
	}
	types := make([]workhorse.TaskGroupEventType, len(events))
	for index, event := range events {
		types[index] = event.Type
	}
	return types
}

func (fixture taskGroupFixture) group(t *testing.T, groupID string) workhorse.TaskGroup {
	t.Helper()
	group, err := fixture.queue.GetTaskGroup(fixture.ctx, groupID)
	if err != nil {
		t.Fatal(err)
	}
	if group == nil {
		t.Fatalf("task group %s is missing", groupID)
	}
	return *group
}

func TestTaskGroupBlockFormEnqueuesOnFinishAndOnSuccess(t *testing.T) {
	fixture := newTaskGroupFixture(t, "go-task-group-block")
	block, err := fixture.queue.TaskGroup(fixture.ctx, groupCallbacks("block-callbacks"), func(builder *workhorse.TaskGroupBuilder) error {
		if err := builder.Add(groupMember("block-members", 1), groupMember("block-members", 2)); err != nil {
			return err
		}
		return builder.Add(groupMember("block-members", 3))
	})
	if err != nil {
		t.Fatal(err)
	}
	if block.Group.State != workhorse.TaskGroupSealed || block.Group.Result != nil ||
		block.Group.Counts != (workhorse.TaskGroupCounts{Total: 3, Pending: 3}) {
		t.Fatalf("unexpected sealed group: %+v", block.Group)
	}
	if len(block.Tasks) != 3 {
		t.Fatalf("expected three results, received %+v", block.Tasks)
	}
	for _, task := range block.Tasks {
		if task.Outcome != workhorse.EnqueueAccepted {
			t.Fatalf("unexpected enqueue result: %+v", task)
		}
	}

	fixture.runGroupWorker(t, "block-members", succeedMember)
	finished := fixture.group(t, block.Group.ID)
	if finished.State != workhorse.TaskGroupFinished || finished.Result == nil ||
		*finished.Result != workhorse.TaskGroupSucceeded ||
		finished.Counts != (workhorse.TaskGroupCounts{Total: 3, Succeeded: 3}) || finished.FinishedAt == nil {
		t.Fatalf("unexpected finished group: %+v", finished)
	}
	kinds := make([]workhorse.TaskGroupCallbackKind, len(finished.Callbacks))
	for index, callback := range finished.Callbacks {
		kinds[index] = callback.Kind
	}
	if !reflect.DeepEqual(kinds, []workhorse.TaskGroupCallbackKind{
		workhorse.TaskGroupOnFinish, workhorse.TaskGroupOnSuccess, workhorse.TaskGroupOnFailure,
	}) {
		t.Fatalf("unexpected callbacks: %+v", finished.Callbacks)
	}
	if finished.Callbacks[0].TaskID == nil || finished.Callbacks[1].TaskID == nil || finished.Callbacks[2].TaskID != nil {
		t.Fatalf("unexpected callback tasks: %+v", finished.Callbacks)
	}
	if got := fixture.taskTypes(t, "block-callbacks"); !reflect.DeepEqual(got, []string{"finished", "succeeded"}) {
		t.Fatalf("unexpected callback tasks: %v", got)
	}
	if got := fixture.eventTypes(t, block.Group.ID); !reflect.DeepEqual(got, []workhorse.TaskGroupEventType{
		workhorse.TaskGroupCreatedEvent, workhorse.TaskGroupSealedEvent, workhorse.TaskGroupFinishedEvent,
		workhorse.TaskGroupCallbackEnqueuedEvent, workhorse.TaskGroupCallbackEnqueuedEvent,
	}) {
		t.Fatalf("unexpected events: %v", got)
	}

	page, err := fixture.queue.ListTaskGroupMembers(fixture.ctx, block.Group.ID, workhorse.TaskGroupMemberQuery{Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Members) != 2 || page.NextAfter == nil || *page.NextAfter != 2 {
		t.Fatalf("unexpected first page: %+v", page)
	}
	for index, item := range page.Members {
		if item.Position != index+1 || item.TaskID != block.Tasks[index].TaskID ||
			item.Outcome == nil || *item.Outcome != workhorse.TaskGroupMemberSucceeded ||
			item.State == nil || *item.State != workhorse.TaskSucceeded ||
			item.Queue == nil || *item.Queue != "block-members" || item.CountedAt == nil {
			t.Fatalf("unexpected member: %+v", item)
		}
	}
	rest, err := fixture.admin.ListTaskGroupMembers(fixture.ctx, block.Group.ID, workhorse.TaskGroupMemberQuery{After: *page.NextAfter})
	if err != nil {
		t.Fatal(err)
	}
	if len(rest.Members) != 1 || rest.Members[0].Position != 3 || rest.NextAfter != nil {
		t.Fatalf("unexpected last page: %+v", rest)
	}
	if fromAdmin, err := fixture.admin.GetTaskGroup(fixture.ctx, block.Group.ID); err != nil || !reflect.DeepEqual(*fromAdmin, finished) {
		t.Fatalf("admin read differs: %+v %v", fromAdmin, err)
	}
}

func TestTaskGroupCreatedInARolledBackTransactionDoesNotExist(t *testing.T) {
	fixture := newTaskGroupFixture(t, "go-task-group-transaction")
	transaction, err := fixture.pool.Begin(fixture.ctx)
	if err != nil {
		t.Fatal(err)
	}
	inTransaction := workhorse.NewQueue(workhorse.NewPGXExecutor(transaction), "default")
	block, err := inTransaction.TaskGroup(fixture.ctx, groupCallbacks("rollback-callbacks"), func(builder *workhorse.TaskGroupBuilder) error {
		return builder.Add(groupMember("rollback-members", 1))
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := transaction.Rollback(fixture.ctx); err != nil {
		t.Fatal(err)
	}
	if group, err := fixture.queue.GetTaskGroup(fixture.ctx, block.Group.ID); err != nil || group != nil {
		t.Fatalf("rolled back group is visible: %+v %v", group, err)
	}
	if got := fixture.taskTypes(t, "rollback-members"); len(got) != 0 {
		t.Fatalf("rolled back members are visible: %v", got)
	}

	builderFailure := errors.New("stop")
	if _, err := fixture.queue.TaskGroup(fixture.ctx, workhorse.TaskGroupCallbacks{}, func(*workhorse.TaskGroupBuilder) error {
		return builderFailure
	}); !errors.Is(err, builderFailure) {
		t.Fatalf("expected the build error, received %v", err)
	}
}

func TestTaskGroupCallbackHandlerReadsTheGroupAndAMemberAddsAfterTheSeal(t *testing.T) {
	fixture := newTaskGroupFixture(t, "go-task-group-context")
	block, err := fixture.queue.TaskGroup(fixture.ctx, workhorse.TaskGroupCallbacks{
		OnFinish: &workhorse.EnqueueRequest{Type: "report", Payload: map[string]any{"report": true}, Options: workhorse.EnqueueOptions{Queue: "context-callbacks"}},
	}, func(builder *workhorse.TaskGroupBuilder) error {
		return builder.Add(groupMember("context-members", 1))
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = fixture.queue.AddToTaskGroup(fixture.ctx, block.Group.ID, []workhorse.EnqueueRequest{groupMember("context-members", 2)})
	var closed *workhorse.TaskGroupClosedError
	if !errors.As(err, &closed) || !errors.Is(err, workhorse.ErrTaskGroupClosed) ||
		closed.Details != (workhorse.TaskGroupClosedDetails{GroupID: block.Group.ID, State: workhorse.TaskGroupSealed, Reason: workhorse.TaskGroupRefusedSealed}) {
		t.Fatalf("expected a sealed refusal, received %v", err)
	}

	var memberLinks []*workhorse.TaskGroupLink
	fixture.runGroupWorker(t, "context-members", func(_ context.Context, payload any, handler *workhorse.HandlerContext) (any, error) {
		link, err := handler.GetTaskGroup()
		if err != nil {
			return nil, err
		}
		memberLinks = append(memberLinks, link)
		if payload == float64(1) {
			results, err := handler.AddToTaskGroup([]workhorse.EnqueueRequest{groupMember("context-members", 10)})
			if err != nil {
				return nil, err
			}
			if len(results) != 1 || results[0].Outcome != workhorse.EnqueueAccepted {
				return nil, fmt.Errorf("unexpected member add: %+v", results)
			}
			return nil, errors.New("fail after the add")
		}
		return nil, nil
	})
	if len(memberLinks) != 2 {
		t.Fatalf("expected two member activations, received %d", len(memberLinks))
	}
	for _, link := range memberLinks {
		if link == nil || link.Role != workhorse.TaskGroupMemberRole || link.Callback != nil || link.Group.ID != block.Group.ID {
			t.Fatalf("unexpected member link: %+v", link)
		}
	}

	var callbackLink *workhorse.TaskGroupLink
	var callbackPayload any
	worker, err := workhorse.NewWorker(fixture.pool, workhorse.WorkerOptions{Queue: "context-callbacks", WorkerID: "context-callback-worker"})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("report", func(_ context.Context, payload any, handler *workhorse.HandlerContext) (any, error) {
		callbackPayload = payload
		if callbackLink, err = handler.GetTaskGroup(); err != nil {
			return nil, err
		}
		_, addErr := handler.AddToTaskGroup([]workhorse.EnqueueRequest{groupMember("context-members", 3)})
		if !errors.Is(addErr, workhorse.ErrNotTaskGroupMember) {
			return nil, fmt.Errorf("expected ErrNotTaskGroupMember, received %v", addErr)
		}
		return nil, nil
	})
	if processed, err := worker.RunOnce(fixture.ctx); err != nil || !processed {
		t.Fatalf("run callback: processed=%t err=%v", processed, err)
	}
	if !reflect.DeepEqual(callbackPayload, map[string]any{"report": true}) {
		t.Fatalf("unexpected callback payload: %#v", callbackPayload)
	}
	if callbackLink == nil || callbackLink.Role != workhorse.TaskGroupCallbackRole || callbackLink.Callback == nil ||
		*callbackLink.Callback != workhorse.TaskGroupOnFinish || callbackLink.Group.ID != block.Group.ID ||
		callbackLink.Group.Result == nil || *callbackLink.Group.Result != workhorse.TaskGroupFailed ||
		callbackLink.Group.Counts != (workhorse.TaskGroupCounts{Total: 2, Succeeded: 1, Failed: 1}) {
		t.Fatalf("unexpected callback link: %+v", callbackLink)
	}
	if link, err := fixture.queue.FindTaskGroup(fixture.ctx, block.Tasks[0].TaskID); err != nil || link == nil || link.Role != workhorse.TaskGroupMemberRole {
		t.Fatalf("unexpected member lookup: %+v %v", link, err)
	}
}

func TestTaskGroupMemberAddWithoutAQueueGoesToTheQueueOfTheMember(t *testing.T) {
	fixture := newTaskGroupFixture(t, "go-task-group-default-add")
	block, err := fixture.queue.TaskGroup(fixture.ctx, workhorse.TaskGroupCallbacks{}, func(builder *workhorse.TaskGroupBuilder) error {
		return builder.Add(groupMember("default-add", 1))
	})
	if err != nil {
		t.Fatal(err)
	}
	// The worker drains its queue, so only the first member adds a task.
	added := false
	fixture.runGroupWorker(t, "default-add", func(_ context.Context, _ any, handler *workhorse.HandlerContext) (any, error) {
		if added {
			return nil, nil
		}
		added = true
		unnamed := workhorse.EnqueueRequest{Type: "member", Payload: 2, Options: workhorse.EnqueueOptions{MaxAttempts: 1}}
		results, err := handler.AddToTaskGroup([]workhorse.EnqueueRequest{unnamed})
		if err != nil {
			return nil, err
		}
		if len(results) != 1 || results[0].Outcome != workhorse.EnqueueAccepted {
			return nil, fmt.Errorf("unexpected member add: %+v", results)
		}
		return nil, nil
	})

	page, err := fixture.queue.ListTaskGroupMembers(fixture.ctx, block.Group.ID, workhorse.TaskGroupMemberQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Members) != 2 || page.Members[0].Queue == nil || *page.Members[0].Queue != "default-add" ||
		page.Members[1].Queue == nil || *page.Members[1].Queue != "default-add" {
		t.Fatalf("unexpected members: %+v", page.Members)
	}
	var queueName string
	if err := fixture.pool.QueryRow(fixture.ctx, "SELECT queue_name FROM workhorse.task WHERE id = $1", page.Members[1].TaskID).Scan(&queueName); err != nil {
		t.Fatal(err)
	}
	if queueName != "default-add" {
		t.Fatalf("expected the added member on the queue of its member task, found %q", queueName)
	}

	if group := fixture.group(t, block.Group.ID); group.State != workhorse.TaskGroupFinished ||
		group.Counts != (workhorse.TaskGroupCounts{Total: 2, Succeeded: 2}) {
		t.Fatalf("unexpected finished group: %+v", group)
	}
}

func TestTaskGroupEmptyGroupFinishesAtTheSealAndRefusesAnAdd(t *testing.T) {
	fixture := newTaskGroupFixture(t, "go-task-group-empty")
	group, err := fixture.queue.CreateTaskGroup(fixture.ctx, groupCallbacks("empty-callbacks"))
	if err != nil {
		t.Fatal(err)
	}
	if group.State != workhorse.TaskGroupOpen || group.Counts.Total != 0 || len(group.Callbacks) != 3 {
		t.Fatalf("unexpected open group: %+v", group)
	}
	sealed, err := fixture.queue.SealTaskGroup(fixture.ctx, group.ID)
	if err != nil {
		t.Fatal(err)
	}
	if sealed.State != workhorse.TaskGroupFinished || sealed.Result == nil || *sealed.Result != workhorse.TaskGroupSucceeded {
		t.Fatalf("unexpected sealed group: %+v", sealed)
	}
	if got := fixture.taskTypes(t, "empty-callbacks"); !reflect.DeepEqual(got, []string{"finished", "succeeded"}) {
		t.Fatalf("unexpected callback tasks: %v", got)
	}
	_, err = fixture.queue.AddToTaskGroup(fixture.ctx, group.ID, []workhorse.EnqueueRequest{groupMember("empty-members", 1)})
	var closed *workhorse.TaskGroupClosedError
	if !errors.As(err, &closed) || closed.Details.Reason != workhorse.TaskGroupRefusedFinished || closed.Details.State != workhorse.TaskGroupFinished {
		t.Fatalf("expected a finished refusal, received %v", err)
	}
	if again, err := fixture.queue.SealTaskGroup(fixture.ctx, group.ID); err != nil || again.State != workhorse.TaskGroupFinished {
		t.Fatalf("a second seal changed the group: %+v %v", again, err)
	}
	if results, err := fixture.queue.AddToTaskGroup(fixture.ctx, group.ID, nil); err != nil || len(results) != 0 {
		t.Fatalf("an empty add sent a statement: %+v %v", results, err)
	}
	if missing, err := fixture.queue.GetTaskGroup(fixture.ctx, "00000000-0000-4000-8000-000000000000"); err != nil || missing != nil {
		t.Fatalf("unexpected unknown group: %+v %v", missing, err)
	}
}

func TestTaskGroupMembershipRulesMapToGoErrors(t *testing.T) {
	fixture := newTaskGroupFixture(t, "go-task-group-rules")
	group, err := fixture.queue.CreateTaskGroup(fixture.ctx, workhorse.TaskGroupCallbacks{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.admin.SetQueueTier(fixture.ctx, "fast-members", workhorse.QueueTierFast, groupAudit("fast-tier")); err != nil {
		t.Fatal(err)
	}
	_, err = fixture.queue.AddToTaskGroup(fixture.ctx, group.ID, []workhorse.EnqueueRequest{groupMember("fast-members", 1)})
	var fast *workhorse.FastTierUnsupportedError
	if !errors.As(err, &fast) || fast.Feature != "task groups" || fast.Queue != "fast-members" {
		t.Fatalf("expected a fast-tier rejection, received %v", err)
	}

	_, err = fixture.queue.AddToTaskGroup(fixture.ctx, group.ID, []workhorse.EnqueueRequest{
		groupMember("rules", 1, workhorse.EnqueueOptions{Debounce: &workhorse.Debounce{Key: "k", WindowMS: 1_000}}),
	})
	if !errors.Is(err, workhorse.ErrInvalidEnqueueOptions) || !strings.Contains(err.Error(), "debounce or throttle") {
		t.Fatalf("expected a coalescing rejection, received %v", err)
	}

	outside, err := fixture.queue.EnqueueMany(fixture.ctx, []workhorse.EnqueueRequest{
		groupMember("rules", 1, workhorse.EnqueueOptions{Idempotency: &workhorse.Idempotency{Key: "outside"}}),
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = fixture.queue.AddToTaskGroup(fixture.ctx, group.ID, []workhorse.EnqueueRequest{
		groupMember("rules", 1, workhorse.EnqueueOptions{Idempotency: &workhorse.Idempotency{Key: "outside"}}),
	})
	var conflict *workhorse.TaskGroupMembershipConflictError
	if !errors.As(err, &conflict) || !errors.Is(err, workhorse.ErrTaskGroupMembershipConflict) ||
		conflict.Details.GroupID != group.ID || conflict.Details.TaskID != outside[0] ||
		conflict.Details.Ordinal != 1 || conflict.Details.MemberOf != nil {
		t.Fatalf("expected a membership conflict, received %v", err)
	}

	inside := groupMember("rules", 2, workhorse.EnqueueOptions{Idempotency: &workhorse.Idempotency{Key: "inside"}})
	added, err := fixture.queue.AddToTaskGroup(fixture.ctx, group.ID, []workhorse.EnqueueRequest{inside})
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := fixture.queue.AddToTaskGroup(fixture.ctx, group.ID, []workhorse.EnqueueRequest{inside})
	if err != nil {
		t.Fatal(err)
	}
	if replayed[0] != (workhorse.EnqueueResult{TaskID: added[0].TaskID, Outcome: workhorse.EnqueueReplayed}) {
		t.Fatalf("unexpected idempotent retry: %+v", replayed)
	}
	if counts := fixture.group(t, group.ID).Counts; counts.Total != 1 {
		t.Fatalf("an idempotent retry added a member: %+v", counts)
	}
	other, err := fixture.queue.CreateTaskGroup(fixture.ctx, workhorse.TaskGroupCallbacks{})
	if err != nil {
		t.Fatal(err)
	}
	_, err = fixture.queue.AddToTaskGroup(fixture.ctx, other.ID, []workhorse.EnqueueRequest{inside})
	if !errors.As(err, &conflict) || conflict.Details.MemberOf == nil || *conflict.Details.MemberOf != group.ID {
		t.Fatalf("expected a conflict that names the first group, received %v", err)
	}

	tooMany := make([]workhorse.EnqueueRequest, workhorse.MaxEnqueueBatchSize+1)
	for index := range tooMany {
		tooMany[index] = groupMember("rules", index)
	}
	if _, err := fixture.queue.AddToTaskGroup(fixture.ctx, group.ID, tooMany); !errors.Is(err, workhorse.ErrEnqueueBatchTooLarge) {
		t.Fatalf("expected ErrEnqueueBatchTooLarge, received %v", err)
	}

	_, err = fixture.queue.CreateTaskGroup(fixture.ctx, workhorse.TaskGroupCallbacks{
		OnFinish: &workhorse.EnqueueRequest{Type: "cb", Options: workhorse.EnqueueOptions{Idempotency: &workhorse.Idempotency{Key: "k"}}},
	})
	if !errors.Is(err, workhorse.ErrInvalidEnqueueOptions) {
		t.Fatalf("expected a callback rejection, received %v", err)
	}
	if _, err := fixture.queue.ListTaskGroupMembers(fixture.ctx, group.ID, workhorse.TaskGroupMemberQuery{Limit: workhorse.MaxTaskGroupPageSize + 1}); err == nil {
		t.Fatal("expected a limit rejection")
	}
	if _, err := fixture.queue.ListTaskGroupMembers(fixture.ctx, group.ID, workhorse.TaskGroupMemberQuery{After: -1}); err == nil {
		t.Fatal("expected an after rejection")
	}
}

func TestTaskGroupBuilderRefusesMoreThanTheMemberLimit(t *testing.T) {
	builder := &workhorse.TaskGroupBuilder{}
	batch := make([]workhorse.EnqueueRequest, workhorse.MaxEnqueueBatchSize)
	for added := 0; added < workhorse.MaxTaskGroupMembers; added += len(batch) {
		if err := builder.Add(batch...); err != nil {
			t.Fatal(err)
		}
	}
	if err := builder.Add(workhorse.EnqueueRequest{}); !errors.Is(err, workhorse.ErrTaskGroupLimitExceeded) {
		t.Fatalf("expected ErrTaskGroupLimitExceeded, received %v", err)
	}
	if err := builder.Add(append(batch, workhorse.EnqueueRequest{})...); !errors.Is(err, workhorse.ErrEnqueueBatchTooLarge) {
		t.Fatalf("expected ErrEnqueueBatchTooLarge, received %v", err)
	}
}

func TestTaskGroupCallbackStoresTheCurrentContractVersionAfterAMismatch(t *testing.T) {
	fixture := newTaskGroupFixture(t, "go-task-group-contract")
	versions := map[string]workhorse.TaskContractVersion{
		"one": {PayloadSchema: map[string]any{}, ResultSchema: map[string]any{}},
		"two": {PayloadSchema: map[string]any{}, ResultSchema: map[string]any{}},
	}
	if err := fixture.queue.SyncContracts(fixture.ctx, map[string]workhorse.TaskTypeContracts{
		"contracted.callback": {CurrentVersion: "one", Versions: versions},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.pool.Exec(fixture.ctx, "SELECT workhorse.override_contract_version_v1('contracted.callback', 'two')"); err != nil {
		t.Fatal(err)
	}
	group, err := fixture.queue.CreateTaskGroup(fixture.ctx, workhorse.TaskGroupCallbacks{
		OnFinish: &workhorse.EnqueueRequest{Type: "contracted.callback", Payload: map[string]any{}, Options: workhorse.EnqueueOptions{Queue: "contract-callbacks"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	var version string
	var groups int
	if err := fixture.pool.QueryRow(fixture.ctx,
		"SELECT on_finish->>'contractVersion', (SELECT count(*)::integer FROM workhorse.task_group) FROM workhorse.task_group WHERE id = $1",
		group.ID,
	).Scan(&version, &groups); err != nil {
		t.Fatal(err)
	}
	if version != "two" || groups != 1 {
		t.Fatalf("expected one group with version two, received version %q and %d groups", version, groups)
	}
}

func TestTaskGroupAdminCancelsAGroupAndFinishesItThroughOnFailure(t *testing.T) {
	fixture := newTaskGroupFixture(t, "go-task-group-cancel")
	group, err := fixture.queue.CreateTaskGroup(fixture.ctx, groupCallbacks("cancel-callbacks"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.queue.AddToTaskGroup(fixture.ctx, group.ID, []workhorse.EnqueueRequest{
		groupMember("cancel-members", 1), groupMember("cancel-members", 2),
	}); err != nil {
		t.Fatal(err)
	}
	audit := groupAudit("stop-the-import")
	if _, err := fixture.admin.CancelTaskGroup(fixture.ctx, group.ID, workhorse.AdminAudit{}); err == nil {
		t.Fatal("expected an audit rejection")
	}
	canceled, err := fixture.admin.CancelTaskGroup(fixture.ctx, group.ID, audit)
	if err != nil {
		t.Fatal(err)
	}
	if canceled == nil || canceled.State != workhorse.TaskGroupFinished || canceled.Result == nil ||
		*canceled.Result != workhorse.TaskGroupFailed || canceled.Counts != (workhorse.TaskGroupCounts{Total: 2, Canceled: 2}) ||
		canceled.CanceledBy == nil || *canceled.CanceledBy != audit.Actor ||
		canceled.CancelReason == nil || *canceled.CancelReason != audit.Reason || canceled.CanceledAt == nil {
		t.Fatalf("unexpected canceled group: %+v", canceled)
	}
	if got := fixture.taskTypes(t, "cancel-callbacks"); !reflect.DeepEqual(got, []string{"failed", "finished"}) {
		t.Fatalf("unexpected callback tasks: %v", got)
	}
	_, err = fixture.queue.AddToTaskGroup(fixture.ctx, group.ID, []workhorse.EnqueueRequest{groupMember("cancel-members", 3)})
	var closed *workhorse.TaskGroupClosedError
	if !errors.As(err, &closed) || closed.Details.Reason != workhorse.TaskGroupRefusedCanceled {
		t.Fatalf("expected a canceled refusal, received %v", err)
	}
	again, err := fixture.admin.CancelTaskGroup(fixture.ctx, group.ID, groupAudit("again"))
	if err != nil || !reflect.DeepEqual(again, canceled) {
		t.Fatalf("a second cancel changed the group: %+v %v", again, err)
	}
	if unknown, err := fixture.admin.CancelTaskGroup(fixture.ctx, "00000000-0000-4000-8000-000000000000", groupAudit("unknown")); err != nil || unknown != nil {
		t.Fatalf("unexpected unknown cancel: %+v %v", unknown, err)
	}
}

func TestTaskGroupAdminFindsAndRepairsDrift(t *testing.T) {
	fixture := newTaskGroupFixture(t, "go-task-group-drift")
	block, err := fixture.queue.TaskGroup(fixture.ctx, groupCallbacks("drift-callbacks"), func(builder *workhorse.TaskGroupBuilder) error {
		return builder.Add(groupMember("drift-members", 1), groupMember("drift-members", 2))
	})
	if err != nil {
		t.Fatal(err)
	}
	fixture.runGroupWorker(t, "drift-members", succeedMember)
	for _, statement := range []string{
		"UPDATE workhorse.task_group_member SET outcome = NULL, counted_at = NULL WHERE group_id = $1",
		// The counts of a group that is not finished live in its shard rows (ADR 0096). The two
		// members are in shards 0 and 1, so two shards are pending.
		"UPDATE workhorse.task_group_shard SET succeeded_count = 0 WHERE group_id = $1",
		"UPDATE workhorse.task_group SET state = 'sealed', result = NULL, finished_at = NULL, total_count = 0, succeeded_count = 0, pending_shard_count = 2 WHERE id = $1",
		"DELETE FROM workhorse.task_group_callback WHERE group_id = $1",
	} {
		if _, err := fixture.pool.Exec(fixture.ctx, statement, block.Group.ID); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := fixture.pool.Exec(fixture.ctx, "DELETE FROM workhorse.task WHERE queue_name = 'drift-callbacks'"); err != nil {
		t.Fatal(err)
	}

	drift, err := fixture.admin.ListTaskGroupDrift(fixture.ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(drift, []workhorse.TaskGroupDrift{{
		GroupID: block.Group.ID, State: workhorse.TaskGroupSealed,
		Recorded: workhorse.TaskGroupRecordedCounts{Total: 2},
		Counted:  workhorse.TaskGroupCounts{Total: 2, Succeeded: 2},
		Action:   workhorse.TaskGroupRepairFinished,
	}}) {
		t.Fatalf("unexpected drift: %+v", drift)
	}
	if _, err := fixture.admin.ListTaskGroupDrift(fixture.ctx, workhorse.MaxTaskGroupDriftLimit+1); err == nil {
		t.Fatal("expected a limit rejection")
	}
	repairs, err := fixture.admin.RepairTaskGroupDrift(fixture.ctx, groupAudit("repair-the-counter"), 0)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(repairs, []workhorse.TaskGroupRepair{{
		GroupID: block.Group.ID, RecordedPending: 2, Pending: 0, Action: workhorse.TaskGroupRepairFinished,
	}}) {
		t.Fatalf("unexpected repairs: %+v", repairs)
	}
	repaired := fixture.group(t, block.Group.ID)
	if repaired.State != workhorse.TaskGroupFinished || repaired.Result == nil || *repaired.Result != workhorse.TaskGroupSucceeded {
		t.Fatalf("unexpected repaired group: %+v", repaired)
	}
	if got := fixture.taskTypes(t, "drift-callbacks"); !reflect.DeepEqual(got, []string{"finished", "succeeded"}) {
		t.Fatalf("unexpected callback tasks: %v", got)
	}
	events, err := fixture.admin.ListTaskGroupEvents(fixture.ctx, block.Group.ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	var details map[string]any
	for _, event := range events {
		if event.Type == workhorse.TaskGroupCounterRepairedEvent {
			details, _ = event.Details.(map[string]any)
		}
	}
	if details == nil || details["requested_by"] != "go-test" || details["request_reason"] != "repair-the-counter" {
		t.Fatalf("unexpected repair event: %+v", events)
	}
	if drift, err := fixture.admin.ListTaskGroupDrift(fixture.ctx, 0); err != nil || len(drift) != 0 {
		t.Fatalf("drift remains after the repair: %+v %v", drift, err)
	}
}

func TestTaskGroupReadsThroughDatabaseSQL(t *testing.T) {
	fixture := newTaskGroupFixture(t, "go-task-group-database-sql")
	block, err := fixture.queue.TaskGroup(fixture.ctx, groupCallbacks("sql-callbacks"), func(builder *workhorse.TaskGroupBuilder) error {
		return builder.Add(groupMember("sql-members", 1))
	})
	if err != nil {
		t.Fatal(err)
	}
	fixture.runGroupWorker(t, "sql-members", succeedMember)
	expected := fixture.group(t, block.Group.ID)

	database, err := sql.Open("pgx", fixture.pool.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	executor := workhorse.NewSQLExecutor(database)
	queue := workhorse.NewQueue(executor, "default")
	group, err := queue.GetTaskGroup(fixture.ctx, block.Group.ID)
	if err != nil {
		t.Fatal(err)
	}
	if group == nil || group.ID != expected.ID || group.State != expected.State || group.Counts != expected.Counts ||
		!reflect.DeepEqual(callbackKinds(group.Callbacks), callbackKinds(expected.Callbacks)) ||
		*group.Callbacks[0].TaskID != *expected.Callbacks[0].TaskID {
		t.Fatalf("database/sql read differs: %+v, want %+v", group, expected)
	}
	link, err := queue.FindTaskGroup(fixture.ctx, block.Tasks[0].TaskID)
	if err != nil || link == nil || link.Role != workhorse.TaskGroupMemberRole || link.Group.ID != block.Group.ID {
		t.Fatalf("unexpected database/sql link: %+v %v", link, err)
	}
	page, err := queue.ListTaskGroupMembers(fixture.ctx, block.Group.ID, workhorse.TaskGroupMemberQuery{})
	if err != nil || len(page.Members) != 1 || page.Members[0].TaskID != block.Tasks[0].TaskID {
		t.Fatalf("unexpected database/sql members: %+v %v", page, err)
	}
	events, err := workhorse.NewAdmin(executor).ListTaskGroupEvents(fixture.ctx, block.Group.ID, 0)
	if err != nil || len(events) == 0 || events[0].Type != workhorse.TaskGroupCreatedEvent {
		t.Fatalf("unexpected database/sql events: %+v %v", events, err)
	}
	if details, ok := events[0].Details.(map[string]any); !ok || details["callbacks"] == nil {
		t.Fatalf("database/sql left the event details undecoded: %#v", events[0].Details)
	}
}

func callbackKinds(callbacks []workhorse.TaskGroupCallback) []workhorse.TaskGroupCallbackKind {
	kinds := make([]workhorse.TaskGroupCallbackKind, len(callbacks))
	for index, callback := range callbacks {
		kinds[index] = callback.Kind
	}
	return kinds
}

func TestTaskGroupMemberAddStampsAndValidatesTheCurrentContract(t *testing.T) {
	fixture := newTaskGroupFixture(t, "go-task-group-member-contract")
	if err := fixture.queue.SyncContracts(fixture.ctx, map[string]workhorse.TaskTypeContracts{
		"contracted.member": {CurrentVersion: "v1", Versions: map[string]workhorse.TaskContractVersion{
			"v1": {PayloadSchema: requiredFieldSchema("value")},
		}},
	}); err != nil {
		t.Fatal(err)
	}
	block, err := fixture.queue.TaskGroup(fixture.ctx, workhorse.TaskGroupCallbacks{}, func(builder *workhorse.TaskGroupBuilder) error {
		return builder.Add(groupMember("contract-members", 1))
	})
	if err != nil {
		t.Fatal(err)
	}
	contracted := func(payload map[string]any) workhorse.EnqueueRequest {
		return workhorse.EnqueueRequest{Type: "contracted.member", Payload: payload, Options: workhorse.EnqueueOptions{Queue: "contract-added"}}
	}
	var added []workhorse.EnqueueResult
	var rejection error
	fixture.runGroupWorker(t, "contract-members", func(_ context.Context, _ any, handler *workhorse.HandlerContext) (any, error) {
		_, rejection = handler.AddToTaskGroup([]workhorse.EnqueueRequest{contracted(map[string]any{"other": 1})})
		var err error
		added, err = handler.AddToTaskGroup([]workhorse.EnqueueRequest{contracted(map[string]any{"value": 1})})
		return nil, err
	})
	var validation *workhorse.TaskContractValidationError
	if !errors.As(rejection, &validation) || validation.TaskType != "contracted.member" || validation.Version != "v1" {
		t.Fatalf("expected a contract validation error, received %v", rejection)
	}
	if len(added) != 1 {
		t.Fatalf("expected one added task, received %+v", added)
	}
	var version string
	if err := fixture.pool.QueryRow(fixture.ctx, "SELECT contract_version FROM workhorse.task WHERE id = $1", added[0].TaskID).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != "v1" {
		t.Fatalf("expected contract version v1, received %q", version)
	}
	if counts := fixture.group(t, block.Group.ID).Counts; counts.Total != 2 {
		t.Fatalf("expected two members, received %+v", counts)
	}
}

func TestTaskGroupBatchHandlerReadsAndAddsForEachTaskInTheBatch(t *testing.T) {
	fixture := newTaskGroupFixture(t, "go-task-group-batch")
	block, err := fixture.queue.TaskGroup(fixture.ctx, workhorse.TaskGroupCallbacks{}, func(builder *workhorse.TaskGroupBuilder) error {
		return builder.Add(groupMember("batch-add", 1), groupMember("batch-add", 2))
	})
	if err != nil {
		t.Fatal(err)
	}
	const workerID = "batch-add-worker"
	worker, err := workhorse.NewWorker(fixture.pool, workhorse.WorkerOptions{
		Queue: "batch-add", WorkerID: workerID, Concurrency: 2, LeaseDuration: 5 * time.Second,
		PollInterval: 5 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	var links []*workhorse.TaskGroupLink
	var addResults []workhorse.EnqueueResult
	var staleErr error
	runContext, stop := context.WithCancel(fixture.ctx)
	defer stop()
	worker.HandleBatch("member", workhorse.BatchHandlerOptions{MaxSize: 2, Linger: time.Second}, func(items []workhorse.BatchHandlerItem) []workhorse.BatchHandlerOutcome {
		outcomes := make([]workhorse.BatchHandlerOutcome, len(items))
		for index, item := range items {
			outcomes[index] = workhorse.BatchSucceeded{}
			link, err := item.Context.GetTaskGroup()
			if err != nil {
				outcomes[index] = workhorse.BatchFailed{Error: err}
				continue
			}
			links = append(links, link)
			unnamed := workhorse.EnqueueRequest{Type: "extra", Payload: item.Payload, Options: workhorse.EnqueueOptions{MaxAttempts: 1}}
			if item.Payload == float64(2) {
				// A competing settlement ends the lease of this task, so its add must fail.
				var accepted bool
				if err := fixture.pool.QueryRow(
					fixture.ctx,
					"SELECT workhorse.complete_v1($1::uuid, $2::text, $3::bigint, 'null'::jsonb)",
					item.Context.Task.ID, workerID, item.Context.Task.FenceToken,
				).Scan(&accepted); err != nil || !accepted {
					outcomes[index] = workhorse.BatchFailed{Error: fmt.Errorf("competing settlement: accepted=%t err=%v", accepted, err)}
					continue
				}
				_, staleErr = item.Context.AddToTaskGroup([]workhorse.EnqueueRequest{unnamed})
				continue
			}
			addResults, err = item.Context.AddToTaskGroup([]workhorse.EnqueueRequest{unnamed})
			if err != nil {
				outcomes[index] = workhorse.BatchFailed{Error: err}
			}
		}
		stop()
		return outcomes
	})
	if err := worker.Run(runContext); err != nil {
		t.Fatalf("run batch: %v", err)
	}

	if len(links) != 2 {
		t.Fatalf("expected a read for each task in the batch, received %d", len(links))
	}
	for _, link := range links {
		if link == nil || link.Role != workhorse.TaskGroupMemberRole || link.Group.ID != block.Group.ID {
			t.Fatalf("unexpected member link: %+v", link)
		}
	}
	if len(addResults) != 1 || addResults[0].Outcome != workhorse.EnqueueAccepted {
		t.Fatalf("unexpected batch add: %+v", addResults)
	}
	var closed *workhorse.TaskGroupClosedError
	if !errors.As(staleErr, &closed) || !errors.Is(staleErr, workhorse.ErrTaskGroupClosed) ||
		closed.Details.GroupID != block.Group.ID || closed.Details.Reason != workhorse.TaskGroupRefusedNotRunningMember {
		t.Fatalf("expected a refusal after the lease is lost, received %v", staleErr)
	}
	var queueName string
	if err := fixture.pool.QueryRow(fixture.ctx, "SELECT queue_name FROM workhorse.task WHERE id = $1", addResults[0].TaskID).Scan(&queueName); err != nil {
		t.Fatal(err)
	}
	if queueName != "batch-add" {
		t.Fatalf("expected the added task on the queue of its task in the batch, found %q", queueName)
	}
	if group := fixture.group(t, block.Group.ID); group.Counts.Total != 3 {
		t.Fatalf("expected three member tasks, found %+v", group.Counts)
	}
}
