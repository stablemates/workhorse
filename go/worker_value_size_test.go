package workhorse_test

import (
	"bytes"
	"context"
	"encoding/json"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

// completeStatementFragment matches complete_v1 without matching complete_many_and_claim_v1.
const completeStatementFragment = "workhorse.complete_v1("

func tracedValueSizePool(t *testing.T, name string) (*pgxpool.Pool, *statementRecordingTracer) {
	t.Helper()
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), name)
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	tracer := &statementRecordingTracer{}
	config.ConnConfig.Tracer = tracer
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool, tracer
}

func jsonbTextLength(t *testing.T, pool *pgxpool.Pool, document string) int {
	t.Helper()
	var length int
	if err := pool.QueryRow(
		context.Background(), "SELECT octet_length($1::text::jsonb::text)", document,
	).Scan(&length); err != nil {
		t.Fatal(err)
	}
	return length
}

func taskOutcomeError(t *testing.T, pool *pgxpool.Pool, taskID string) (string, string) {
	t.Helper()
	var state string
	var errorName *string
	if err := pool.QueryRow(
		context.Background(),
		"SELECT state, error->>'name' FROM workhorse.task_outcome WHERE task_id = $1::uuid",
		taskID,
	).Scan(&state, &errorName); err != nil {
		t.Fatal(err)
	}
	if errorName == nil {
		return state, emptyErrorName
	}
	return state, *errorName
}

const emptyErrorName = ""

// The jsonb text PostgreSQL measures differs from Go's compact encoding in separator spacing,
// escaping, and number notation. The worker's measure must agree with PostgreSQL on every one.
func TestResultMeasureMatchesPostgreSQLJSONBText(t *testing.T) {
	pool := fastTierPool(t, "value-size-measure")
	documents := []string{
		`null`, `true`, `false`, `{}`, `[]`,
		`{"a":1,"b":[1,2,{"c":null}]}`,
		`{"key": "value", "nested": {"inner": [true, false]}}`,
		`{"a":1,"a":2}`,
		`"plain"`, `"é"`, `"日本語"`, `"😀 grinning"`, `"é日"`,
		`"quote \" backslash \\ slash \/"`, `"\b\f\n\r\t"`, `"\u0001\u001f\u007f"`,
		`"<a&b>"`, `"  "`, `{"ключ":"значение"}`,
		`0`, `-0`, `-0.0`, `0.000`, `1.50`, `-12.250`, `100`, `123456789012345678901234567890`,
		`1e3`, `1E3`, `1e+3`, `1e-3`, `1.5e2`, `12.34e1`, `-1e2`, `0e5`, `0.0e-3`,
		`1e-7`, `1.0e-2`, `1.25e-1`, `-1.5E+10`, `0.001e3`, `000e0`,
		`[1e400, -2.5e-20, 7e0]`,
	}
	for _, document := range documents {
		if !json.Valid([]byte(document)) {
			// PostgreSQL rejects what encoding/json rejects, such as leading zeros.
			continue
		}
		decoder := json.NewDecoder(bytes.NewReader([]byte(document)))
		decoder.UseNumber()
		var decoded any
		if err := decoder.Decode(&decoded); err != nil {
			t.Fatal(err)
		}
		expected := jsonbTextLength(t, pool, document)
		if actual := workhorse.JSONBTextBytesForTest(decoded); actual != expected {
			t.Errorf("measure of %s is %d bytes, PostgreSQL stores %d", document, actual, expected)
		}
	}
}

