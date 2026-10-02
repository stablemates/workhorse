package workhorse_test

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

const unstorableResultMessage = "result.unstorable result contains a NUL character or an unpaired surrogate," +
	" which PostgreSQL jsonb cannot store"

// unstorableResults are handler results whose JSON jsonb refuses. encoding/json writes NUL as
// \u0000; a surrogate escape can only come from raw JSON.
var unstorableResults = []any{
	"\x00",
	map[string]any{"items": []any{"ok", map[string]any{"note": "a\x00b"}}},
	map[string]any{"k\x00": 1},
	json.RawMessage(`{"s":"\ud800"}`),
}

// The worker's escape scan must agree with PostgreSQL's ::jsonb cast on each document.
func TestUnstorableEscapesMatchPostgreSQL(t *testing.T) {
	pool := fastTierPool(t, "unstorable-escapes")
	documents := []string{
		`"\u0000"`, `{"items":["ok",{"note":"a\u0000b"}]}`, `{"k\u0000":1}`,
		`"\ud800"`, `"\udc00"`, `[1,["\ud83dx"]]`, `{"\udfff":true}`, `"\ude00\ud83d"`,
		`"\ud83d\\ude00"`, `"\ud83d\n"`, `["\ud83d","\ude00"]`, `{"\ud83d":"\ude00"}`,
		`"\ud83d\ude00"`, `"\uD83D\uDE00"`, `{"\ud83d\ude00":"\uD83D\uDE00"}`, `"😀"`,
		`"\uD800"`, `"\uDC00x"`, `"\u003c\u003e\u0026"`, `"\u00e9\u00E9"`,
		`"\\u0000"`, `{"\\ud800":"\\\\ud800"}`, `"\\\u0001"`, `"\u0001\u001f "`,
		`"é�"`, `"🙂"`, `"plain"`, `{"a":[1,true,null]}`,
	}
	for _, document := range documents {
		if !json.Valid([]byte(document)) {
			t.Fatalf("test document %s is not valid JSON", document)
		}
		_, castErr := pool.Exec(context.Background(), "SELECT $1::text::jsonb", document)
		if refused := workhorse.HasUnstorableEscapeForTest([]byte(document)); refused != (castErr != nil) {
			t.Errorf("scan refuses %s: %t; PostgreSQL cast error: %v", document, refused, castErr)
		}
	}
}

// An unstorable result used to reach the completion statement, whose refusal ended Run and left the
// task leased. The worker now fails the attempt itself under the task's retry policy. On the fast
// tier the bad members never join a completion batch, and the good member still completes.
func TestWorkerFailsAnUnstorableResultUnderItsRetryPolicyAndKeepsRunning(t *testing.T) {
	for _, fast := range []bool{false, true} {
		tier := "full"
		if fast {
			tier = "fast"
		}
		t.Run(tier, func(t *testing.T) {
			queueName := "go-unstorable-" + tier
			databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "unstorable-result-"+tier)
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
			if fast {
				makeFastQueue(t, pool, queueName)
			}

			// The last request is the valid one. One claim takes every request, so on the fast tier
			// the valid completion is a batch member beside the failures.
			requests := fastRequests(queueName, "result.unstorable", len(unstorableResults)+1)
			for index := range requests {
				requests[index].Options.MaxAttempts = 2
				requests[index].Options.RetryPolicy = map[string]any{"type": "fixed", "delayMs": 0}
			}
			queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
			taskIDs, err := queue.EnqueueMany(ctx, requests)
			if err != nil {
				t.Fatal(err)
			}
			validID := taskIDs[len(unstorableResults)]

			worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
				Queue: queueName, WorkerID: queueName, Concurrency: len(requests),
				LeaseDuration: 5 * time.Second, PollInterval: 5 * time.Millisecond,
			})
			if err != nil {
				t.Fatal(err)
			}
			worker.Handle("result.unstorable", func(_ context.Context, payload any, _ *workhorse.HandlerContext) (any, error) {
				sequence := int(payload.(map[string]any)["sequence"].(float64))
				if sequence < len(unstorableResults) {
					return unstorableResults[sequence], nil
				}
				return map[string]any{"ok": true}, nil
			})

			runContext, stop := context.WithCancel(ctx)
			defer stop()
			result := make(chan error, 1)
			go func() { result <- worker.Run(runContext) }()
			outcomes := waitForTierOutcomes(t, pool, fast, taskIDs, result)
			stop()
			if err := <-result; err != nil {
				t.Fatalf("Run returned %v", err)
			}

			for sequence, taskID := range taskIDs {
				outcome := outcomes[taskID]
				if taskID == validID {
					if outcome != (tierOutcome{state: "succeeded", attempt: 1}) {
						t.Fatalf("valid task settled as %+v", outcome)
					}
					continue
				}
				want := tierOutcome{
					state: "failed", attempt: 2, errorName: "Error", errorMessage: unstorableResultMessage,
				}
				if outcome != want {
					t.Fatalf("unstorable result %d settled as %+v, want %+v", sequence, outcome, want)
				}
			}

			completion := "workhorse.complete_v1("
			if fast {
				completion = "workhorse.complete_many_and_claim_v1("
			}
			completed := 0
			for _, statement := range tracer.matching(completion) {
				for _, taskID := range taskIDs {
					if !statementNamesTask(statement, taskID) {
						continue
					}
					if taskID != validID {
						t.Fatalf("unstorable task %s reached %s", taskID, completion)
					}
					completed++
				}
			}
			if completed != 1 {
				t.Fatalf("the valid task reached %s %d times, want 1", completion, completed)
			}
		})
	}
}

type tierOutcome struct {
	state        string
	attempt      int
	errorName    string
	errorMessage string
}

// waitForTierOutcomes returns each task's terminal outcome once every task has one. It fails the
// test if Run stops first.
func waitForTierOutcomes(
	t *testing.T,
	pool *pgxpool.Pool,
	fast bool,
	taskIDs []string,
	result <-chan error,
) map[string]tierOutcome {
	t.Helper()
	table, attempt := "task_outcome", "current_attempt"
	if fast {
		table, attempt = "fast_task_outcome", "attempt"
	}
	query := fmt.Sprintf(
		`SELECT task_id::text, state, %s, coalesce(error->>'name', ''), coalesce(error->>'message', '')
		   FROM workhorse.%s WHERE task_id = ANY($1::uuid[])`,
		attempt, table,
	)
	deadline := time.Now().Add(20 * time.Second)
	for {
		rows, err := pool.Query(context.Background(), query, taskIDs)
		if err != nil {
			t.Fatal(err)
		}
		outcomes := map[string]tierOutcome{}
		for rows.Next() {
			var taskID string
			var outcome tierOutcome
			if err := rows.Scan(
				&taskID, &outcome.state, &outcome.attempt, &outcome.errorName, &outcome.errorMessage,
			); err != nil {
				t.Fatal(err)
			}
			outcomes[taskID] = outcome
		}
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		if len(outcomes) == len(taskIDs) {
			return outcomes
		}
		select {
		case err := <-result:
			t.Fatalf("Run stopped before every task settled: %v", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("only %d of %d tasks settled in time", len(outcomes), len(taskIDs))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func statementNamesTask(statement recordedStatement, taskID string) bool {
	for _, argument := range statement.args {
		switch typed := argument.(type) {
		case string:
			if typed == taskID {
				return true
			}
		case []string:
			if slices.Contains(typed, taskID) {
				return true
			}
		}
	}
	return false
}
