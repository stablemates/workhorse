package workhorse_test

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

// The Go SDK writes each worker log event of the TypeScript union WorkhorseLogEvent with the name,
// severity, and attributes of TypeScript (docs/architecture/telemetry.md, "Structured logs").

// debugJSONLogger writes every record of the SDK as one JSON line into logs.
func debugJSONLogger(logs *lockedBuffer) *slog.Logger {
	return slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
}

// matchingLogRecords returns each record of event whose attributes have the values in want. A
// value matches when its text is the same, so 1 matches the JSON number 1 and []string{"a"} the
// JSON array ["a"].
func matchingLogRecords(t *testing.T, logs string, event string, want map[string]any) []map[string]any {
	t.Helper()
	var matched []map[string]any
	for _, record := range jsonLogRecords(t, logs, event) {
		matches := true
		for key, value := range want {
			actual, ok := record[key]
			if !ok || fmt.Sprint(actual) != fmt.Sprint(value) {
				matches = false
				break
			}
		}
		if matches {
			matched = append(matched, record)
		}
	}
	return matched
}

// requireLogRecord fails the test unless logs hold a record of event with the values in want.
func requireLogRecord(t *testing.T, logs string, event string, want map[string]any) map[string]any {
	t.Helper()
	matched := matchingLogRecords(t, logs, event, want)
	if len(matched) == 0 {
		t.Fatalf("no %s record with %v:\n%s", event, want, logs)
	}
	return matched[0]
}

