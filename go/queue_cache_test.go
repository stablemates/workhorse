package workhorse_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

func compatibleRows() []workhorse.Row {
	return []workhorse.Row{
		{"kind": "schema", "version": int64(testSchemaVersion)},
		{"kind": "protocol", "version": int64(workhorse.ProtocolVersion)},
	}
}

func contractDefinitionRow(version string) workhorse.Row {
	return workhorse.Row{
		"version": version,
		"schema": map[string]any{
			"payload": map[string]any{"type": "object", "required": []any{"name"}},
			"result":  true,
		},
		"payload_max_bytes":   int32(2048),
		"result_max_bytes":    int32(4096),
		"payload_redact_keys": []string{},
		"result_redact_keys":  []string{},
	}
}

func acceptedRow(taskID string) []workhorse.Row {
	return []workhorse.Row{{"ordinal": int32(1), "task_id": taskID, "outcome": "accepted", "reason": nil}}
}

func contractMismatchRow(taskTypes ...string) []workhorse.Row {
	reason, _ := json.Marshal(map[string]any{"taskTypes": taskTypes})
	return []workhorse.Row{{"ordinal": int32(0), "task_id": nil, "outcome": "contract_mismatch", "reason": string(reason)}}
}

func enqueuedContractVersion(t *testing.T, call queueCall) any {
	t.Helper()
	encoded, ok := call.arguments[0].([]byte)
	if !ok {
		t.Fatalf("enqueue argument is %T, expected []byte", call.arguments[0])
	}
	var request []map[string]any
	if err := json.Unmarshal(encoded, &request); err != nil {
		t.Fatal(err)
	}
	return request[0]["contractVersion"]
}

