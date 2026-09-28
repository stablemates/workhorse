package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

func TestWorkerCompletesATaskOnItsFastTierQueue(t *testing.T) {
	if testing.Short() {
		t.Skip("PostgreSQL integration tests do not run in short mode")
	}
	sourceURL := os.Getenv("DATABASE_URL_TEST")
	if sourceURL == "" {
		t.Skip("DATABASE_URL_TEST is required for integration tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, createDemoWorkerDatabase(t, sourceURL))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	executor := workhorse.NewPGXExecutor(pool)
	admin := workhorse.NewAdmin(executor)
	audit := workhorse.AdminAudit{
		Actor:     "go-demo-worker-test",
		Reason:    "seed the fast tier",
		RequestID: "go-demo-worker-fast-tier",
	}
	if _, err := admin.SetQueueTier(ctx, goFastQueue, workhorse.QueueTierFast, audit); err != nil {
		t.Fatal(err)
	}
	taskID, err := workhorse.NewQueue(executor, goFastQueue).Enqueue(
		ctx,
		languageTaskType,
		map[string]any{"language": "go"},
		workhorse.EnqueueOptions{Queue: goFastQueue, MaxAttempts: 1},
	)
	if err != nil {
		t.Fatal(err)
	}

	worker, err := newWorker(
		pool,
		50*time.Millisecond,
		"demo-go-fast-tier-test",
		slog.New(slog.NewTextHandler(io.Discard, nil)),
	)
	if err != nil {
		t.Fatal(err)
	}
	runContext, stop := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- worker.Run(runContext) }()

	var state string
	var result []byte
	for {
		err := pool.QueryRow(
			ctx,
			"SELECT state, result FROM workhorse.fast_task_outcome WHERE task_id = $1",
			taskID,
		).Scan(&state, &result)
		if err == nil {
			break
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			stop()
			t.Fatal(err)
		}
		if ctx.Err() != nil {
			stop()
			t.Fatal("worker did not finish the fast-tier task in time")
		}
		time.Sleep(50 * time.Millisecond)
	}
	stop()
	if err := <-done; err != nil && !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}

	var decoded map[string]any
	if err := json.Unmarshal(result, &decoded); err != nil {
		t.Fatal(err)
	}
	if state != "succeeded" || decoded["language"] != "go" || decoded["runtime"] != "go" {
		t.Fatalf("unexpected outcome: %s %s", state, result)
	}
}

// createDemoWorkerDatabase gives the test its own database so it never touches the checkout's
// shared test database.
func createDemoWorkerDatabase(t *testing.T, sourceURL string) string {
	t.Helper()
	parsed, err := url.Parse(sourceURL)
	if err != nil {
		t.Fatal(err)
	}
	host := parsed.Hostname()
	if host != "localhost" && host != "127.0.0.1" && host != "::1" {
		t.Fatalf("demo worker tests refuse non-loopback database host %q", host)
	}
	sourceName := strings.TrimPrefix(parsed.Path, "/")
	if !strings.Contains(sourceName, "test") {
		t.Fatal("DATABASE_URL_TEST must name a test database")
	}
	digest := fmt.Sprintf("%x", sha256.Sum256([]byte(t.Name()+strconv.Itoa(os.Getpid()))))[:10]
	prefix := sourceName
	if len(prefix) > 44 {
		prefix = prefix[:44]
	}
	databaseName := prefix + "_gd_" + digest

	adminURL := *parsed
	adminURL.Path = "/postgres"
	ctx := context.Background()
	quotedName := pgx.Identifier{databaseName}.Sanitize()
	admin, err := pgx.Connect(ctx, adminURL.String())
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{"DROP DATABASE IF EXISTS ", "CREATE DATABASE "} {
		if _, err := admin.Exec(ctx, statement+quotedName); err != nil {
			_ = admin.Close(ctx)
			t.Fatal(err)
		}
	}
	if err := admin.Close(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		admin, err := pgx.Connect(ctx, adminURL.String())
		if err != nil {
			t.Errorf("connect for database cleanup: %v", err)
			return
		}
		defer func() { _ = admin.Close(ctx) }()
		_, _ = admin.Exec(ctx, "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()", databaseName)
		if _, err := admin.Exec(ctx, "DROP DATABASE IF EXISTS "+quotedName); err != nil {
			t.Errorf("drop demo worker database: %v", err)
		}
	})

	databaseURL := *parsed
	databaseURL.Path = "/" + databaseName
	schema, err := os.ReadFile(filepath.Join("..", "..", "..", "sql", "schema", "current.sql"))
	if err != nil {
		t.Fatal(err)
	}
	connection, err := pgx.Connect(ctx, databaseURL.String())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = connection.Close(ctx) }()
	if _, err := connection.Exec(ctx, string(schema)); err != nil {
		t.Fatal(err)
	}
	return databaseURL.String()
}