// An oversized result used to reach complete_v1, whose refusal ended Run. The worker now fails the
// attempt itself, so the task records the failure and the next task still completes.
func TestWorkerFailsAnOversizedResultAndKeepsRunning(t *testing.T) {
	pool, tracer := tracedValueSizePool(t, "worker-oversized-result")
	ctx := context.Background()
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-oversized-result")
	oversizedID, err := queue.Enqueue(ctx, "result.oversized", nil, workhorse.EnqueueOptions{MaxAttempts: 1})
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-oversized-result", WorkerID: "go-oversized-result",
		LeaseDuration: 5 * time.Second, PollInterval: 5 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	// The default limit is 1 MiB, and the quotes alone put this string over it.
	worker.Handle("result.oversized", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return strings.Repeat("x", 1<<20), nil
	})
	worker.Handle("result.valid", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return map[string]any{"ok": true}, nil
	})

	runContext, stop := context.WithCancel(ctx)
	defer stop()
	result := make(chan error, 1)
	go func() { result <- worker.Run(runContext) }()

	waitForOutcome := func(taskID string) {
		t.Helper()
		deadline := time.Now().Add(20 * time.Second)
		for {
			var count int
			if err := pool.QueryRow(
				ctx, "SELECT count(*) FROM workhorse.task_outcome WHERE task_id = $1::uuid", taskID,
			).Scan(&count); err != nil {
				t.Fatal(err)
			}
			if count == 1 {
				return
			}
			select {
			case err := <-result:
				t.Fatalf("Run stopped before task %s settled: %v", taskID, err)
			default:
			}
			if time.Now().After(deadline) {
				t.Fatalf("task %s did not settle in time", taskID)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	waitForOutcome(oversizedID)
	validID, err := queue.Enqueue(ctx, "result.valid", nil)
	if err != nil {
		t.Fatal(err)
	}
	waitForOutcome(validID)

	stop()
	if err := <-result; err != nil {
		t.Fatalf("Run returned %v", err)
	}
	if state, name := taskOutcomeError(t, pool, oversizedID); state != "failed" || name != "TaskValueSizeLimitError" {
		t.Fatalf("oversized result settled as state=%s error=%q", state, name)
	}
	if state, _ := taskOutcomeError(t, pool, validID); state != "succeeded" {
		t.Fatalf("valid task settled as %s", state)
	}
	var failures int
	if err := pool.QueryRow(
		ctx, "SELECT count(*) FROM workhorse.attempt_history WHERE task_id = $1::uuid", oversizedID,
	).Scan(&failures); err != nil {
		t.Fatal(err)
	}
	if failures != 1 {
		t.Fatalf("oversized task recorded %d failed attempts", failures)
	}
	if calls := tracer.count(completeStatementFragment); calls != 1 {
		t.Fatalf("worker called complete_v1 %d times; only the valid task should reach it", calls)
	}
}

// A contracted task measures against its own resultMaxBytes. A result at the limit completes, and a
// result one byte over fails the attempt under the retry policy rather than ending the attempt early.
func TestWorkerMeasuresAContractedResultAgainstItsLimit(t *testing.T) {
	pool, tracer := tracedValueSizePool(t, "worker-contract-result-size")
	ctx := context.Background()
	// Multibyte characters, escapes, separator spacing, and an exponent number make the stored text
	// differ from Go's compact encoding.
	atLimit := map[string]any{
		"text":   "é日😀 \"quoted\"\n<tag>",
		"values": []any{1, 2.5, json.Number("1e3")},
	}
	encoded, err := json.Marshal(atLimit)
	if err != nil {
		t.Fatal(err)
	}
	limit := jsonbTextLength(t, pool, string(encoded))
	if len(encoded)*2 <= limit {
		t.Fatalf("the boundary value must not take the short path: compact=%d limit=%d", len(encoded), limit)
	}
	overLimit := map[string]any{"text": atLimit["text"].(string) + "x", "values": atLimit["values"]}

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-contract-result-size")
	if err := queue.SyncContracts(ctx, map[string]workhorse.TaskTypeContracts{
		"result.limited": {
			CurrentVersion: "current",
			Versions: map[string]workhorse.TaskContractVersion{
				"current": {PayloadSchema: map[string]any{}, ResultSchema: map[string]any{}, MaxResultBytes: limit},
			},
		},
	}); err != nil {
		t.Fatal(err)
	}
	taskID, err := queue.Enqueue(ctx, "result.limited", map[string]any{}, workhorse.EnqueueOptions{
		MaxAttempts: 2,
		RetryPolicy: map[string]any{"type": "fixed", "delayMs": 25},
	})
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-contract-result-size", WorkerID: "go-contract-result-size", LeaseDuration: 5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	invocations := 0
	worker.Handle("result.limited", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		invocations++
		if invocations == 1 {
			return overLimit, nil
		}
		return atLimit, nil
	})

	processed, err := worker.RunOnce(ctx)
	if err != nil || !processed {
		t.Fatalf("first attempt: processed=%t err=%v", processed, err)
	}
	var state string
	var attempt int
	var runAt time.Time
	if err := pool.QueryRow(
		ctx,
		"SELECT state, current_attempt, run_at FROM workhorse.task_runtime WHERE task_id = $1::uuid",
		taskID,
	).Scan(&state, &attempt, &runAt); err != nil {
		t.Fatal(err)
	}
	if state != "scheduled" || attempt != 2 {
		t.Fatalf("the oversized result did not schedule a retry: state=%s attempt=%d", state, attempt)
	}
	if calls := tracer.count(completeStatementFragment); calls != 0 {
		t.Fatalf("the oversized result reached complete_v1 %d times", calls)
	}
	if wait := time.Until(runAt.Add(10 * time.Millisecond)); wait > 0 {
		time.Sleep(wait)
	}

	processed, err = worker.RunOnce(ctx)
	if err != nil || !processed {
		t.Fatalf("second attempt: processed=%t err=%v", processed, err)
	}
	if state, _ := taskOutcomeError(t, pool, taskID); state != "succeeded" {
		t.Fatalf("a result at the limit settled as %s", state)
	}
}

// statementArgumentTracer records each statement with its arguments, so a test can tell which
// tasks a batch statement named.
type statementArgumentTracer struct {
	mu         sync.Mutex
	statements []recordedStatement
}

type recordedStatement struct {
	sql  string
	args []any
}

func (tracer *statementArgumentTracer) TraceQueryStart(
	ctx context.Context,
	_ *pgx.Conn,
	data pgx.TraceQueryStartData,
) context.Context {
	tracer.mu.Lock()
	tracer.statements = append(tracer.statements, recordedStatement{sql: data.SQL, args: data.Args})
	tracer.mu.Unlock()
	return ctx
}

func (*statementArgumentTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func (tracer *statementArgumentTracer) matching(fragment string) []recordedStatement {
	tracer.mu.Lock()
	defer tracer.mu.Unlock()
	var matched []recordedStatement
	for _, statement := range tracer.statements {
		if strings.Contains(statement.sql, fragment) {
			matched = append(matched, statement)
		}
	}
	return matched
}

// A fast-tier completion batch settles each member on its own. An oversized result fails only its
// own task and never joins the batch statement: the worker rejects it first and settles it through
// fail_v1, rather than leaving the refusal to the batch statement's own size check.
func TestFastWorkerFailsOnlyTheOversizedMemberOfABatch(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "fast-oversized-result")
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	tracer := &statementArgumentTracer{}
	config.ConnConfig.Tracer = tracer
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	ctx := context.Background()
	makeFastQueue(t, pool, "go-fast-oversized")
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-fast-oversized")
	requests := fastRequests("go-fast-oversized", "sized", 8)
	for index := range requests {
		requests[index].Options.MaxAttempts = 1
	}
	taskIDs, err := queue.EnqueueMany(ctx, requests)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-fast-oversized", WorkerID: "go-fast-oversized", Concurrency: 4,
		LeaseDuration: 5 * time.Second, PollInterval: 5 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	const oversizedSequence = 3
	worker.Handle("sized", func(_ context.Context, payload any, _ *workhorse.HandlerContext) (any, error) {
		sequence := int(payload.(map[string]any)["sequence"].(float64))
		if sequence == oversizedSequence {
			return strings.Repeat("x", 1<<20), nil
		}
		return map[string]any{"sequence": sequence}, nil
	})

	runFastWorkerUntil(t, pool, worker, taskIDs)

	admin := workhorse.NewAdmin(workhorse.NewPGXExecutor(pool))
	for sequence, taskID := range taskIDs {
		snapshot, err := admin.GetTask(ctx, taskID)
		if err != nil {
			t.Fatal(err)
		}
		if snapshot == nil {
			t.Fatalf("fast task %d has no snapshot", sequence)
		}
		if sequence != oversizedSequence {
			if snapshot.State != "succeeded" {
				t.Fatalf("unrelated fast task %d settled as %s", sequence, snapshot.State)
			}
			continue
		}
		failure, _ := snapshot.Error.(map[string]any)
		if snapshot.State != "failed" || failure["name"] != "TaskValueSizeLimitError" {
			t.Fatalf("oversized fast task settled as state=%s error=%#v", snapshot.State, snapshot.Error)
		}
	}

	oversizedID := taskIDs[oversizedSequence]
	batched := 0
	for _, statement := range tracer.matching("workhorse.complete_many_and_claim_v1(") {
		ids, _ := statement.args[1].([]string)
		batched += len(ids)
		if slices.Contains(ids, oversizedID) {
			t.Fatalf("the oversized task joined a completion batch: %v", ids)
		}
	}
	if batched == 0 {
		t.Fatal("no valid member completed through a completion batch")
	}
	failures := 0
	for _, statement := range tracer.matching("workhorse.fail_v1(") {
		if statement.args[0] == oversizedID {
			failures++
		}
	}
	if failures != 1 {
		t.Fatalf("the worker sent fail_v1 for the oversized task %d times, want 1", failures)
	}
}
