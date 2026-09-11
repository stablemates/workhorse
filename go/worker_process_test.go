package workhorse_test

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

func TestWorkerProcessDrainsAnInflightTaskOnSIGTERM(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-process-drain")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	createProcessFixtureTables(t, ctx, pool)
	if _, err := pool.Exec(ctx, "INSERT INTO process_fixture_control(name, released) VALUES ('drain', false)"); err != nil {
		t.Fatal(err)
	}

	queueName := "go-worker-process-drain"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	firstTaskID, err := queue.Enqueue(ctx, "process.fixture", map[string]any{"sequence": 1}, workhorse.EnqueueOptions{Priority: 100})
	if err != nil {
		t.Fatal(err)
	}
	secondTaskID, err := queue.Enqueue(ctx, "process.fixture", map[string]any{"sequence": 2})
	if err != nil {
		t.Fatal(err)
	}

	binary := buildProcessWorker(t)
	process, done, output := startProcessWorker(t, binary, databaseURL, queueName, "drain", "process-drain-worker")
	waitForProcessInvocations(t, ctx, pool, firstTaskID, 1)
	if err := process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		t.Fatalf("worker exited before its handler drained: %v\n%s", err, output.String())
	case <-time.After(75 * time.Millisecond):
	}
	if _, err := pool.Exec(ctx, "UPDATE process_fixture_control SET released = true WHERE name = 'drain'"); err != nil {
		t.Fatal(err)
	}
	if err := waitForProcessExit(t, done, output); err != nil {
		t.Fatalf("worker did not exit cleanly after SIGTERM: %v\n%s", err, output.String())
	}

	var firstState, secondState string
	if err := pool.QueryRow(ctx, "SELECT state FROM workhorse.task_outcome WHERE task_id = $1::uuid", firstTaskID).Scan(&firstState); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "SELECT state FROM workhorse.task_runtime WHERE task_id = $1::uuid", secondTaskID).Scan(&secondState); err != nil {
		t.Fatal(err)
	}
	if firstState != "succeeded" || secondState != "ready" {
		t.Fatalf("unexpected drain states: first=%s second=%s", firstState, secondState)
	}
}

func TestKilledWorkerLeaseIsRecoveredByASecondProcess(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-process-crash")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	createProcessFixtureTables(t, ctx, pool)

	queueName := "go-worker-process-crash"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskID, err := queue.Enqueue(ctx, "process.fixture", map[string]any{"source": "crashed"}, workhorse.EnqueueOptions{
		MaxAttempts: 2,
		RetryPolicy: map[string]any{"type": "fixed", "delayMs": 0},
	})
	if err != nil {
		t.Fatal(err)
	}

	binary := buildProcessWorker(t)
	process, done, output := startProcessWorker(t, binary, databaseURL, queueName, "crash", "process-crash-worker")
	waitForProcessInvocations(t, ctx, pool, taskID, 1)
	if err := process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := waitForProcessExit(t, done, output); err == nil {
		t.Fatal("SIGKILL worker exited successfully")
	}
	waitForProcessLeaseExpiration(t, ctx, pool, taskID)

	_, recoveryDone, recoveryOutput := startProcessWorker(t, binary, databaseURL, queueName, "recover", "process-recovery-worker")
	if err := waitForProcessExit(t, recoveryDone, recoveryOutput); err != nil {
		t.Fatalf("recovery worker failed: %v\n%s", err, recoveryOutput.String())
	}

	var state string
	var attempt, invocations int
	var resultSource string
	if err := pool.QueryRow(ctx, `SELECT state, current_attempt, result->'payload'->>'source'
		FROM workhorse.task_outcome WHERE task_id = $1::uuid`, taskID).Scan(&state, &attempt, &resultSource); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM process_fixture_invocation WHERE task_id = $1::uuid", taskID).Scan(&invocations); err != nil {
		t.Fatal(err)
	}
	if state != "succeeded" || attempt != 2 || invocations != 2 || resultSource != "crashed" {
		t.Fatalf("unexpected recovery outcome: state=%s attempt=%d invocations=%d source=%s", state, attempt, invocations, resultSource)
	}
}

