package workhorse

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"
)

// answeringExecutor answers each query with the rows or the error of its next answer.
type answeringExecutor struct {
	mu      sync.Mutex
	answers []executorAnswer
}

type executorAnswer struct {
	rows []Row
	err  error
}

func (executor *answeringExecutor) Query(context.Context, string, ...any) ([]Row, error) {
	executor.mu.Lock()
	defer executor.mu.Unlock()
	if len(executor.answers) == 0 {
		return nil, errors.New("no scripted answer")
	}
	answer := executor.answers[0]
	executor.answers = executor.answers[1:]
	return answer.rows, answer.err
}

type internalLogBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (logs *internalLogBuffer) Write(contents []byte) (int, error) {
	logs.mu.Lock()
	defer logs.mu.Unlock()
	return logs.buffer.Write(contents)
}

// records returns each JSON record of event.
func (logs *internalLogBuffer) records(t *testing.T, event string) []map[string]any {
	t.Helper()
	logs.mu.Lock()
	defer logs.mu.Unlock()
	var records []map[string]any
	scanner := bufio.NewScanner(bytes.NewReader(logs.buffer.Bytes()))
	for scanner.Scan() {
		var record map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &record); err != nil {
			t.Fatalf("a log line is not JSON: %v: %s", err, scanner.Text())
		}
		if record[eventNameAttribute] == event {
			records = append(records, record)
		}
	}
	return records
}

func assertLogValues(t *testing.T, record map[string]any, want map[string]any) {
	t.Helper()
	for key, value := range want {
		if actual, ok := record[key]; !ok || fmt.Sprint(actual) != fmt.Sprint(value) {
			t.Errorf("%s is %v, want %v: %v", key, actual, value, record)
		}
	}
}

func loggingWorker(t *testing.T, logs *internalLogBuffer, options WorkerOptions) *Worker {
	t.Helper()
	options.Logger = slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	worker, err := NewWorker(unconnectedPool(t), options)
	if err != nil {
		t.Fatal(err)
	}
	return worker
}

func registrationRows(paused bool) executorAnswer {
	return executorAnswer{rows: []Row{{rowPausedField: paused}}}
}

// TypeScript test "does not repeat an unchanged worker registration on every refresh": the worker
// logs workhorse.worker.registered after the first registration and after a change of the active
// slots, the draining state, or the pause state, and not on each refresh.
func TestRefreshRegistrationLogsOnlyAChangedRegistration(t *testing.T) {
	var logs internalLogBuffer
	worker := loggingWorker(t, &logs, WorkerOptions{Queue: "registration-logs", WorkerID: "registration-worker", Concurrency: 2})
	executor := &answeringExecutor{answers: []executorAnswer{
		registrationRows(false), registrationRows(false), registrationRows(false),
		registrationRows(false),
		registrationRows(true), registrationRows(true),
		registrationRows(false),
		registrationRows(false), registrationRows(false),
		{err: errors.New("registry unavailable")},
	}}
	ctx := context.Background()
	for range 3 {
		worker.refreshRegistration(ctx, executor, false)
	}
	if records := logs.records(t, workerRegisteredEvent); len(records) != 1 {
		t.Fatalf("got %d registration records after three unchanged refreshes, want 1: %v", len(records), records)
	}
	worker.activeSlots.Store(1)
	worker.refreshRegistration(ctx, executor, false)
	worker.refreshRegistration(ctx, executor, false)
	worker.refreshRegistration(ctx, executor, false)
	worker.refreshRegistration(ctx, executor, false)
	worker.refreshRegistration(ctx, executor, true)
	worker.refreshRegistration(ctx, executor, true)

	registered := logs.records(t, workerRegisteredEvent)
	if len(registered) != 5 {
		t.Fatalf("got %d registration records, want 5: %v", len(registered), registered)
	}
	base := map[string]any{
		"level": "DEBUG", "msg": "Worker registration changed", workerIDAttribute: "registration-worker",
		"workhorse.worker.queues": []string{"registration-logs"}, "workhorse.worker.concurrency": 2,
	}
	for index, state := range []map[string]any{
		{"workhorse.worker.active_slots": 0, "workhorse.worker.draining": false, "workhorse.worker.paused": false},
		{"workhorse.worker.active_slots": 1, "workhorse.worker.draining": false, "workhorse.worker.paused": false},
		{"workhorse.worker.active_slots": 1, "workhorse.worker.draining": false, "workhorse.worker.paused": true},
		{"workhorse.worker.active_slots": 1, "workhorse.worker.draining": false, "workhorse.worker.paused": false},
		{"workhorse.worker.active_slots": 1, "workhorse.worker.draining": true, "workhorse.worker.paused": false},
	} {
		assertLogValues(t, registered[index], base)
		assertLogValues(t, registered[index], state)
	}
	paused := logs.records(t, workerPausedEvent)
	resumed := logs.records(t, workerResumedEvent)
	if len(paused) != 1 || len(resumed) != 1 {
		t.Fatalf("got %d paused and %d resumed records, want 1 and 1", len(paused), len(resumed))
	}
	remote := map[string]any{"level": "INFO", workerIDAttribute: "registration-worker", "workhorse.worker.queues": []string{"registration-logs"}}
	assertLogValues(t, paused[0], remote)
	assertLogValues(t, paused[0], map[string]any{"msg": "Worker paused remotely"})
	assertLogValues(t, resumed[0], remote)
	assertLogValues(t, resumed[0], map[string]any{"msg": "Worker resumed remotely"})

	worker.refreshRegistration(ctx, executor, true)
	failed := logs.records(t, workerRegistrationFailedEvent)
	if len(failed) != 1 {
		t.Fatalf("got %d registration failure records, want 1", len(failed))
	}
	assertLogValues(t, failed[0], map[string]any{
		"level": "INFO", "msg": "Worker registration failed", workerIDAttribute: "registration-worker",
		"workhorse.worker.queues": []string{"registration-logs"}, errorTypeAttribute: "*errors.errorString",
	})
	if _, ok := failed[0][errorLogField]; ok {
		t.Fatalf("the registration failure record holds the error message: %v", failed[0])
	}
}

