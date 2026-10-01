package workhorse_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

func TestWorkerFiresSchedulesWhenAnotherWorkerOwnsTheMaintenanceTick(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-schedule-lock")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "scheduled")
	if err := queue.SyncSchedules(ctx, "go-worker", []workhorse.ScheduleDefinition{{
		Name: "billing-rollup", Schedule: "* * * * * *",
		Task: workhorse.ScheduledTask{Type: "billing.rollup", Payload: map[string]any{}},
	}}); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "UPDATE workhorse.schedule_definition SET last_evaluated_at = clock_timestamp() - interval '1 second'"); err != nil {
		t.Fatal(err)
	}

	lock, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = lock.Rollback(ctx) }()
	if _, err := lock.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtextextended('workhorse:tick', 0))"); err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "scheduled", WorkerID: "go-schedule-lock-worker", ScheduleNamespaces: []string{"go-worker"},
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("billing.rollup", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return map[string]any{"fired": true}, nil
	})

	if processed, err := worker.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("locked maintenance run: processed=%t err=%v", processed, err)
	}
	assertScheduleOccurrenceCount(t, ctx, pool, "go-worker", "billing-rollup", 1)
}

func TestFiredScheduleCarriesTheCurrentContract(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-schedule-contract")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "scheduled").SyncContracts(
		ctx,
		map[string]workhorse.TaskTypeContracts{"billing.statement": {
			CurrentVersion: "v2",
			Versions: map[string]workhorse.TaskContractVersion{"v2": {
				PayloadSchema: map[string]any{
					"type": "object", "required": []any{"account"},
					"properties": map[string]any{"account": map[string]any{"type": "string"}},
				},
				ResultSchema:         map[string]any{"type": "object"},
				MaxPayloadBytes:      4096,
				MaxResultBytes:       8192,
				SensitivePayloadKeys: []string{"cardNumber"},
				SensitiveResultKeys:  []string{"receipt"},
			}},
		}},
	); err != nil {
		t.Fatal(err)
	}

	// A separate queue has no cached contracts, as in an application that schedules from another
	// process than the one that synchronized them.
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "scheduled")
	statement := func(payload map[string]any) []workhorse.ScheduleDefinition {
		return []workhorse.ScheduleDefinition{{
			Name: "monthly-statement", Schedule: "* * * * * *",
			Task: workhorse.ScheduledTask{Type: "billing.statement", Payload: payload},
		}}
	}
	var validationErr *workhorse.TaskContractValidationError
	err = queue.SyncSchedules(ctx, "go-contract", statement(map[string]any{"account": 7}))
	if !errors.As(err, &validationErr) || validationErr.Version != "v2" || validationErr.Kind != "payload" {
		t.Fatalf("invalid payload: expected TaskContractValidationError for v2, received %v", err)
	}
	assertScheduleCount(t, pool, "go-contract", 0)

	if err := queue.SyncSchedules(
		ctx,
		"go-contract",
		statement(map[string]any{"account": "acct-1", "cardNumber": "4111"}),
	); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "UPDATE workhorse.schedule_definition SET last_evaluated_at = clock_timestamp() - interval '1 second'"); err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "scheduled", WorkerID: "go-schedule-contract-worker", ScheduleNamespaces: []string{"go-contract"},
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("billing.statement", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return map[string]any{}, nil
	})
	if processed, err := worker.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("fire schedule: processed=%t err=%v", processed, err)
	}

	var (
		contractVersion   *string
		payloadMaxBytes   int
		resultMaxBytes    int
		resultRedactKeys  []string
		dashboardPayload  []byte
		payloadRedactKeys []string
	)
	if err := pool.QueryRow(ctx, `
SELECT task.contract_version, task.payload_max_bytes, task.result_max_bytes, task.result_redact_keys,
       dashboard.payload, dashboard.payload_redact_keys
  FROM workhorse.schedule_occurrence occurrence
  JOIN workhorse.task task ON task.id = occurrence.task_id
  JOIN workhorse.dashboard_task_v1 dashboard ON dashboard.id = task.id
 WHERE occurrence.namespace = $1`, "go-contract").Scan(
		&contractVersion, &payloadMaxBytes, &resultMaxBytes, &resultRedactKeys,
		&dashboardPayload, &payloadRedactKeys,
	); err != nil {
		t.Fatal(err)
	}
	if contractVersion == nil || *contractVersion != "v2" || payloadMaxBytes != 4096 || resultMaxBytes != 8192 ||
		!slices.Equal(resultRedactKeys, []string{"receipt"}) {
		t.Fatalf(
			"fired task contract: version=%v payloadMaxBytes=%d resultMaxBytes=%d resultRedactKeys=%v",
			contractVersion, payloadMaxBytes, resultMaxBytes, resultRedactKeys,
		)
	}
	var payload map[string]any
	if err := json.Unmarshal(dashboardPayload, &payload); err != nil {
		t.Fatal(err)
	}
	if _, exposed := payload["cardNumber"]; exposed || payload["account"] != "acct-1" ||
		!slices.Equal(payloadRedactKeys, []string{"cardNumber"}) {
		t.Fatalf("dashboard payload: payload=%v redactKeys=%v", payload, payloadRedactKeys)
	}
}

