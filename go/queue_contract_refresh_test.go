package workhorse_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

// These tests cover an operator override that PostgreSQL never reports: the queue rejects the
// payload under its cached contract, so no enqueue reaches enqueue_many_v1.

func requiringContract(key string) workhorse.TaskContractVersion {
	return workhorse.TaskContractVersion{
		PayloadSchema: map[string]any{"type": "object", "required": []any{key}},
	}
}

func syncOverridableContracts(
	t *testing.T,
	queue *workhorse.Queue,
	versions map[string]workhorse.TaskContractVersion,
) {
	t.Helper()
	err := queue.SyncContracts(context.Background(), map[string]workhorse.TaskTypeContracts{
		"email.send": {CurrentVersion: "one", Versions: versions},
	})
	if err != nil {
		t.Fatal(err)
	}
}

func overrideEmailContract(t *testing.T, executor workhorse.Executor, version string) {
	t.Helper()
	_, err := executor.Query(
		context.Background(),
		"SELECT workhorse.override_contract_version_v1($1, $2)",
		"email.send",
		version,
	)
	if err != nil {
		t.Fatal(err)
	}
}

func storedContractVersion(t *testing.T, executor workhorse.Executor, taskID string) string {
	t.Helper()
	rows, err := executor.Query(
		context.Background(),
		"SELECT contract_version FROM workhorse.task WHERE id = $1::uuid",
		taskID,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("expected one task row for %s, found %d", taskID, len(rows))
	}
	version, _ := rows[0]["contract_version"].(string)
	return version
}

func contractRefreshPool(t *testing.T, name string) *pgxpool.Pool {
	t.Helper()
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), name)
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func countDefinitionReads(statements []string) int {
	reads := 0
	for _, statement := range statements {
		if strings.Contains(statement, "get_contract_definition_v1") {
			reads++
		}
	}
	return reads
}

func TestQueueRevalidatesAPayloadAfterAnOperatorOverride(t *testing.T) {
	ctx := context.Background()
	executor := workhorse.NewPGXExecutor(contractRefreshPool(t, "queue-override-refresh"))
	queue := workhorse.NewQueue(executor, "override-refresh")
	syncEmailContractVersions(t, queue)
	if _, err := queue.Enqueue(ctx, "email.send", map[string]any{"one": true}); err != nil {
		t.Fatal(err)
	}

	overrideEmailContract(t, executor, "two")
	taskID, err := queue.Enqueue(ctx, "email.send", map[string]any{"two": true})
	if err != nil {
		t.Fatalf("a payload valid under the selected version was rejected by the cached one: %v", err)
	}
	if version := storedContractVersion(t, executor, taskID); version != "two" {
		t.Fatalf("expected the task to carry the selected version two, stored %q", version)
	}
}

func TestQueueAcceptsAPayloadUnderARaisedSizeLimit(t *testing.T) {
	// The Go queue does not check payload size at enqueue. enqueue_many_v1 reports the stale
	// version as contract_mismatch before it applies the size limit, so this passes without a reload.
	ctx := context.Background()
	executor := workhorse.NewPGXExecutor(contractRefreshPool(t, "queue-raised-limit"))
	queue := workhorse.NewQueue(executor, "raised-limit")
	syncOverridableContracts(t, queue, map[string]workhorse.TaskContractVersion{
		"one":   {MaxPayloadBytes: 128},
		"roomy": {MaxPayloadBytes: 4096},
	})
	large := map[string]any{"body": strings.Repeat("x", 512)}
	if _, err := queue.Enqueue(ctx, "email.send", large); err == nil {
		t.Fatal("expected the default version to reject a payload above its limit")
	}

	overrideEmailContract(t, executor, "roomy")
	taskID, err := queue.Enqueue(ctx, "email.send", large)
	if err != nil {
		t.Fatalf("a payload within the selected version's limit was rejected: %v", err)
	}
	if version := storedContractVersion(t, executor, taskID); version != "roomy" {
		t.Fatalf("expected the task to carry the roomy version, stored %q", version)
	}
}

func TestQueueReloadsAContractThroughTheCallersTransaction(t *testing.T) {
	ctx := context.Background()
	pool := contractRefreshPool(t, "queue-override-transaction")
	transaction, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	executor := workhorse.NewPGXExecutor(transaction)
	queue := workhorse.NewQueue(executor, "override-tx")
	syncEmailContractVersions(t, queue)
	if _, err := queue.Enqueue(ctx, "email.send", map[string]any{"one": true}); err != nil {
		t.Fatal(err)
	}

	// The override is visible only inside the transaction, so the reload must read through it.
	overrideEmailContract(t, executor, "two")
	taskID, err := queue.Enqueue(ctx, "email.send", map[string]any{"two": true})
	if err != nil {
		t.Fatalf("the reload did not read the override inside the caller's transaction: %v", err)
	}
	if version := storedContractVersion(t, executor, taskID); version != "two" {
		t.Fatalf("expected the task to carry version two, stored %q", version)
	}
}

func syncEmailContractVersions(t *testing.T, queue *workhorse.Queue) {
	t.Helper()
	syncOverridableContracts(t, queue, map[string]workhorse.TaskContractVersion{
		"one": requiringContract("one"),
		"two": requiringContract("two"),
	})
}