func TestWorkerRecoversHandlerPanicAndContinues(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-handler-panic")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queueName := "go-worker-handler-panic"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	panicTaskID, err := queue.Enqueue(ctx, "process.panic", map[string]any{"kind": "panic"}, workhorse.EnqueueOptions{Priority: 100, MaxAttempts: 1})
	if err != nil {
		t.Fatal(err)
	}
	followingTaskID, err := queue.Enqueue(ctx, "process.panic", map[string]any{"kind": "following"})
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: queueName, WorkerID: "panic-worker", PollInterval: 5 * time.Millisecond, PollingOnly: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	runContext, stop := context.WithCancel(ctx)
	worker.Handle("process.panic", func(_ context.Context, payload any, _ *workhorse.HandlerContext) (any, error) {
		if payload.(map[string]any)["kind"] == "panic" {
			panic("provider exploded")
		}
		stop()
		return map[string]any{"continued": true}, nil
	})
	if err := worker.Run(runContext); err != nil {
		t.Fatal(err)
	}

	var panicState, panicMessage, followingState string
	if err := pool.QueryRow(ctx, "SELECT state, error->>'message' FROM workhorse.task_outcome WHERE task_id = $1::uuid", panicTaskID).Scan(&panicState, &panicMessage); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "SELECT state FROM workhorse.task_outcome WHERE task_id = $1::uuid", followingTaskID).Scan(&followingState); err != nil {
		t.Fatal(err)
	}
	if panicState != "failed" || !strings.Contains(panicMessage, "provider exploded") || followingState != "succeeded" {
		t.Fatalf("unexpected panic outcomes: panic=%s message=%q following=%s", panicState, panicMessage, followingState)
	}
}

func buildProcessWorker(t *testing.T) string {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "process-worker")
	command := exec.Command("go", "build", "-o", binary, "./testdata/process-worker")
	command.Env = append(os.Environ(), "GOWORK=off")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("build process worker: %v\n%s", err, output)
	}
	return binary
}

func startProcessWorker(t *testing.T, binary string, arguments ...string) (*os.Process, <-chan error, *bytes.Buffer) {
	t.Helper()
	command := exec.Command(binary, arguments...)
	output := &bytes.Buffer{}
	command.Stdout = output
	command.Stderr = output
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	t.Cleanup(func() { _ = command.Process.Kill() })
	return command.Process, done, output
}

func waitForProcessExit(t *testing.T, done <-chan error, output *bytes.Buffer) error {
	t.Helper()
	select {
	case err := <-done:
		return err
	case <-time.After(5 * time.Second):
		t.Fatalf("process did not exit\n%s", output.String())
		return errors.New("process did not exit")
	}
}

func createProcessFixtureTables(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	if _, err := pool.Exec(ctx, `CREATE TABLE process_fixture_invocation (
		task_id uuid NOT NULL,
		worker_id text NOT NULL,
		attempt integer NOT NULL,
		PRIMARY KEY (task_id, worker_id, attempt)
	); CREATE TABLE process_fixture_control (name text PRIMARY KEY, released boolean NOT NULL)`); err != nil {
		t.Fatal(err)
	}
}

func waitForProcessInvocations(t *testing.T, ctx context.Context, pool *pgxpool.Pool, taskID string, expected int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var count int
		if err := pool.QueryRow(ctx, "SELECT count(*) FROM process_fixture_invocation WHERE task_id = $1::uuid", taskID).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count >= expected {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("task %s did not reach %d process invocations", taskID, expected)
}

func waitForProcessLeaseExpiration(t *testing.T, ctx context.Context, pool *pgxpool.Pool, taskID string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var expired bool
		if err := pool.QueryRow(ctx, "SELECT expires_at <= clock_timestamp() FROM workhorse.task_runtime WHERE task_id = $1::uuid", taskID).Scan(&expired); err != nil {
			t.Fatal(err)
		}
		if expired {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("task %s lease did not expire", taskID)
}