func TestSQLExecutorSynchronizesContractedSchedules(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "sql-schedule-contract")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	database, err := sql.Open("pgx", databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	// database/sql scans a text[] column as its text form, such as {cardNumber} or {}.
	queue := workhorse.NewQueue(workhorse.NewSQLExecutor(database), "scheduled")
	objectSchema := map[string]any{"type": "object"}
	if err := queue.SyncContracts(ctx, map[string]workhorse.TaskTypeContracts{
		"billing.statement": {CurrentVersion: "v1", Versions: map[string]workhorse.TaskContractVersion{"v1": {
			PayloadSchema: objectSchema, ResultSchema: objectSchema,
			SensitivePayloadKeys: []string{"cardNumber", "cvv"}, SensitiveResultKeys: []string{"receipt"},
		}}},
		"billing.rollup": {CurrentVersion: "v1", Versions: map[string]workhorse.TaskContractVersion{"v1": {
			PayloadSchema: objectSchema, ResultSchema: objectSchema,
		}}},
	}); err != nil {
		t.Fatal(err)
	}
	if err := queue.SyncSchedules(ctx, "sql-contract", []workhorse.ScheduleDefinition{
		{Name: "statement", Schedule: "0 * * * *", Task: workhorse.ScheduledTask{Type: "billing.statement", Payload: map[string]any{}}},
		{Name: "rollup", Schedule: "0 * * * *", Task: workhorse.ScheduledTask{Type: "billing.rollup", Payload: map[string]any{}}},
	}); err != nil {
		t.Fatalf("sync contracted schedules through database/sql: %v", err)
	}

	for name, want := range map[string][2][]string{
		"statement": {{"cardNumber", "cvv"}, {"receipt"}},
		"rollup":    {{}, {}},
	} {
		var payloadRedactKeys, resultRedactKeys []string
		if err := pool.QueryRow(ctx, `
SELECT payload_redact_keys, result_redact_keys
  FROM workhorse.schedule_definition
 WHERE namespace = 'sql-contract' AND schedule_name = $1`, name).Scan(&payloadRedactKeys, &resultRedactKeys); err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(payloadRedactKeys, want[0]) || !slices.Equal(resultRedactKeys, want[1]) {
			t.Fatalf("%s redact keys: payload=%v result=%v", name, payloadRedactKeys, resultRedactKeys)
		}
	}
}

func TestWorkerLimitsScheduleCatchup(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-schedule-catchup")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "scheduled")
	if err := queue.SyncSchedules(ctx, "go-worker", []workhorse.ScheduleDefinition{{
		Name: "billing-rollup", Schedule: "* * * * * *",
		CatchupPolicy: workhorse.ScheduleCatchupAll,
		Task:          workhorse.ScheduledTask{Type: "billing.rollup", Payload: map[string]any{}},
	}}); err != nil {
		t.Fatal(err)
	}
	var revision int64
	if err := pool.QueryRow(
		ctx,
		"SELECT revision FROM workhorse.schedule_definition WHERE namespace = 'go-worker' AND schedule_name = 'billing-rollup'",
	).Scan(&revision); err != nil {
		t.Fatal(err)
	}
	seed := time.Now().UTC().Truncate(time.Second).Add(-6 * time.Second)
	var seededTaskID string
	if err := pool.QueryRow(
		ctx,
		"SELECT workhorse.fire_schedule_v1($1, $2, $3, $4)",
		"go-worker", "billing-rollup", revision, seed,
	).Scan(&seededTaskID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "UPDATE workhorse.schedule_definition SET last_evaluated_at = $1 WHERE namespace = 'go-worker'", seed); err != nil {
		t.Fatal(err)
	}

	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "scheduled", WorkerID: "go-schedule-catchup-worker", ScheduleNamespaces: []string{"go-worker"},
		ScheduleCatchupLimit: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("billing.rollup", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return map[string]any{"fired": true}, nil
	})
	if processed, err := worker.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("catch-up run: processed=%t err=%v", processed, err)
	}
	assertScheduleOccurrenceCount(t, ctx, pool, "go-worker", "billing-rollup", 3)
}

func assertScheduleOccurrenceCount(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	namespace string,
	name string,
	want int,
) {
	t.Helper()
	var count int
	if err := pool.QueryRow(
		ctx,
		"SELECT count(*)::integer FROM workhorse.schedule_occurrence WHERE namespace = $1 AND schedule_name = $2",
		namespace,
		name,
	).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != want {
		t.Fatalf("schedule occurrence count: expected %d, received %d", want, count)
	}
}

func TestWorkerValidatesScheduleOptions(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-schedule-options")
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	for _, options := range []workhorse.WorkerOptions{
		{ScheduleNamespaces: []string{"billing", ""}},
		{ScheduleCatchupLimit: -1},
		{ScheduleCatchupLimit: 10_001},
	} {
		if _, err := workhorse.NewWorker(pool, options); err == nil {
			t.Fatalf("expected invalid schedule options to fail: %#v", options)
		}
	}

	if _, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		ScheduleNamespaces:   []string{"billing", "billing"},
		ScheduleCatchupLimit: 10_000,
	}); err != nil {
		t.Fatalf("expected valid schedule options: %v", err)
	}
}
