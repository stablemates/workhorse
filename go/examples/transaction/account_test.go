package main

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

// A rejected enqueue must take the account row down with it. A contract rejection is a client-side
// error that leaves the transaction usable, so committing anyway would keep the account and lose
// the task.
func TestCreateAccountRollsBackWhenEnqueueFails(t *testing.T) {
	if testing.Short() {
		t.Skip("integration test")
	}
	sourceURL := os.Getenv("DATABASE_URL_TEST")
	if sourceURL == "" {
		t.Skip("DATABASE_URL_TEST is not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, createTransactionDatabase(t, sourceURL))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx, "CREATE TABLE account (id text PRIMARY KEY, email text NOT NULL)"); err != nil {
		t.Fatal(err)
	}
	contracts := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "default")
	if err := contracts.SyncContracts(ctx, map[string]workhorse.TaskTypeContracts{
		"account.created": {CurrentVersion: "1", Versions: map[string]workhorse.TaskContractVersion{
			"1": {PayloadSchema: map[string]any{
				"type":       "object",
				"required":   []any{"accountId"},
				"properties": map[string]any{"accountId": map[string]any{"type": "string", "pattern": "^acct_"}},
			}},
		}},
	}); err != nil {
		t.Fatal(err)
	}

	err = createAccount(ctx, pool, "user-1", "person@example.com")
	var rejected *workhorse.TaskContractValidationError
	if !errors.As(err, &rejected) {
		t.Fatalf("createAccount error = %v, want a contract rejection", err)
	}
	var accounts, tasks int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM account").Scan(&accounts); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM workhorse.task").Scan(&tasks); err != nil {
		t.Fatal(err)
	}
	if accounts != 0 || tasks != 0 {
		t.Fatalf("after a rejected enqueue: %d accounts and %d tasks committed, want none", accounts, tasks)
	}

	if err := createAccount(ctx, pool, "acct_1", "person@example.com"); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM account").Scan(&accounts); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM workhorse.task").Scan(&tasks); err != nil {
		t.Fatal(err)
	}
	if accounts != 1 || tasks != 1 {
		t.Fatalf("after an accepted enqueue: %d accounts and %d tasks, want one of each", accounts, tasks)
	}
}

// createTransactionDatabase gives the test its own database so it never touches the checkout's
// shared test database.
func createTransactionDatabase(t *testing.T, sourceURL string) string {
	t.Helper()
	parsed, err := url.Parse(sourceURL)
	if err != nil {
		t.Fatal(err)
	}
	host := parsed.Hostname()
	if host != "localhost" && host != "127.0.0.1" && host != "::1" {
		t.Fatalf("transaction example tests refuse non-loopback database host %q", host)
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
	databaseName := prefix + "_gt_" + digest

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
			t.Errorf("drop transaction example database: %v", err)
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