func syncEmailContract(t *testing.T, queue *workhorse.Queue, version string) {
	t.Helper()
	err := queue.SyncContracts(context.Background(), map[string]workhorse.TaskTypeContracts{
		"email.send": {CurrentVersion: version, Versions: map[string]workhorse.TaskContractVersion{version: {}}},
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestQueueWarmEnqueueIssuesOnlyTheEnqueueStatement(t *testing.T) {
	executor := &queueExecutor{responses: [][]workhorse.Row{
		compatibleRows(), {},
		compatibleRows(), {contractDefinitionRow("v1")}, acceptedRow("first"),
		acceptedRow("second"),
	}}
	queue := workhorse.NewQueue(executor, "default")
	syncEmailContract(t, queue, "v1")
	ctx := context.Background()

	if _, err := queue.Enqueue(ctx, "email.send", map[string]any{"name": "warm-up"}); err != nil {
		t.Fatal(err)
	}
	before := len(executor.calls)
	if _, err := queue.Enqueue(ctx, "email.send", map[string]any{"name": "warm"}); err != nil {
		t.Fatal(err)
	}

	warm := executor.calls[before:]
	if len(warm) != 1 || !strings.Contains(warm[0].statement, "enqueue_many_v1") {
		t.Fatalf("expected one enqueue_many_v1 statement after warm-up, recorded %#v", warm)
	}
	if version := enqueuedContractVersion(t, warm[0]); version != "v1" {
		t.Fatalf("warm enqueue lost the cached contract version: %#v", version)
	}
}

func TestQueueRefreshesContractsOnMismatchAndRetriesOnce(t *testing.T) {
	executor := &queueExecutor{responses: [][]workhorse.Row{
		compatibleRows(), {},
		compatibleRows(), {contractDefinitionRow("v1")}, acceptedRow("first"),
		contractMismatchRow("email.send"), {contractDefinitionRow("v2")}, acceptedRow("second"),
		acceptedRow("third"),
	}}
	queue := workhorse.NewQueue(executor, "default")
	syncEmailContract(t, queue, "v1")
	ctx := context.Background()

	if _, err := queue.Enqueue(ctx, "email.send", map[string]any{"name": "one"}); err != nil {
		t.Fatal(err)
	}
	before := len(executor.calls)
	taskID, err := queue.Enqueue(ctx, "email.send", map[string]any{"name": "two"})
	if err != nil {
		t.Fatal(err)
	}
	if taskID != "second" {
		t.Fatalf("expected the retried enqueue result, received %q", taskID)
	}
	refreshed := executor.calls[before:]
	if len(refreshed) != 3 || !strings.Contains(refreshed[1].statement, "get_contract_definition_v1") {
		t.Fatalf("expected enqueue, one contract refresh, and a retry; recorded %#v", refreshed)
	}
	if version := enqueuedContractVersion(t, refreshed[2]); version != "v2" {
		t.Fatalf("retry was not stamped with the refreshed version: %#v", version)
	}

	before = len(executor.calls)
	if _, err := queue.Enqueue(ctx, "email.send", map[string]any{"name": "three"}); err != nil {
		t.Fatal(err)
	}
	if calls := executor.calls[before:]; len(calls) != 1 || enqueuedContractVersion(t, calls[0]) != "v2" {
		t.Fatalf("expected the refreshed contract to stay cached, recorded %#v", calls)
	}
}

func TestQueueRefusesASecondContractMismatch(t *testing.T) {
	executor := &queueExecutor{responses: [][]workhorse.Row{
		compatibleRows(), {},
		compatibleRows(), {contractDefinitionRow("v1")},
		contractMismatchRow("email.send"), {contractDefinitionRow("v2")},
		contractMismatchRow("email.send"), {contractDefinitionRow("v3")},
	}}
	queue := workhorse.NewQueue(executor, "default")
	syncEmailContract(t, queue, "v1")

	_, err := queue.Enqueue(context.Background(), "email.send", map[string]any{"name": "one"})
	if !errors.Is(err, workhorse.ErrContractPolicyChanged) {
		t.Fatalf("expected ErrContractPolicyChanged, received %v", err)
	}
	if len(executor.responses) != 0 {
		t.Fatalf("expected both mismatches to refresh the cache, %d responses left", len(executor.responses))
	}
}

func TestQueueSyncContractsInvalidatesCachedDefinitions(t *testing.T) {
	executor := &queueExecutor{responses: [][]workhorse.Row{
		compatibleRows(), {},
		compatibleRows(), {contractDefinitionRow("v1")}, acceptedRow("first"),
		compatibleRows(), {},
		{contractDefinitionRow("v2")}, acceptedRow("second"),
	}}
	queue := workhorse.NewQueue(executor, "default")
	syncEmailContract(t, queue, "v1")
	ctx := context.Background()
	if _, err := queue.Enqueue(ctx, "email.send", map[string]any{"name": "one"}); err != nil {
		t.Fatal(err)
	}

	syncEmailContract(t, queue, "v2")
	before := len(executor.calls)
	if _, err := queue.Enqueue(ctx, "email.send", map[string]any{"name": "two"}); err != nil {
		t.Fatal(err)
	}
	calls := executor.calls[before:]
	if len(calls) != 2 || !strings.Contains(calls[0].statement, "get_contract_definition_v1") ||
		enqueuedContractVersion(t, calls[1]) != "v2" {
		t.Fatalf("expected a fresh lookup after SyncContracts, recorded %#v", calls)
	}
}

func TestQueueRetriesACompatibilityCheckThatFailedTransiently(t *testing.T) {
	executor := &queueExecutor{
		errors:    []error{errors.New("connection reset")},
		responses: [][]workhorse.Row{compatibleRows(), acceptedRow("first"), acceptedRow("second")},
	}
	queue := workhorse.NewQueue(executor, "default")
	ctx := context.Background()

	if _, err := queue.Enqueue(ctx, "email.send", nil); err == nil || !strings.Contains(err.Error(), "connection reset") {
		t.Fatalf("expected the transient error, received %v", err)
	}
	for range 2 {
		if _, err := queue.Enqueue(ctx, "email.send", nil); err != nil {
			t.Fatal(err)
		}
	}
	compatibilityQueries := 0
	for _, call := range executor.calls {
		if strings.Contains(call.statement, "workhorse.protocol_version") {
			compatibilityQueries++
		}
	}
	if compatibilityQueries != 2 {
		t.Fatalf("expected one failed and one cached compatibility query, recorded %d", compatibilityQueries)
	}
}

type statementLog struct {
	executor   workhorse.Executor
	mu         sync.Mutex
	statements []string
}

func (log *statementLog) Query(ctx context.Context, statement string, arguments ...any) ([]workhorse.Row, error) {
	log.mu.Lock()
	log.statements = append(log.statements, statement)
	log.mu.Unlock()
	return log.executor.Query(ctx, statement, arguments...)
}

func (log *statementLog) since(index int) []string {
	log.mu.Lock()
	defer log.mu.Unlock()
	return append([]string(nil), log.statements[index:]...)
}

func (log *statementLog) length() int {
	log.mu.Lock()
	defer log.mu.Unlock()
	return len(log.statements)
}

func TestQueueWarmEnqueueIsOneRoundTripAgainstPostgreSQL(t *testing.T) {
	ctx := context.Background()
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "queue-producer-cache")
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	log := &statementLog{executor: workhorse.NewPGXExecutor(pool)}
	producer := workhorse.NewQueue(log, "producer-cache")
	syncEmailContract(t, producer, "v1")

	if _, err := producer.Enqueue(ctx, "email.send", map[string]any{"name": "warm-up"}); err != nil {
		t.Fatal(err)
	}
	before := log.length()
	if _, err := producer.Enqueue(ctx, "email.send", map[string]any{"name": "warm"}); err != nil {
		t.Fatal(err)
	}
	if warm := log.since(before); len(warm) != 1 || !strings.Contains(warm[0], "enqueue_many_v1") {
		t.Fatalf("expected one statement per warm enqueue, recorded %d: %v", len(warm), warm)
	}

	// Another producer moves the policy on; the cached producer learns of it from the enqueue.
	syncEmailContract(t, workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "producer-cache"), "v2")
	before = log.length()
	taskID, err := producer.Enqueue(ctx, "email.send", map[string]any{"name": "after-change"})
	if err != nil {
		t.Fatal(err)
	}
	if refreshed := log.since(before); len(refreshed) != 3 {
		t.Fatalf("expected enqueue, refresh, and retry after a policy change, recorded %d", len(refreshed))
	}
	var version string
	if err := pool.QueryRow(ctx, "SELECT contract_version FROM workhorse.task WHERE id = $1::uuid", taskID).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != "v2" {
		t.Fatalf("expected the retried task to carry v2, stored %q", version)
	}
}
