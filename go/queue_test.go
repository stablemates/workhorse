package workhorse_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

type queueExecutor struct {
	responses [][]workhorse.Row
	errors    []error
	calls     []queueCall
}

type queueCall struct {
	statement string
	arguments []any
}

func (executor *queueExecutor) Query(
	_ context.Context,
	statement string,
	arguments ...any,
) ([]workhorse.Row, error) {
	executor.calls = append(executor.calls, queueCall{statement: statement, arguments: arguments})
	if len(executor.errors) > 0 {
		err := executor.errors[0]
		executor.errors = executor.errors[1:]
		if err != nil {
			return nil, err
		}
	}
	response := executor.responses[0]
	executor.responses = executor.responses[1:]
	return response, nil
}

func TestQueueSerializesMinimalRequestsAndReturnsCanonicalResults(t *testing.T) {
	executor := &queueExecutor{responses: [][]workhorse.Row{
		{{"version": int64(47)}},
		{
			{"ordinal": int32(1), "job_id": "first", "outcome": "accepted", "reason": nil},
			{"ordinal": int32(2), "job_id": "second", "outcome": "replayed", "reason": nil},
		},
	}}
	queue := workhorse.NewQueue(executor, "go-contract")

	results, err := queue.EnqueueManyWithResults(context.Background(), []workhorse.EnqueueRequest{
		{Type: "email.send", Payload: map[string]any{"message": "one"}},
		{Type: "email.send", Payload: map[string]any{"message": "two"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 2 || results[0].JobID != "first" || results[0].Outcome != workhorse.EnqueueAccepted ||
		results[1].JobID != "second" || results[1].Outcome != workhorse.EnqueueReplayed {
		t.Fatalf("unexpected results: %#v", results)
	}
	if len(executor.calls) != 2 {
		t.Fatalf("expected compatibility and enqueue calls, received %d", len(executor.calls))
	}
	var request []map[string]any
	encoded, ok := executor.calls[1].arguments[0].([]byte)
	if !ok {
		t.Fatalf("enqueue argument is %T, expected []byte", executor.calls[1].arguments[0])
	}
	if err := json.Unmarshal(encoded, &request); err != nil {
		t.Fatal(err)
	}
	if len(request) != 2 {
		t.Fatalf("unexpected decoded request: %#v", request)
	}
	if request[0]["queue"] != "go-contract" || request[0]["type"] != "email.send" ||
		request[0]["maxAttempts"] != float64(25) {
		t.Fatalf("unexpected request defaults: %#v", request[0])
	}
}

func TestQueueSatisfiesSharedRequestFixturesWithinCurrentScope(t *testing.T) {
	type requestFixture struct {
		ID          string `json:"id"`
		Application struct {
			Type    string         `json:"type"`
			Payload any            `json:"payload"`
			Options map[string]any `json:"options"`
		} `json:"application"`
		Postgres map[string]any `json:"postgres"`
	}

	for _, fixture := range readFixture[[]requestFixture](t, "requests.json") {
		t.Run(fixture.ID, func(t *testing.T) {
			executor := &queueExecutor{responses: [][]workhorse.Row{
				{{"version": int64(47)}},
				{{"ordinal": int32(1), "job_id": "fixture", "outcome": "accepted", "reason": nil}},
			}}
			queueName, ok := fixture.Postgres["queue"].(string)
			if !ok {
				t.Fatalf("fixture queue is %T", fixture.Postgres["queue"])
			}
			queue := workhorse.NewQueue(executor, queueName)
			options := goOptions(t, fixture.Application.Options)

			if _, err := queue.EnqueueWithResult(
				context.Background(),
				fixture.Application.Type,
				fixture.Application.Payload,
				options,
			); err != nil {
				t.Fatal(err)
			}
			var actual any
			if err := decodeJSON(executor.calls[1].arguments[0].([]byte), &actual); err != nil {
				t.Fatal(err)
			}
			actual, err := normalizeProtocolValue(actual)
			if err != nil {
				t.Fatal(err)
			}
			if err := matchFixtureValue(
				[]any{fixture.Postgres},
				actual,
				map[string]any{},
				fixture.ID,
			); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestQueueSerializesSharedScheduleFixture(t *testing.T) {
	type scheduleFixture struct {
		Namespace    string `json:"namespace"`
		DefaultQueue string `json:"defaultQueue"`
		Prune        bool   `json:"prune"`
		Application  []struct {
			Name     string `json:"name"`
			Schedule string `json:"schedule"`
			Enabled  bool   `json:"enabled"`
			Job      struct {
				Type           string         `json:"type"`
				Payload        any            `json:"payload"`
				Queue          string         `json:"queue"`
				Priority       int            `json:"priority"`
				ConcurrencyKey string         `json:"concurrencyKey"`
				MaxAttempts    int            `json:"maxAttempts"`
				RetryPolicy    map[string]any `json:"retryPolicy"`
			} `json:"job"`
		} `json:"application"`
		Postgres any `json:"postgres"`
	}
	fixture := readFixture[[]scheduleFixture](t, "schedules.json")[0]
	executor := &queueExecutor{responses: [][]workhorse.Row{{{"version": int64(47)}}, {}}}
	queue := workhorse.NewQueue(executor, fixture.DefaultQueue)
	definitions := make([]workhorse.ScheduleDefinition, len(fixture.Application))
	for index, definition := range fixture.Application {
		enabled := definition.Enabled
		definitions[index] = workhorse.ScheduleDefinition{
			Name: definition.Name, Schedule: definition.Schedule, Enabled: &enabled,
			Job: workhorse.ScheduledJob{
				Type: definition.Job.Type, Payload: definition.Job.Payload, Queue: definition.Job.Queue,
				Priority: definition.Job.Priority, ConcurrencyKey: definition.Job.ConcurrencyKey,
				MaxAttempts: definition.Job.MaxAttempts, RetryPolicy: definition.Job.RetryPolicy,
			},
		}
	}

	err := queue.SyncSchedules(
		context.Background(),
		fixture.Namespace,
		definitions,
		workhorse.SyncSchedulesOptions{Prune: fixture.Prune},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(executor.calls) != 2 {
		t.Fatalf("expected compatibility and schedule calls, received %d", len(executor.calls))
	}
	if executor.calls[1].arguments[0] != fixture.Namespace || executor.calls[1].arguments[2] != fixture.Prune {
		t.Fatalf("unexpected schedule arguments: %#v", executor.calls[1].arguments)
	}
	var actual any
	if err := decodeJSON(executor.calls[1].arguments[1].([]byte), &actual); err != nil {
		t.Fatal(err)
	}
	actual, err = normalizeProtocolValue(actual)
	if err != nil {
		t.Fatal(err)
	}
	if err := matchFixtureValue(fixture.Postgres, actual, map[string]any{}, "schedules"); err != nil {
		t.Fatal(err)
	}
}

func goOptions(t *testing.T, input map[string]any) workhorse.EnqueueOptions {
	t.Helper()
	options := workhorse.EnqueueOptions{}
	for name, value := range input {
		switch name {
		case "queue":
			options.Queue = value.(string)
		case "priority":
			options.Priority = fixtureInteger(t, value)
		case "concurrencyKey":
			options.ConcurrencyKey = value.(string)
		case "runAt":
			parsed, err := time.Parse(time.RFC3339Nano, value.(string))
			if err != nil {
				t.Fatal(err)
			}
			options.RunAt = &parsed
		case "deadline":
			parsed, err := time.Parse(time.RFC3339Nano, value.(string))
			if err != nil {
				t.Fatal(err)
			}
			options.Deadline = &parsed
		case "executionTimeoutMs":
			options.ExecutionTimeoutMS = fixtureInteger(t, value)
		case "maxAttempts":
			options.MaxAttempts = fixtureInteger(t, value)
		case "retryPolicy":
			options.RetryPolicy = value.(map[string]any)
		case "tags":
			for _, tag := range value.([]any) {
				options.Tags = append(options.Tags, tag.(string))
			}
		case "idempotency":
			mode := value.(map[string]any)
			options.Idempotency = &workhorse.Idempotency{
				Key: mode["key"].(string), Scope: mode["scope"].(string), TTLMS: fixtureInteger(t, mode["ttlMs"]),
			}
		case "debounce":
			mode := value.(map[string]any)
			options.Debounce = &workhorse.Debounce{
				Key: mode["key"].(string), Scope: mode["scope"].(string),
				WindowMS: fixtureInteger(t, mode["windowMs"]), Schedule: workhorse.DebounceSchedule(mode["schedule"].(string)),
			}
		case "throttle":
			mode := value.(map[string]any)
			options.Throttle = &workhorse.Throttle{
				Key: mode["key"].(string), Scope: mode["scope"].(string), WindowMS: fixtureInteger(t, mode["windowMs"]),
			}
		case "dependencies":
			dependency := value.(map[string]any)
			options.Dependencies = &workhorse.Dependencies{}
			for _, jobID := range dependency["prerequisiteJobIds"].([]any) {
				options.Dependencies.PrerequisiteJobIDs = append(options.Dependencies.PrerequisiteJobIDs, jobID.(string))
			}
			options.Dependencies.OnSuccess = workhorse.DependencyTerminalPolicy(dependency["onSuccess"].(string))
			options.Dependencies.OnFailure = workhorse.DependencyTerminalPolicy(dependency["onFailure"].(string))
			options.Dependencies.OnCancellation = workhorse.DependencyTerminalPolicy(dependency["onCancellation"].(string))
		default:
			t.Fatalf("request fixture option %q has no Go mapping", name)
		}
	}
	return options
}

func TestQueueSerializesDelayedAndDurableOptions(t *testing.T) {
	runAt := time.Date(2026, time.August, 22, 1, 2, 3, 456_789_000, time.FixedZone("EDT", -4*60*60))
	deadline := runAt.Add(2 * time.Hour)
	executor := &queueExecutor{responses: [][]workhorse.Row{
		{{"version": int64(47)}},
		{
			{"ordinal": int32(1), "job_id": "delayed", "outcome": "accepted", "reason": nil},
			{"ordinal": int32(2), "job_id": "debounced", "outcome": "accepted", "reason": nil},
			{"ordinal": int32(3), "job_id": "throttled", "outcome": "accepted", "reason": nil},
			{"ordinal": int32(4), "job_id": "dependent", "outcome": "accepted", "reason": nil},
		},
	}}
	queue := workhorse.NewQueue(executor, "default")

	_, err := queue.EnqueueManyWithResults(context.Background(), []workhorse.EnqueueRequest{
		{
			Type: "delayed", Payload: nil,
			Options: workhorse.EnqueueOptions{
				Queue: "scheduled", RunAt: &runAt, Deadline: &deadline, ExecutionTimeoutMS: 1500,
			},
		},
		{
			Type: "debounced", Payload: nil,
			Options: workhorse.EnqueueOptions{Debounce: &workhorse.Debounce{
				Key: "typing", WindowMS: 1000, Schedule: workhorse.DebounceReset,
			}},
		},
		{
			Type: "throttled", Payload: nil,
			Options: workhorse.EnqueueOptions{Throttle: &workhorse.Throttle{Key: "rate", WindowMS: 2000}},
		},
		{
			Type: "dependent", Payload: nil,
			Options: workhorse.EnqueueOptions{Dependencies: &workhorse.Dependencies{
				PrerequisiteJobIDs: []string{"second", "first"},
				OnSuccess:          workhorse.DependencyRelease, OnFailure: workhorse.DependencyCancel,
				OnCancellation: workhorse.DependencyFail,
			}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	var request []map[string]any
	if err := decodeJSON(executor.calls[1].arguments[0].([]byte), &request); err != nil {
		t.Fatal(err)
	}
	if request[0]["queue"] != "scheduled" || request[0]["runAt"] != "2026-08-22T05:02:03.456Z" ||
		request[0]["deadline"] != "2026-08-22T07:02:03.456Z" || request[0]["executionTimeoutMs"] != json.Number("1500") {
		t.Fatalf("delayed options were not serialized canonically: %#v", request[0])
	}
	if _, present := request[1]["runAt"]; present || request[1]["debounce"] == nil {
		t.Fatalf("debounce must omit runAt and carry its keyed window: %#v", request[1])
	}
	if _, present := request[2]["runAt"]; present || request[2]["throttle"] == nil {
		t.Fatalf("throttle must omit runAt and carry its keyed window: %#v", request[2])
	}
	dependencies := request[3]["dependencies"].(map[string]any)
	if fmt.Sprint(dependencies["prerequisiteJobIds"]) != "[first second]" ||
		dependencies["onSuccess"] != "release" || dependencies["onFailure"] != "cancel" ||
		dependencies["onCancellation"] != "fail" {
		t.Fatalf("dependencies were not serialized canonically: %#v", dependencies)
	}
}

func fixtureInteger(t *testing.T, value any) int {
	t.Helper()
	parsed, err := strconv.Atoi(fmt.Sprint(value))
	if err != nil {
		t.Fatalf("fixture value %v is not an integer: %v", value, err)
	}
	return parsed
}

func TestQueueRejectsInvalidOptionCombinationsBeforeQuery(t *testing.T) {
	now := time.Now()
	tooManyDependencies := make([]string, workhorse.MaxJobDependencies+1)
	for index := range tooManyDependencies {
		tooManyDependencies[index] = fmt.Sprintf("job-%d", index)
	}
	tests := []struct {
		name    string
		options workhorse.EnqueueOptions
	}{
		{
			name: "multiple keyed modes",
			options: workhorse.EnqueueOptions{
				Idempotency: &workhorse.Idempotency{Key: "same"},
				Throttle:    &workhorse.Throttle{Key: "same", WindowMS: 1},
			},
		},
		{name: "priority outside range", options: workhorse.EnqueueOptions{Priority: 101}},
		{name: "negative max attempts", options: workhorse.EnqueueOptions{MaxAttempts: -1}},
		{
			name:    "debounce with run at",
			options: workhorse.EnqueueOptions{RunAt: &now, Debounce: &workhorse.Debounce{Key: "same", WindowMS: 1}},
		},
		{
			name: "throttle with dependencies",
			options: workhorse.EnqueueOptions{
				Throttle: &workhorse.Throttle{Key: "same", WindowMS: 1},
				Dependencies: &workhorse.Dependencies{
					PrerequisiteJobIDs: []string{"00000000-0000-4000-8000-000000000001"},
				},
			},
		},
		{name: "empty dependencies", options: workhorse.EnqueueOptions{Dependencies: &workhorse.Dependencies{}}},
		{
			name: "duplicate dependencies",
			options: workhorse.EnqueueOptions{Dependencies: &workhorse.Dependencies{
				PrerequisiteJobIDs: []string{"same", "same"},
			}},
		},
		{
			name: "too many dependencies",
			options: workhorse.EnqueueOptions{Dependencies: &workhorse.Dependencies{
				PrerequisiteJobIDs: tooManyDependencies,
			}},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			executor := &queueExecutor{}
			queue := workhorse.NewQueue(executor, "default")
			_, err := queue.Enqueue(context.Background(), "email.send", nil, test.options)
			if !errors.Is(err, workhorse.ErrInvalidEnqueueOptions) {
				t.Fatalf("expected invalid options error, received %v", err)
			}
			if len(executor.calls) != 0 {
				t.Fatalf("invalid options queried PostgreSQL: %s", fmt.Sprint(executor.calls))
			}
		})
	}
}

func TestQueuePlacesResultsByValidatedOrdinal(t *testing.T) {
	executor := &queueExecutor{responses: [][]workhorse.Row{
		{{"version": int64(47)}},
		{
			{"ordinal": int32(2), "job_id": "second", "outcome": "accepted", "reason": nil},
			{"ordinal": int32(1), "job_id": "first", "outcome": "accepted", "reason": nil},
		},
	}}
	queue := workhorse.NewQueue(executor, "default")

	results, err := queue.EnqueueManyWithResults(context.Background(), []workhorse.EnqueueRequest{
		{Type: "email.send", Payload: nil},
		{Type: "email.send", Payload: nil},
	})
	if err != nil {
		t.Fatal(err)
	}
	if results[0].JobID != "first" || results[1].JobID != "second" {
		t.Fatalf("results do not follow request ordinals: %#v", results)
	}
}

func TestQueueRejectsIncompleteOrdinalResults(t *testing.T) {
	executor := &queueExecutor{responses: [][]workhorse.Row{
		{{"version": int64(47)}},
		{},
	}}
	queue := workhorse.NewQueue(executor, "default")

	_, err := queue.Enqueue(context.Background(), "email.send", nil)
	if !errors.Is(err, workhorse.ErrInvalidEnqueueResult) {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestQueueRefusesIncompatibleSchemaBeforeMutation(t *testing.T) {
	executor := &queueExecutor{responses: [][]workhorse.Row{{{"version": int64(46)}}}}
	queue := workhorse.NewQueue(executor, "default")

	_, err := queue.Enqueue(context.Background(), "email.send", map[string]any{"message": "hello"})
	var compatibilityError *workhorse.CompatibilityError
	if !errors.As(err, &compatibilityError) || compatibilityError.Code != workhorse.SchemaTooOld {
		t.Fatalf("unexpected error: %v", err)
	}
	if !errors.Is(err, &workhorse.CompatibilityError{Code: workhorse.SchemaTooOld}) {
		t.Fatalf("compatibility error does not match by code: %v", err)
	}
	if len(executor.calls) != 1 {
		t.Fatalf("expected only compatibility query, received %d calls", len(executor.calls))
	}
}

func TestQueueTranslatesStructuredPostgreSQLErrors(t *testing.T) {
	tests := []struct {
		name     string
		code     string
		detail   string
		sentinel error
		assert   func(*testing.T, error)
	}{
		{
			name:     "idempotency conflict",
			code:     "P1001",
			detail:   `{"ordinal":2,"conflictingFields":["payload"]}`,
			sentinel: workhorse.ErrEnqueueIdempotencyConflict,
			assert: func(t *testing.T, err error) {
				var conflict *workhorse.EnqueueIdempotencyConflictError
				if !errors.As(err, &conflict) || conflict.Details.Ordinal != 2 {
					t.Fatalf("structured details were not preserved: %#v", conflict)
				}
			},
		},
		{
			name:     "dependency cycle",
			code:     "P1003",
			detail:   `{"dependentJobId":"dependent","prerequisiteJobId":"prerequisite","cycleJobIds":["dependent","prerequisite"],"truncated":false}`,
			sentinel: workhorse.ErrDependencyCycle,
			assert: func(t *testing.T, err error) {
				var cycle *workhorse.DependencyCycleError
				if !errors.As(err, &cycle) || cycle.Details.PrerequisiteJobID != "prerequisite" {
					t.Fatalf("structured details were not preserved: %#v", cycle)
				}
			},
		},
		{
			name:     "dependency limit",
			code:     "P1005",
			detail:   `{"jobId":"limited","limit":"dependents","max":100}`,
			sentinel: workhorse.ErrDependencyLimitExceeded,
			assert: func(t *testing.T, err error) {
				var limit *workhorse.DependencyLimitExceededError
				if !errors.As(err, &limit) || limit.Details.Limit != workhorse.DependencyDependents {
					t.Fatalf("structured details were not preserved: %#v", limit)
				}
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			executor := &queueExecutor{
				responses: [][]workhorse.Row{{{"version": int64(47)}}},
				errors:    []error{nil, &pgconn.PgError{Code: test.code, Detail: test.detail}},
			}
			queue := workhorse.NewQueue(executor, "default")

			_, err := queue.Enqueue(
				context.Background(),
				"email.send",
				map[string]any{"message": "hello"},
			)
			if !errors.Is(err, test.sentinel) {
				t.Fatalf("unexpected error: %v", err)
			}
			test.assert(t, err)
		})
	}
}

func TestQueueEmptyBatchDoesNotQueryPostgreSQL(t *testing.T) {
	executor := &queueExecutor{}
	queue := workhorse.NewQueue(executor, "default")

	jobIDs, err := queue.EnqueueMany(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(jobIDs) != 0 || len(executor.calls) != 0 {
		t.Fatalf("unexpected empty batch result: ids=%#v calls=%#v", jobIDs, executor.calls)
	}
}

func TestQueueRejectsBatchAboveSharedLimitBeforeQuery(t *testing.T) {
	executor := &queueExecutor{}
	queue := workhorse.NewQueue(executor, "default")
	requests := make([]workhorse.EnqueueRequest, workhorse.MaxEnqueueBatchSize+1)

	_, err := queue.EnqueueMany(context.Background(), requests)
	if !errors.Is(err, workhorse.ErrEnqueueBatchTooLarge) {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(executor.calls) != 0 {
		t.Fatalf("oversized batch queried PostgreSQL: %#v", executor.calls)
	}
}

func TestQueueLeavesTransactionCommitAndRollbackWithCaller(t *testing.T) {
	ctx := context.Background()
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "queue-transaction")
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	transaction, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(transaction), "transactions")
	jobID, err := queue.Enqueue(ctx, "email.send", map[string]any{"message": "commit"})
	if err != nil {
		t.Fatal(err)
	}
	assertJobCount(t, pool, jobID, 0)
	if err := transaction.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	assertJobCount(t, pool, jobID, 1)

	transaction, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	queue = workhorse.NewQueue(workhorse.NewPGXExecutor(transaction), "transactions")
	rolledBackID, err := queue.Enqueue(ctx, "email.send", map[string]any{"message": "rollback"})
	if err != nil {
		t.Fatal(err)
	}
	if err := transaction.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	assertJobCount(t, pool, rolledBackID, 0)
}

func TestQueueSynchronizesSchedulesInsideCallerTransaction(t *testing.T) {
	ctx := context.Background()
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "queue-schedules")
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	transaction, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(transaction), "scheduled")
	enabled := true
	definitions := []workhorse.ScheduleDefinition{
		{Name: "daily", Schedule: "0 6 * * *", Job: workhorse.ScheduledJob{Type: "report", Payload: nil}},
		{Name: "cleanup", Schedule: "0 2 * * 0", Enabled: &enabled, Job: workhorse.ScheduledJob{Type: "cleanup", Payload: nil}},
	}
	if err := queue.SyncSchedules(ctx, "go-integration", definitions); err != nil {
		t.Fatal(err)
	}
	assertScheduleCount(t, pool, "go-integration", 0)
	if err := transaction.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	assertScheduleCount(t, pool, "go-integration", 2)

	queue = workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "scheduled")
	if err := queue.SyncSchedules(ctx, "go-integration", definitions); err != nil {
		t.Fatal(err)
	}
	if err := queue.SyncSchedules(ctx, "go-integration", definitions[:1]); err != nil {
		t.Fatal(err)
	}
	if err := queue.SyncSchedules(ctx, "go-integration", definitions[:1]); err != nil {
		t.Fatal(err)
	}
	rows, err := pool.Query(
		ctx,
		"SELECT schedule_name, enabled, revision FROM workhorse.schedule_definition WHERE namespace = $1 ORDER BY schedule_name",
		"go-integration",
	)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	type scheduleState struct {
		name     string
		enabled  bool
		revision int64
	}
	var states []scheduleState
	for rows.Next() {
		var state scheduleState
		if err := rows.Scan(&state.name, &state.enabled, &state.revision); err != nil {
			t.Fatal(err)
		}
		states = append(states, state)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(states) != 2 || states[0] != (scheduleState{name: "cleanup", enabled: false, revision: 2}) ||
		states[1] != (scheduleState{name: "daily", enabled: true, revision: 1}) {
		t.Fatalf("unexpected synchronized schedule state: %#v", states)
	}
}

func TestDatabaseSQLQueueUsesCallerOwnedTransaction(t *testing.T) {
	ctx := context.Background()
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "queue-database-sql")
	database, err := sql.Open("pgx", databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	transaction, err := database.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	queue := workhorse.NewQueue(workhorse.NewSQLExecutor(transaction), "transactions")
	jobID, err := queue.Enqueue(ctx, "email.send", map[string]any{"message": "commit"})
	if err != nil {
		t.Fatal(err)
	}
	assertJobCount(t, pool, jobID, 0)
	if err := transaction.Commit(); err != nil {
		t.Fatal(err)
	}
	assertJobCount(t, pool, jobID, 1)
}

func TestQueueBatchFailureIsAtomic(t *testing.T) {
	ctx := context.Background()
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "queue-atomic-batch")
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "atomic-batch")

	_, err = queue.EnqueueMany(ctx, []workhorse.EnqueueRequest{
		{Type: "email.send", Payload: map[string]any{"message": "valid"}},
		{Type: "", Payload: map[string]any{"message": "invalid"}},
	})
	if err == nil {
		t.Fatal("expected PostgreSQL to reject the invalid batch")
	}
	var count int
	if err := pool.QueryRow(
		ctx,
		"SELECT count(*)::integer FROM workhorse.job WHERE queue_name = $1",
		"atomic-batch",
	).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("failed batch inserted %d jobs", count)
	}
}

func TestQueueReturnsCanonicalKeyedAndDependencyOutcomes(t *testing.T) {
	ctx := context.Background()
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "queue-option-outcomes")
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "option-outcomes")

	prerequisite, err := queue.Enqueue(ctx, "prerequisite", nil)
	if err != nil {
		t.Fatal(err)
	}
	idempotency := workhorse.EnqueueOptions{Idempotency: &workhorse.Idempotency{Key: "same"}}
	first, err := queue.EnqueueWithResult(ctx, "idempotent", nil, idempotency)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := queue.EnqueueWithResult(ctx, "idempotent", nil, idempotency)
	if err != nil {
		t.Fatal(err)
	}
	debounce := workhorse.EnqueueOptions{Debounce: &workhorse.Debounce{
		Key: "typing", WindowMS: 1000, Schedule: workhorse.DebounceReset,
	}}
	debounced, err := queue.EnqueueWithResult(ctx, "debounce", nil, debounce)
	if err != nil {
		t.Fatal(err)
	}
	replaced, err := queue.EnqueueWithResult(ctx, "debounce", nil, debounce)
	if err != nil {
		t.Fatal(err)
	}
	throttle := workhorse.EnqueueOptions{Throttle: &workhorse.Throttle{Key: "rate", WindowMS: 1000}}
	throttled, err := queue.EnqueueWithResult(ctx, "throttle", nil, throttle)
	if err != nil {
		t.Fatal(err)
	}
	coalesced, err := queue.EnqueueWithResult(ctx, "throttle", nil, throttle)
	if err != nil {
		t.Fatal(err)
	}
	dependent, err := queue.EnqueueWithResult(ctx, "dependent", nil, workhorse.EnqueueOptions{
		Dependencies: &workhorse.Dependencies{
			PrerequisiteJobIDs: []string{prerequisite},
			OnSuccess:          workhorse.DependencyRelease, OnFailure: workhorse.DependencyCancel,
			OnCancellation: workhorse.DependencyFail,
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	if first.Outcome != workhorse.EnqueueAccepted || replayed.Outcome != workhorse.EnqueueReplayed ||
		debounced.Outcome != workhorse.EnqueueAccepted || replaced.Outcome != workhorse.EnqueueReplaced ||
		throttled.Outcome != workhorse.EnqueueAccepted || coalesced.Outcome != workhorse.EnqueueCoalesced ||
		dependent.Outcome != workhorse.EnqueueAccepted {
		t.Fatalf(
			"unexpected outcomes: %s %s %s %s %s %s %s",
			first.Outcome, replayed.Outcome, debounced.Outcome, replaced.Outcome,
			throttled.Outcome, coalesced.Outcome, dependent.Outcome,
		)
	}
}

func assertJobCount(t *testing.T, pool *pgxpool.Pool, jobID string, want int) {
	t.Helper()
	var count int
	if err := pool.QueryRow(
		context.Background(),
		"SELECT count(*)::integer FROM workhorse.job WHERE id = $1::uuid",
		jobID,
	).Scan(&count); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		t.Fatal(err)
	}
	if count != want {
		t.Fatalf("job %s count: expected %d, received %d", jobID, want, count)
	}
}

func assertScheduleCount(t *testing.T, pool *pgxpool.Pool, namespace string, want int) {
	t.Helper()
	var count int
	if err := pool.QueryRow(
		context.Background(),
		"SELECT count(*)::integer FROM workhorse.schedule_definition WHERE namespace = $1",
		namespace,
	).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != want {
		t.Fatalf("schedule count: expected %d, received %d", want, count)
	}
}
