package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

func TestOnlyTheDevelopmentDemoWaitsForTheSchema(t *testing.T) {
	for mode, expected := range map[string]bool{"": false, "production": false, "development": true} {
		t.Setenv("WORKHORSE_DEMO_MODE", mode)
		waits, err := waitsForSchema()
		if err != nil || waits != expected {
			t.Fatalf("mode %q: expected %v, got %v (%v)", mode, expected, waits, err)
		}
	}
	t.Setenv("WORKHORSE_DEMO_MODE", "staging")
	if _, err := waitsForSchema(); err == nil {
		t.Fatal("expected an unknown mode to fail")
	}
}

func TestWorkerWaitsForAMissingSchemaUntilItIsInstalled(t *testing.T) {
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
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if err := waitForSchema(ctx, executor, logger); err != nil {
		t.Fatalf("an installed schema should not wait: %v", err)
	}

	if _, err := pool.Exec(ctx, "DROP SCHEMA workhorse CASCADE"); err != nil {
		t.Fatal(err)
	}
	waited := make(chan error, 1)
	go func() { waited <- waitForSchema(ctx, executor, logger) }()
	select {
	case err := <-waited:
		t.Fatalf("the worker stopped waiting for a missing schema: %v", err)
	case <-time.After(1200 * time.Millisecond):
	}

	schema, err := os.ReadFile(filepath.Join("..", "..", "..", "sql", "schema", "current.sql"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, string(schema)); err != nil {
		t.Fatal(err)
	}
	if err := <-waited; err != nil {
		t.Fatalf("expected the wait to end once the schema exists: %v", err)
	}

	if _, err := pool.Exec(ctx, "DROP SCHEMA workhorse CASCADE"); err != nil {
		t.Fatal(err)
	}
	stopped, stop := context.WithCancel(ctx)
	stop()
	if err := waitForSchema(stopped, executor, logger); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected shutdown to end the wait, got %v", err)
	}
}