// waitForLogRecord waits until logs hold a record of event with the values in want.
func waitForLogRecord(t *testing.T, logs *lockedBuffer, event string, want map[string]any) map[string]any {
	t.Helper()
	deadline := time.Now().Add(workhorse.SignalDeadlineForTest)
	for time.Now().Before(deadline) {
		if matched := matchingLogRecords(t, logs.String(), event, want); len(matched) > 0 {
			return matched[0]
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("no %s record with %v after %s:\n%s", event, want, workhorse.SignalDeadlineForTest, logs.String())
	return nil
}

func TestQueueAndAdminWriteTheirLogEvents(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "queue-admin-log-events")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	var logs lockedBuffer
	logger := debugJSONLogger(&logs)
	executor := workhorse.NewPGXExecutor(pool)
	queueName := "go-queue-log-events"
	queue := workhorse.NewQueue(executor, queueName).WithLogger(logger)
	admin := workhorse.NewAdmin(executor).WithLogger(logger)

	idempotency := workhorse.EnqueueOptions{Idempotency: &workhorse.Idempotency{Key: "order-1", TTLMS: 60_000}}
	accepted, err := queue.EnqueueWithResult(ctx, "send-email", map[string]any{"secret": "payload-value"}, idempotency)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := queue.EnqueueWithResult(ctx, "send-email", map[string]any{"secret": "payload-value"}, idempotency)
	if err != nil {
		t.Fatal(err)
	}
	debounce := workhorse.EnqueueOptions{Debounce: &workhorse.Debounce{
		Key: "typing", WindowMS: 60_000, Schedule: workhorse.DebounceReset,
	}}
	if _, err := queue.EnqueueWithResult(ctx, "debounce", nil, debounce); err != nil {
		t.Fatal(err)
	}
	replaced, err := queue.EnqueueWithResult(ctx, "debounce", nil, debounce)
	if err != nil {
		t.Fatal(err)
	}
	throttle := workhorse.EnqueueOptions{Throttle: &workhorse.Throttle{Key: "rate", WindowMS: 60_000}}
	if _, err := queue.EnqueueWithResult(ctx, "throttle", nil, throttle); err != nil {
		t.Fatal(err)
	}
	coalesced, err := queue.EnqueueWithResult(ctx, "throttle", nil, throttle)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := queue.EnqueueWithResult(ctx, "incompatible", nil, workhorse.EnqueueOptions{
		Idempotency: &workhorse.Idempotency{Key: "incompatible", Scope: "debounce", TTLMS: 60_000},
	}); err != nil {
		t.Fatal(err)
	}
	rejected, err := queue.EnqueueWithResult(ctx, "incompatible", nil, workhorse.EnqueueOptions{
		Debounce: &workhorse.Debounce{
			Key: "incompatible", Scope: "debounce", WindowMS: 60_000, Schedule: workhorse.DebounceReset,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if replayed.Outcome != workhorse.EnqueueReplayed || replaced.Outcome != workhorse.EnqueueReplaced ||
		coalesced.Outcome != workhorse.EnqueueCoalesced || rejected.Outcome != workhorse.EnqueueNonReplaceable {
		t.Fatalf("outcomes %s %s %s %s", replayed.Outcome, replaced.Outcome, coalesced.Outcome, rejected.Outcome)
	}
	if err := queue.SyncSchedules(ctx, "go-log-events", []workhorse.ScheduleDefinition{{
		Name: "nightly", Schedule: "0 * * * *",
		Task: workhorse.ScheduledTask{Type: "report", Payload: map[string]any{}},
	}}); err != nil {
		t.Fatal(err)
	}
	reason := "customer-reason-text"
	if _, err := queue.Cancel(ctx, accepted.TaskID, workhorse.CancellationRequest{Reason: &reason}); err != nil {
		t.Fatal(err)
	}
	missingTask := "00000000-0000-4000-8000-000000000001"
	delivery := workhorse.ExternalWaitDelivery{IdempotencyKey: "delivery-key-text", RequestedBy: "ops"}
	signal, err := queue.SendSignal(ctx, missingTask, "approval", map[string]any{"secret": "payload-value"}, delivery)
	if err != nil {
		t.Fatal(err)
	}
	human, err := queue.CompleteHumanWait(ctx, missingTask, "review", map[string]any{"secret": "payload-value"}, delivery)
	if err != nil {
		t.Fatal(err)
	}

	audit := workhorse.AdminAudit{Actor: "ops", Reason: "maintenance window", RequestID: "request-1"}
	if err := admin.PauseQueue(ctx, queueName, audit); err != nil {
		t.Fatal(err)
	}
	if err := admin.ResumeQueue(ctx, queueName, audit); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.SetQueueTier(ctx, queueName, workhorse.QueueTierFull, audit); err != nil {
		t.Fatal(err)
	}
	purged, err := admin.PurgeQueue(ctx, queueName, audit)
	if err != nil {
		t.Fatal(err)
	}
	redrive, err := admin.Redrive(ctx, missingTask, audit)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.RedriveMany(ctx, workhorse.DeadLetterFilter{}, audit, workhorse.BulkRedriveOptions{DryRun: true}); err != nil {
		t.Fatal(err)
	}

	output := logs.String()
	for _, test := range []struct {
		event string
		want  map[string]any
	}{
		{"workhorse.task.enqueued", map[string]any{
			"level": "DEBUG", "msg": "Task enqueued", "workhorse.task.id": accepted.TaskID,
			"workhorse.task.type": "send-email", "workhorse.queue.name": queueName,
		}},
		{"workhorse.task.enqueue_replayed", map[string]any{
			"level": "DEBUG", "msg": "Idempotent enqueue replayed", "workhorse.task.id": accepted.TaskID,
			"workhorse.task.type": "send-email", "workhorse.queue.name": queueName,
		}},
		{"workhorse.task.debounced", map[string]any{
			"level": "DEBUG", "msg": "Pending task replaced", "workhorse.task.id": replaced.TaskID,
			"workhorse.task.type": "debounce", "workhorse.queue.name": queueName,
		}},
		{"workhorse.task.throttled", map[string]any{
			"level": "DEBUG", "msg": "Throttled enqueue coalesced", "workhorse.task.id": coalesced.TaskID,
			"workhorse.task.type": "throttle", "workhorse.queue.name": queueName,
		}},
		{"workhorse.task.debounce_rejected", map[string]any{
			"level": "DEBUG", "msg": "Debounced task not replaceable", "workhorse.task.id": rejected.TaskID,
			"workhorse.task.type": "incompatible", "workhorse.queue.name": queueName,
		}},
		{"workhorse.schedules.synchronized", map[string]any{
			"level": "INFO", "msg": "Recurring schedules synchronized",
			"workhorse.schedule.namespace": "go-log-events", "workhorse.schedule.count": 1,
		}},
		{"workhorse.task.cancellation_processed", map[string]any{
			"level": "INFO", "msg": "Task cancellation processed", "workhorse.task.id": accepted.TaskID,
			"workhorse.task.state": "canceled", "workhorse.operation.status": "canceled",
		}},
		{"workhorse.task.signal_processed", map[string]any{
			"level": "INFO", "msg": "Task signal processed", "workhorse.task.id": missingTask,
			"workhorse.signal.name": "approval", "workhorse.signal.status": string(signal.Status),
		}},
		{"workhorse.task.human_wait_processed", map[string]any{
			"level": "INFO", "msg": "Human wait completion processed", "workhorse.task.id": missingTask,
			"workhorse.human_wait.name": "review", "workhorse.human_wait.status": string(human.Status),
		}},
		{"workhorse.queue.paused", map[string]any{
			"level": "INFO", "msg": "Queue paused", "workhorse.queue.name": queueName,
		}},
		{"workhorse.queue.resumed", map[string]any{
			"level": "INFO", "msg": "Queue resumed", "workhorse.queue.name": queueName,
		}},
		{"workhorse.queue.tier_set", map[string]any{
			"level": "INFO", "msg": "Queue tier set", "workhorse.queue.name": queueName, "workhorse.queue.tier": "full",
		}},
		{"workhorse.queue.purged", map[string]any{
			"level": "INFO", "msg": "Queue purged", "workhorse.queue.name": queueName, "workhorse.task.count": purged,
		}},
		{"workhorse.task.redrive_processed", map[string]any{
			"level": "INFO", "msg": "Dead-letter task redrive processed", "workhorse.task.id": missingTask,
			"workhorse.redrive.target_task_id": "none", "workhorse.operation.status": string(redrive.Status),
		}},
		{"workhorse.tasks.redrive_processed", map[string]any{
			"level": "INFO", "msg": "Dead-letter task redrive batch processed",
			"workhorse.task.count": 0, "workhorse.redrive.dry_run": true,
		}},
	} {
		requireLogRecord(t, output, test.event, test.want)
	}
	if signal.Status != workhorse.SignalNotFound || human.Status != workhorse.HumanWaitNotFound {
		t.Fatalf("signal %s and human wait %s, want not_found", signal.Status, human.Status)
	}
	// docs/architecture/telemetry.md, "Log content limits".
	for _, secret := range []string{"payload-value", "customer-reason-text", "delivery-key-text", "order-1"} {
		if strings.Contains(output, secret) {
			t.Fatalf("the logs hold %q:\n%s", secret, output)
		}
	}
}

func TestWorkerWritesItsTaskLogEvents(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-task-log-events")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	// A batch dispatch evidence write that fails gives workhorse.handler.batch_evidence_failed.
	if _, err := pool.Exec(ctx, `ALTER FUNCTION workhorse.record_batch_dispatch_v1(uuid, uuid[], integer[], bigint[], text)
		RENAME TO test_hidden_record_batch_dispatch_v1`); err != nil {
		t.Fatal(err)
	}
	queueName := "go-task-log-events"
	workerID := "go-task-log-events-worker"
	var logs lockedBuffer
	logger := debugJSONLogger(&logs)
	executor := workhorse.NewPGXExecutor(pool)
	queue := workhorse.NewQueue(executor, queueName)
	admin := workhorse.NewAdmin(executor).WithLogger(logger)
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: workerID, Concurrency: 2, PollingOnly: true,
		PollInterval: 20 * time.Millisecond, HeartbeatInterval: 100 * time.Millisecond,
		MaintenanceInterval: 100 * time.Millisecond, RegistryInterval: 100 * time.Millisecond,
		Logger: logger,
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("durable", func(_ context.Context, _ any, handler *workhorse.HandlerContext) (any, error) {
		if _, err := handler.Checkpoint("load", func() (any, error) { return map[string]any{"rows": 3}, nil }); err != nil {
			return nil, err
		}
		if progress, err := handler.GetProgress(); err != nil {
			return nil, err
		} else if progress == nil {
			if _, err := handler.SetProgress(map[string]any{"percent": 50}); err != nil {
				return nil, err
			}
		}
		if err := handler.Sleep("pause", 10*time.Millisecond); err != nil {
			return nil, err
		}
		if _, err := handler.RunChild("child", "child-step", map[string]any{}); err != nil {
			return nil, err
		}
		return map[string]any{"done": true}, nil
	})
	worker.Handle("parent-set", func(_ context.Context, _ any, handler *workhorse.HandlerContext) (any, error) {
		if _, err := handler.RunChildren([]workhorse.ChildTaskRequest{
			{Name: "set-member", Type: "child-step", Payload: map[string]any{}},
		}); err != nil {
			return nil, err
		}
		return map[string]any{"done": true}, nil
	})
	worker.Handle("child-step", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return map[string]any{"child": true}, nil
	})
	worker.Handle("slow", func(_ context.Context, _ any, handler *workhorse.HandlerContext) (any, error) {
		deadline := time.Now().Add(workhorse.SignalDeadlineForTest)
		for time.Now().Before(deadline) {
			if len(matchingLogRecords(t, logs.String(), "workhorse.task.heartbeat_accepted",
				map[string]any{"workhorse.task.id": handler.Task.ID})) > 0 {
				return map[string]any{"slow": true}, nil
			}
			time.Sleep(20 * time.Millisecond)
		}
		return nil, fmt.Errorf("no accepted heartbeat")
	})
	worker.Handle("canceled-late", func(handlerContext context.Context, _ any, handler *workhorse.HandlerContext) (any, error) {
		if _, err := queue.Cancel(context.WithoutCancel(handlerContext), handler.Task.ID, workhorse.CancellationRequest{}); err != nil {
			return nil, err
		}
		return map[string]any{"late": true}, nil
	})
	worker.Handle("deadline", func(handlerContext context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		<-handlerContext.Done()
		return nil, context.Cause(handlerContext)
	})
	worker.Handle("promoted", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return nil, nil
	})
	// The held task is active when the test stops the run. It returns after the stop request, so
	// the stop record counts one active slot and the drain then settles it.
	worker.Handle("held", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		deadline := time.Now().Add(workhorse.SignalDeadlineForTest)
		for time.Now().Before(deadline) {
			if len(matchingLogRecords(t, logs.String(), "workhorse.worker.stop_requested", map[string]any{})) > 0 {
				return map[string]any{"held": true}, nil
			}
			time.Sleep(10 * time.Millisecond)
		}
		return nil, fmt.Errorf("no stop request")
	})
	worker.HandleBatch("batched", workhorse.BatchHandlerOptions{MaxSize: 2, Linger: 10 * time.Millisecond},
		func(items []workhorse.BatchHandlerItem) []workhorse.BatchHandlerOutcome {
			outcomes := make([]workhorse.BatchHandlerOutcome, len(items))
			for index := range items {
				outcomes[index] = workhorse.BatchSucceeded{Result: map[string]any{"batched": true}}
			}
			return outcomes
		})

	durableID, err := queue.Enqueue(ctx, "durable", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	parentSetID, err := queue.Enqueue(ctx, "parent-set", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	slowID, err := queue.Enqueue(ctx, "slow", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	canceledID, err := queue.Enqueue(ctx, "canceled-late", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(300 * time.Millisecond)
	deadlineID, err := queue.Enqueue(ctx, "deadline", nil, workhorse.EnqueueOptions{MaxAttempts: 1, Deadline: &deadline})
	if err != nil {
		t.Fatal(err)
	}
	runAt := time.Now().Add(300 * time.Millisecond)
	promotedID, err := queue.Enqueue(ctx, "promoted", nil, workhorse.EnqueueOptions{RunAt: &runAt})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := queue.Enqueue(ctx, "batched", map[string]any{}); err != nil {
		t.Fatal(err)
	}

	runContext, stop := context.WithCancel(ctx)
	defer stop()
	runResult := make(chan error, 1)
	go func() { runResult <- worker.Run(runContext) }()

	waitForLogRecord(t, &logs, "workhorse.task.checkpoint_saved", map[string]any{
		"level": "DEBUG", "msg": "Task checkpoint persisted", "workhorse.task.id": durableID,
		"workhorse.task.type": "durable", "workhorse.task.attempt": 1, "workhorse.worker.id": workerID,
		"workhorse.checkpoint.name": "load", "workhorse.checkpoint.status": "saved",
	})
	waitForLogRecord(t, &logs, "workhorse.task.progress_updated", map[string]any{
		"level": "DEBUG", "msg": "Task progress persisted", "workhorse.task.id": durableID,
		"workhorse.worker.id": workerID, "workhorse.progress.status": "updated",
	})
	waitForLogRecord(t, &logs, "workhorse.task.wait_processed", map[string]any{
		"level": "INFO", "msg": "Durable task wait processed", "workhorse.task.id": durableID,
		"workhorse.worker.id": workerID, "workhorse.wait.name": "pause", "workhorse.wait.status": "scheduled",
	})
	waitForLogRecord(t, &logs, "workhorse.task.wait_processed", map[string]any{
		"workhorse.task.id": durableID, "workhorse.wait.name": "pause", "workhorse.wait.status": "elapsed",
	})
	waitForLogRecord(t, &logs, "workhorse.task.child_processed", map[string]any{
		"level": "INFO", "msg": "Child task processed", "workhorse.task.id": durableID,
		"workhorse.worker.id": workerID, "workhorse.child.name": "child", "workhorse.child.status": "created",
	})
	waitForLogRecord(t, &logs, "workhorse.task.child_processed", map[string]any{
		"workhorse.task.id": durableID, "workhorse.child.name": "child", "workhorse.child.status": "completed",
	})
	waitForLogRecord(t, &logs, "workhorse.task.child_processed", map[string]any{
		"level": "INFO", "msg": "Child set processed", "workhorse.task.id": parentSetID,
		"workhorse.worker.id": workerID, "workhorse.child.count": 1, "workhorse.child.status": "created",
	})
	waitForLogRecord(t, &logs, "workhorse.task.child_processed", map[string]any{
		"level": "INFO", "msg": "Child set processed", "workhorse.task.id": parentSetID,
		"workhorse.worker.id": workerID, "workhorse.child.count": 1, "workhorse.child.status": "completed",
	})
	waitForLogRecord(t, &logs, "workhorse.task.completed", map[string]any{
		"workhorse.task.id": durableID, "workhorse.complete.accepted": true,
	})
	waitForLogRecord(t, &logs, "workhorse.task.heartbeat_accepted", map[string]any{
		"level": "DEBUG", "msg": "Task heartbeat accepted", "workhorse.task.id": slowID,
		"workhorse.task.type": "slow", "workhorse.task.attempt": 1, "workhorse.worker.id": workerID,
	})
	waitForLogRecord(t, &logs, "workhorse.task.completion_rejected", map[string]any{
		"level": "INFO", "msg": "Stale task completion rejected", "workhorse.task.id": canceledID,
		"workhorse.task.type": "canceled-late", "workhorse.worker.id": workerID,
		"workhorse.complete.accepted": false,
	})
	waitForLogRecord(t, &logs, "workhorse.task.cancellation_acknowledged", map[string]any{
		"level": "INFO", "msg": "Task cancellation acknowledged", "workhorse.task.id": canceledID,
		"workhorse.worker.id": workerID, "workhorse.cancel.accepted": true,
	})
	waitForLogRecord(t, &logs, "workhorse.task.ownership_expired", map[string]any{
		"level": "INFO", "msg": "Owned task lease expired", "workhorse.task.id": deadlineID,
		"workhorse.worker.id": workerID, "workhorse.expiration.status": "deadline_exceeded",
	})
	waitForLogRecord(t, &logs, "workhorse.maintenance.completed", map[string]any{
		"level": "INFO", "msg": "Maintenance phase completed", "workhorse.maintenance.operation": "tick",
		"workhorse.maintenance.phase": "promote", "workhorse.maintenance.skipped_lock": false,
	})
	waitForLogRecord(t, &logs, "workhorse.handler.batch_evidence_failed", map[string]any{
		"level": "WARN", "msg": "Batch execution evidence could not be persisted",
		"workhorse.queue.name": queueName, "workhorse.task.type": "batched",
		"workhorse.handler.batch.size": 1, "workhorse.handler.batch.full": false,
		"workhorse.handler.batch.evidence_phase": "dispatch", "workhorse.worker.id": workerID,
	})

	audit := workhorse.AdminAudit{Actor: "ops", Reason: "maintenance window", RequestID: "request-1"}
	if _, err := admin.SetWorkerPaused(ctx, workerID, true, audit); err != nil {
		t.Fatal(err)
	}
	requireLogRecord(t, logs.String(), "workhorse.worker.paused", map[string]any{
		"level": "INFO", "msg": "Worker paused", "workhorse.worker.id": workerID,
	})
	waitForLogRecord(t, &logs, "workhorse.worker.paused", map[string]any{
		"level": "INFO", "msg": "Worker paused remotely", "workhorse.worker.id": workerID,
		"workhorse.worker.queues": []string{queueName},
	})
	if _, err := admin.SetWorkerPaused(ctx, workerID, false, audit); err != nil {
		t.Fatal(err)
	}
	requireLogRecord(t, logs.String(), "workhorse.worker.resumed", map[string]any{
		"level": "INFO", "msg": "Worker resumed", "workhorse.worker.id": workerID,
	})
	waitForLogRecord(t, &logs, "workhorse.worker.resumed", map[string]any{
		"level": "INFO", "msg": "Worker resumed remotely", "workhorse.worker.id": workerID,
	})

	// TypeScript writes the active slots at the moment of the stop request. The promoted task
	// settles first, and only the held task is active when the test stops the run.
	waitForLogRecord(t, &logs, "workhorse.task.execution_finished", map[string]any{
		"workhorse.task.id": promotedID, "workhorse.handler.outcome": "succeeded",
	})
	heldID, err := queue.Enqueue(ctx, "held", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	waitForLogRecord(t, &logs, "workhorse.handler.started", map[string]any{"workhorse.task.id": heldID})
	stop()
	select {
	case err := <-runResult:
		if err != nil {
			t.Fatalf("Run returned %v", err)
		}
	case <-time.After(workhorse.SignalDeadlineForTest):
		t.Fatal("Run did not return")
	}
	output := logs.String()
	requireLogRecord(t, output, "workhorse.task.execution_finished", map[string]any{
		"workhorse.task.id": heldID, "workhorse.handler.outcome": "succeeded",
	})
	for _, test := range []struct {
		event string
		want  map[string]any
	}{
		{"workhorse.handler.registered", map[string]any{
			"level": "DEBUG", "msg": "Task handler registered", "workhorse.task.type": "durable",
			"workhorse.worker.id": workerID,
		}},
		{"workhorse.handler.registered", map[string]any{
			"level": "DEBUG", "msg": "Batch task handler registered", "workhorse.task.type": "batched",
			"workhorse.handler.batch.max_size": 2, "workhorse.handler.batch.linger_ms": 10,
			"workhorse.worker.id": workerID,
		}},
		{"workhorse.worker.polling_only", map[string]any{
			"level": "WARN", "msg": "Worker has no notification listener and dispatches by polling",
			"workhorse.worker.id": workerID, "workhorse.worker.queues": []string{queueName},
			"workhorse.worker.pool_max_size": pool.Config().MaxConns,
		}},
		{"workhorse.worker.started", map[string]any{
			"level": "INFO", "msg": "Worker started", "workhorse.worker.id": workerID,
			"workhorse.worker.queues": []string{queueName}, "workhorse.worker.concurrency": 2,
		}},
		{"workhorse.worker.registered", map[string]any{
			"level": "DEBUG", "msg": "Worker registration changed", "workhorse.worker.id": workerID,
			"workhorse.worker.queues": []string{queueName}, "workhorse.worker.concurrency": 2,
			"workhorse.worker.draining": false,
		}},
		{"workhorse.worker.registered", map[string]any{
			"workhorse.worker.id": workerID, "workhorse.worker.paused": true,
		}},
		{"workhorse.worker.registered", map[string]any{
			"workhorse.worker.id": workerID, "workhorse.worker.draining": true,
		}},
		{"workhorse.worker.stop_requested", map[string]any{
			"level": "INFO", "msg": "Worker stop requested", "workhorse.worker.id": workerID,
			"workhorse.worker.queues": []string{queueName}, "workhorse.worker.active_slots": 1,
		}},
		{"workhorse.worker.deregistered", map[string]any{
			"level": "DEBUG", "msg": "Worker deregistered", "workhorse.worker.id": workerID,
			"workhorse.worker.deregistered": true,
		}},
		{"workhorse.worker.stopped", map[string]any{
			"level": "INFO", "msg": "Worker stopped", "workhorse.worker.id": workerID,
			"workhorse.worker.queues": []string{queueName}, "workhorse.worker.active_slots": 0,
		}},
	} {
		requireLogRecord(t, output, test.event, test.want)
	}
	if records := jsonLogRecords(t, output, "workhorse.worker.started"); len(records) != 1 {
		t.Fatalf("got %d started records, want 1", len(records))
	}
	// TypeScript writes the start record first in run(), before the first registration record.
	started := strings.Index(output, `"event.name":"workhorse.worker.started"`)
	registered := strings.Index(output, `"event.name":"workhorse.worker.registered"`)
	if started < 0 || registered < 0 || started > registered {
		t.Fatalf("the start record is at %d and the first registration record at %d; want the start record first",
			started, registered)
	}
}

// TypeScript writes workhorse.worker.started first in run(), before the readiness check. Thus a run
// that the compatibility check refuses still writes the start record, and it writes no registration
// record and no stop record. The test database has no schema version row, so the check refuses it.
func TestWorkerWritesTheStartRecordBeforeTheReadinessCheck(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-started-before-readiness")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(ctx, "DELETE FROM workhorse.schema_version"); err != nil {
		t.Fatal(err)
	}
	queueName := "go-started-before-readiness"
	workerID := "go-started-before-readiness-worker"
	var logs lockedBuffer
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: workerID, PollingOnly: true, Logger: debugJSONLogger(&logs),
	})
	if err != nil {
		t.Fatal(err)
	}
	var refusal *workhorse.CompatibilityError
	if err := worker.Run(ctx); !errors.As(err, &refusal) {
		t.Fatalf("Run returned %v, want a compatibility refusal", err)
	}
	output := logs.String()
	requireLogRecord(t, output, "workhorse.worker.started", map[string]any{
		"level": "INFO", "msg": "Worker started", "workhorse.worker.id": workerID,
		"workhorse.worker.queues": []string{queueName}, "workhorse.worker.concurrency": 1,
	})
	for _, event := range []string{"workhorse.worker.registered", "workhorse.worker.stopped"} {
		if records := jsonLogRecords(t, output, event); len(records) != 0 {
			t.Fatalf("got %d %s records from a refused run, want none", len(records), event)
		}
	}
}

// A logger that panics never changes the result of a queue or an operator operation. The queue and
// the operator client drop the record, as the worker does.
func TestAPanickingLoggerChangesNoQueueOrAdminResult(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "panicking-sdk-logger")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	records := &atomic.Int64{}
	logger := slog.New(panickingLogHandler{records: records})
	executor := workhorse.NewPGXExecutor(pool)
	queueName := "go-panicking-logger"
	queue := workhorse.NewQueue(executor, queueName).WithLogger(logger)
	admin := workhorse.NewAdmin(executor).WithLogger(logger)

	canceled, err := queue.Enqueue(ctx, "canceled", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := queue.Cancel(ctx, canceled, workhorse.CancellationRequest{}); err != nil {
		t.Fatal(err)
	}
	if _, err := queue.Enqueue(ctx, "purged", map[string]any{}); err != nil {
		t.Fatal(err)
	}
	audit := workhorse.AdminAudit{Actor: "ops", Reason: "logger check", RequestID: "request-1"}
	if err := admin.PauseQueue(ctx, queueName, audit); err != nil {
		t.Fatal(err)
	}
	if err := admin.ResumeQueue(ctx, queueName, audit); err != nil {
		t.Fatal(err)
	}
	purged, err := admin.PurgeQueue(ctx, queueName, audit)
	if err != nil {
		t.Fatal(err)
	}
	if purged != 1 {
		t.Fatalf("purged %d tasks, want 1", purged)
	}
	if records.Load() == 0 {
		t.Fatal("the queue and the operator client wrote no record")
	}
}

// A queue or an operator client without a logger writes no record, as in the other SDKs. Only the
// worker writes to slog.Default() without a logger.
func TestQueueAndAdminWithoutALoggerWriteNoRecord(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "queue-admin-no-logger")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	var logs lockedBuffer
	previous := slog.Default()
	slog.SetDefault(debugJSONLogger(&logs))
	t.Cleanup(func() { slog.SetDefault(previous) })
	executor := workhorse.NewPGXExecutor(pool)
	queueName := "go-queue-no-logger"
	audit := workhorse.AdminAudit{Actor: "ops", Reason: "no logger", RequestID: "request-1"}
	for name, pair := range map[string]struct {
		queue *workhorse.Queue
		admin *workhorse.Admin
	}{
		"without WithLogger": {workhorse.NewQueue(executor, queueName), workhorse.NewAdmin(executor)},
		"with a nil logger":  {workhorse.NewQueue(executor, queueName).WithLogger(nil), workhorse.NewAdmin(executor).WithLogger(nil)},
	} {
		if _, err := pair.queue.Enqueue(ctx, "quiet", map[string]any{}); err != nil {
			t.Fatal(name, err)
		}
		if err := pair.admin.PauseQueue(ctx, queueName, audit); err != nil {
			t.Fatal(name, err)
		}
		if err := pair.admin.ResumeQueue(ctx, queueName, audit); err != nil {
			t.Fatal(name, err)
		}
		if _, err := pair.admin.PurgeQueue(ctx, queueName, audit); err != nil {
			t.Fatal(name, err)
		}
	}
	if text := logs.String(); text != "" {
		t.Fatalf("the queue and the operator client wrote to slog.Default():\n%s", text)
	}
}

// TypeScript writes the handler and execution records around the release of a claim that has no
// handler, and it writes no execution record for an attempt whose settlement failed. Before, the Go
// worker wrote no handler records for a release, and wrote outcome unknown for a failed settlement.
func TestWorkerWritesExecutionRecordsOnlyForASettledAttempt(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-execution-records")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	queueName := "go-execution-records"
	workerID := "go-execution-records-worker"
	var logs lockedBuffer
	executor := workhorse.NewPGXExecutor(pool)
	queue := workhorse.NewQueue(executor, queueName)
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: workerID, PollingOnly: true, DisableRegistry: true,
		MaintenanceInterval: time.Hour, Logger: debugJSONLogger(&logs),
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("completes", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return map[string]any{"done": true}, nil
	})

	missingID, err := queue.Enqueue(ctx, "missing", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := worker.RunOnce(ctx); err != nil {
		t.Fatal(err)
	}
	attempt := map[string]any{
		"workhorse.task.id": missingID, "workhorse.task.type": "missing", "workhorse.task.attempt": 1,
		"workhorse.queue.name": queueName, "workhorse.worker.id": workerID,
	}
	output := logs.String()
	requireLogRecord(t, output, "workhorse.handler.missing", attempt)
	requireLogRecord(t, output, "workhorse.handler.started", attempt)
	requireLogRecord(t, output, "workhorse.handler.finished", attempt)
	released := requireLogRecord(t, output, "workhorse.task.execution_finished", attempt)
	if released["workhorse.handler.outcome"] != "released" {
		t.Fatalf("got outcome %v for the release, want released", released["workhorse.handler.outcome"])
	}

	// The released task is ready again, so the next pass must not claim it.
	if _, err := queue.Cancel(ctx, missingID, workhorse.CancellationRequest{}); err != nil {
		t.Fatal(err)
	}
	// Each completion statement of the worker fails, so the attempt does not settle.
	if _, err := pool.Exec(ctx, `
		CREATE OR REPLACE FUNCTION workhorse.complete_v1(
		  p_task_id uuid, p_worker_id text, p_fence_token bigint, p_result jsonb DEFAULT 'null'::jsonb)
		  RETURNS boolean LANGUAGE plpgsql AS $body$
		  BEGIN RAISE EXCEPTION 'injected completion failure'; END $body$`); err != nil {
		t.Fatal(err)
	}
	failedID, err := queue.Enqueue(ctx, "completes", map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := worker.RunOnce(ctx); err == nil {
		t.Fatalf("RunOnce returned no completion error:\n%s", logs.String())
	}
	output = logs.String()
	requireLogRecord(t, output, "workhorse.handler.finished", map[string]any{"workhorse.task.id": failedID})
	if records := matchingLogRecords(t, output, "workhorse.task.execution_finished",
		map[string]any{"workhorse.task.id": failedID}); len(records) != 0 {
		t.Fatalf("a failed settlement wrote an execution record: %v", records)
	}
}
