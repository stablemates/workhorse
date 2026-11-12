package workhorse_test

import (
	"bufio"
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

// jsonLogRecords returns each JSON record in logs whose event.name is event.
func jsonLogRecords(t *testing.T, logs string, event string) []map[string]any {
	t.Helper()
	var records []map[string]any
	scanner := bufio.NewScanner(strings.NewReader(logs))
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		var record map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &record); err != nil {
			t.Fatalf("a log line is not JSON: %v: %s", err, scanner.Text())
		}
		if record["event.name"] == event {
			records = append(records, record)
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	return records
}

// SM-2013: the Go worker logged a failed expiry request without event.name and error.type, so an
// alert on workhorse.worker.expiration_request_failed did not see it. The first expire_owned
// request fails with lock_not_available, as in the shared fixture
// deadline-settles-after-a-failed-expiry-request.
func TestWorkerLogsTheEventOfAFailedExpiryRequest(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-expiry-request-log")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	for _, statement := range []string{
		`CREATE SEQUENCE workhorse.test_expiry_calls`,
		`DO $copy$ BEGIN EXECUTE replace(
			pg_get_functiondef('workhorse.expire_owned_telemetry_v1(uuid,text,bigint)'::regprocedure),
			'FUNCTION workhorse.expire_owned_telemetry_v1(',
			'FUNCTION workhorse.test_original_expire_owned_telemetry_v1('); END $copy$`,
		`CREATE OR REPLACE FUNCTION workhorse.expire_owned_telemetry_v1(
			p_task_id uuid, p_worker_id text, p_fence_token bigint)
			RETURNS TABLE (status text, retry_state text) LANGUAGE plpgsql AS $body$
			BEGIN
				IF nextval('workhorse.test_expiry_calls') = 1 THEN
					RAISE EXCEPTION 'injected expiry request failure' USING ERRCODE = '55P03';
				END IF;
				RETURN QUERY SELECT * FROM workhorse.test_original_expire_owned_telemetry_v1(
					p_task_id, p_worker_id, p_fence_token);
			END $body$`,
	} {
		if _, err := pool.Exec(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	queueName := "go-expiry-request-log"
	deadline := time.Now().Add(300 * time.Millisecond)
	taskID, err := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName).Enqueue(
		ctx, "deadline", nil, workhorse.EnqueueOptions{MaxAttempts: 1, Deadline: &deadline},
	)
	if err != nil {
		t.Fatal(err)
	}
	var logs lockedBuffer
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: queueName, PollingOnly: true,
		Logger: slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})),
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("deadline", func(handlerContext context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		<-handlerContext.Done()
		return nil, context.Cause(handlerContext)
	})
	runContext, cancel := context.WithTimeout(ctx, workerRunDeadline)
	defer cancel()
	if processed, err := worker.RunOnce(runContext); !processed || err != nil {
		t.Fatalf("RunOnce returned %t, %v", processed, err)
	}
	var state, errorName string
	if err := pool.QueryRow(ctx, `SELECT state, coalesce(error->>'name', '') FROM workhorse.task_outcome
		WHERE task_id = $1::uuid`, taskID).Scan(&state, &errorName); err != nil {
		t.Fatal(err)
	}
	if state != "failed" || errorName != "DeadlineExceeded" {
		t.Fatalf("the task is %s with %q, want failed with DeadlineExceeded", state, errorName)
	}
	records := jsonLogRecords(t, logs.String(), "workhorse.worker.expiration_request_failed")
	if len(records) != 1 {
		t.Fatalf("got %d expiry request failure records, want 1: %s", len(records), logs.String())
	}
	record := records[0]
	for key, want := range map[string]any{
		"level":                "WARN",
		"workhorse.task.id":    taskID,
		"workhorse.queue.name": queueName,
		"workhorse.worker.id":  queueName,
	} {
		if record[key] != want {
			t.Errorf("%s is %v, want %v: %v", key, record[key], want, record)
		}
	}
	if errorType, _ := record["error.type"].(string); errorType == "" {
		t.Errorf("the record has no error.type: %v", record)
	}
}

// SM-2016: a handler can catch the suspension of a durable call and return. The task still
// suspends. The other five SDKs then emit workhorse.handler.signal_swallowed, and the Go worker
// emitted nothing. A handler that returns the suspension error does not swallow it.
func TestWorkerWarnsWhenAHandlerSwallowsItsSuspension(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-signal-swallowed")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	for _, test := range []struct {
		name     string
		swallows bool
	}{
		{name: "swallows", swallows: true},
		{name: "returns-the-suspension", swallows: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			queueName := "go-signal-swallowed-" + test.name
			taskID, err := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName).Enqueue(
				ctx, "sleeping", nil, workhorse.EnqueueOptions{},
			)
			if err != nil {
				t.Fatal(err)
			}
			var logs lockedBuffer
			worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
				Queue: queueName, WorkerID: queueName, PollingOnly: true,
				Logger: slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})),
			})
			if err != nil {
				t.Fatal(err)
			}
			worker.Handle("sleeping", func(_ context.Context, _ any, durability *workhorse.HandlerContext) (any, error) {
				err := durability.Sleep("pause", time.Hour)
				if test.swallows {
					return "caught", nil
				}
				return nil, err
			})
			runContext, cancel := context.WithTimeout(ctx, workerRunDeadline)
			defer cancel()
			if processed, err := worker.RunOnce(runContext); !processed || err != nil {
				t.Fatalf("RunOnce returned %t, %v", processed, err)
			}
			var state string
			if err := pool.QueryRow(ctx, `SELECT state FROM workhorse.task_runtime WHERE task_id = $1::uuid`,
				taskID).Scan(&state); err != nil {
				t.Fatal(err)
			}
			if state != "scheduled" {
				t.Fatalf("the task is %s, want scheduled", state)
			}
			records := jsonLogRecords(t, logs.String(), "workhorse.handler.signal_swallowed")
			if !test.swallows {
				if len(records) != 0 {
					t.Fatalf("got %d signal_swallowed records, want 0: %v", len(records), records)
				}
				return
			}
			if len(records) != 1 {
				t.Fatalf("got %d signal_swallowed records, want 1: %s", len(records), logs.String())
			}
			for key, want := range map[string]any{
				"level":                     "WARN",
				"workhorse.handler.outcome": "suspended",
				"workhorse.task.id":         taskID,
				"workhorse.queue.name":      queueName,
				"workhorse.worker.id":       queueName,
			} {
				if records[0][key] != want {
					t.Errorf("%s is %v, want %v: %v", key, records[0][key], want, records[0])
				}
			}
		})
	}
}