func TestQueueReportsAPayloadInvalidUnderTheCurrentContractAfterOneReload(t *testing.T) {
	ctx := context.Background()
	pool := contractRefreshPool(t, "queue-override-invalid")
	log := &statementLog{executor: workhorse.NewPGXExecutor(pool)}
	queue := workhorse.NewQueue(log, "override-invalid")
	syncEmailContractVersions(t, queue)
	if _, err := queue.Enqueue(ctx, "email.send", map[string]any{"one": true}); err != nil {
		t.Fatal(err)
	}

	assertRejection := func(version string) {
		t.Helper()
		before := log.length()
		_, err := queue.EnqueueMany(ctx, []workhorse.EnqueueRequest{
			{Type: "email.send", Payload: map[string]any{"three": true}},
			{Type: "email.send", Payload: map[string]any{"three": true}},
		})
		var validation *workhorse.TaskContractValidationError
		if !errors.As(err, &validation) {
			t.Fatalf("expected a contract validation error, got %v", err)
		}
		if validation.Version != version {
			t.Fatalf("expected the rejection to name version %s, named %q", version, validation.Version)
		}
		statements := log.since(before)
		if reads := countDefinitionReads(statements); reads != 1 || len(statements) != 1 {
			t.Fatalf("expected exactly one contract reload, recorded %v", statements)
		}
	}
	assertRejection("one")
	overrideEmailContract(t, log, "two")
	assertRejection("two")

	// A batch reloads a task type once, even when a later request fails under the reloaded contract.
	overrideEmailContract(t, log, "one")
	before := log.length()
	_, err := queue.EnqueueMany(ctx, []workhorse.EnqueueRequest{
		{Type: "email.send", Payload: map[string]any{"one": true}},
		{Type: "email.send", Payload: map[string]any{"two": true}},
	})
	var validation *workhorse.TaskContractValidationError
	if !errors.As(err, &validation) || validation.Version != "one" {
		t.Fatalf("expected the second request to fail under version one, got %v", err)
	}
	if statements := log.since(before); countDefinitionReads(statements) != 1 || len(statements) != 1 {
		t.Fatalf("expected one contract reload for the batch, recorded %v", statements)
	}
}

type contractRaceRole struct{}

// contractRaceExecutor lets a test pause one enqueue between PostgreSQL statements. after runs once a
// statement returns and before runs before a statement is sent, each with the caller's context.
type contractRaceExecutor struct {
	executor workhorse.Executor
	before   func(ctx context.Context, statement string, arguments []any)
	after    func(ctx context.Context, statement string, arguments []any)
}

func (race *contractRaceExecutor) Query(
	ctx context.Context,
	statement string,
	arguments ...any,
) ([]workhorse.Row, error) {
	race.before(ctx, statement, arguments)
	rows, err := race.executor.Query(ctx, statement, arguments...)
	race.after(ctx, statement, arguments)
	return rows, err
}

func TestQueueValidatesABatchAgainstTheDefinitionItReadDespiteAConcurrentStaleStore(t *testing.T) {
	ctx := context.Background()
	executor := workhorse.NewPGXExecutor(contractRefreshPool(t, "queue-override-race"))
	staleRead, resumeStale, staleStored, freshDone := make(chan struct{}), make(chan struct{}),
		make(chan struct{}), make(chan struct{})
	var closeFreshDone, pauseStale sync.Once
	t.Cleanup(func() { closeFreshDone.Do(func() { close(freshDone) }) })
	await := func(step string, signal <-chan struct{}) {
		select {
		case <-signal:
		case <-time.After(10 * time.Second):
			t.Errorf("the race did not reach %s", step)
		}
	}
	definitionRead := func(statement string, arguments []any, taskType string) bool {
		return strings.Contains(statement, "get_contract_definition_v1") &&
			len(arguments) > 0 && arguments[0] == taskType
	}
	race := &contractRaceExecutor{
		executor: executor,
		before: func(ctx context.Context, statement string, _ []any) {
			// The stale enqueue sends its batch only after it stored version one in the shared cache.
			if ctx.Value(contractRaceRole{}) == "stale" && strings.Contains(statement, "enqueue_many_v1") {
				close(staleStored)
				await("the end of the fresh batch", freshDone)
			}
		},
		after: func(ctx context.Context, statement string, arguments []any) {
			switch ctx.Value(contractRaceRole{}) {
			case "stale":
				// Only the first read pauses; the contract_mismatch refresh that follows reads again.
				if definitionRead(statement, arguments, "email.send") {
					pauseStale.Do(func() {
						close(staleRead)
						await("the fresh batch's second task type", resumeStale)
					})
				}
			case "fresh":
				// Between two email.send requests, let the stale enqueue overwrite the shared entry.
				if definitionRead(statement, arguments, "audit.record") {
					close(resumeStale)
					await("the stale store", staleStored)
				}
			}
		},
	}
	queue := workhorse.NewQueue(race, "override-race")
	syncEmailContractVersions(t, queue)

	staleDone := make(chan struct{})
	go func() {
		defer close(staleDone)
		staleContext := context.WithValue(ctx, contractRaceRole{}, "stale")
		_, _ = queue.Enqueue(staleContext, "email.send", map[string]any{"one": true})
	}()
	await("the stale definition read", staleRead)
	overrideEmailContract(t, executor, "two")

	freshContext := context.WithValue(ctx, contractRaceRole{}, "fresh")
	taskIDs, err := queue.EnqueueMany(freshContext, []workhorse.EnqueueRequest{
		{Type: "email.send", Payload: map[string]any{"two": true}},
		{Type: "audit.record", Payload: map[string]any{}},
		{Type: "email.send", Payload: map[string]any{"two": true}},
	})
	closeFreshDone.Do(func() { close(freshDone) })
	await("the end of the stale enqueue", staleDone)
	if err != nil {
		t.Fatalf("a concurrent store of an older definition rejected the batch: %v", err)
	}
	for _, index := range []int{0, 2} {
		if version := storedContractVersion(t, executor, taskIDs[index]); version != "two" {
			t.Fatalf("expected request %d to carry version two, stored %q", index, version)
		}
	}
}