func TestDeregisterLogsTheResultOfTheDelete(t *testing.T) {
	var logs internalLogBuffer
	worker := loggingWorker(t, &logs, WorkerOptions{Queue: "deregistration-logs", WorkerID: "deregistration-worker"})
	worker.registered.Store(true)
	worker.deregister(context.Background(), &answeringExecutor{answers: []executorAnswer{
		{rows: []Row{{"deregistered": false}}},
	}})
	records := logs.records(t, workerDeregisteredEvent)
	if len(records) != 1 {
		t.Fatalf("got %d deregistration records, want 1", len(records))
	}
	assertLogValues(t, records[0], map[string]any{
		"level": "DEBUG", "msg": "Worker deregistered", workerIDAttribute: "deregistration-worker",
		"workhorse.worker.deregistered": false,
	})
}

func TestFireDueSchedulesLogsEachOccurrence(t *testing.T) {
	var logs internalLogBuffer
	worker := loggingWorker(t, &logs, WorkerOptions{
		Queue: "schedule-logs", WorkerID: "schedule-worker", ScheduleNamespaces: []string{"billing"},
	})
	taskID := "00000000-0000-4000-8000-000000000002"
	err := worker.fireDueSchedules(context.Background(), &answeringExecutor{answers: []executorAnswer{{rows: []Row{
		{rowNamespaceField: "billing", rowScheduleNameField: "rollup", rowTaskIDField: taskID},
		{rowNamespaceField: "billing", rowScheduleNameField: "statement", rowTaskIDField: nil},
	}}}})
	if err != nil {
		t.Fatal(err)
	}
	fired := logs.records(t, scheduleFiredEvent)
	replayed := logs.records(t, scheduleFireReplayedEvent)
	if len(fired) != 1 || len(replayed) != 1 {
		t.Fatalf("got %d fired and %d replayed records, want 1 and 1", len(fired), len(replayed))
	}
	assertLogValues(t, fired[0], map[string]any{
		"level": "INFO", "msg": "Recurring schedule fired", "workhorse.schedule.namespace": "billing",
		"workhorse.schedule.name": "rollup", taskIDAttribute: taskID,
	})
	assertLogValues(t, replayed[0], map[string]any{
		"level": "DEBUG", "msg": "Recurring schedule occurrence replayed",
		"workhorse.schedule.namespace": "billing", "workhorse.schedule.name": "statement",
	})
	if _, ok := replayed[0][taskIDAttribute]; ok {
		t.Fatalf("the replay record names a task: %v", replayed[0])
	}
}

// A new run, or a deregistration, writes its first workhorse.worker.registered record also when
// the state equals the state of the last record. Before, the worker kept the saved state, so the
// second of two runs with the same state wrote no first-registration record.
func TestANewRunOrADeregistrationLogsTheNextRegistration(t *testing.T) {
	var logs internalLogBuffer
	worker := loggingWorker(t, &logs, WorkerOptions{Queue: "registration-reset", WorkerID: "registration-reset-worker"})
	ctx := context.Background()
	executor := &answeringExecutor{answers: []executorAnswer{
		registrationRows(false),
		{rows: []Row{{rowDeregisteredField: true}}},
		registrationRows(false),
		registrationRows(false),
	}}
	worker.refreshRegistration(ctx, executor, false)
	worker.deregister(ctx, executor)
	worker.refreshRegistration(ctx, executor, false)
	if records := logs.records(t, workerRegisteredEvent); len(records) != 2 {
		t.Fatalf("got %d registration records after a deregistration, want 2: %v", len(records), records)
	}
	worker.startRegistration()
	worker.refreshRegistration(ctx, executor, false)
	if records := logs.records(t, workerRegisteredEvent); len(records) != 3 {
		t.Fatalf("got %d registration records after a new run, want 3: %v", len(records), records)
	}
}

// A diagnostic record holds the error type and never the error text (docs/architecture/
// telemetry.md, "Log content limits"). The text of a connection error can name a host or a user.
func TestListenerAndHeartbeatRoundFailuresLogOnlyTheErrorType(t *testing.T) {
	const secret = "connect to 10.0.0.7 as user ops failed"
	var logs internalLogBuffer
	logger := slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	hub := &taskNotificationHub{subscribers: map[*taskNotificationSubscription]struct{}{}, lastLogger: logger}
	hub.report(errors.New(secret))

	worker := loggingWorker(t, &logs, WorkerOptions{Queue: "round-failure", WorkerID: "round-failure-worker"})
	worker.heartbeatRound = func([]*heartbeatMember, time.Time) ([]ownershipStatus, error) {
		return nil, errors.New(secret)
	}
	worker.refreshOwnershipMany(nil, time.Now().Add(time.Second))

	logs.mu.Lock()
	text := logs.buffer.String()
	logs.mu.Unlock()
	for _, message := range []string{notificationListenerLogMessage, heartbeatRoundFailedLogMessage} {
		if !strings.Contains(text, message) {
			t.Fatalf("no record %q in %s", message, text)
		}
	}
	if strings.Contains(text, secret) {
		t.Fatalf("a record holds the error text: %s", text)
	}
	if strings.Count(text, `"error.type":"*errors.errorString"`) != 2 {
		t.Fatalf("each record must hold the error type: %s", text)
	}
}
