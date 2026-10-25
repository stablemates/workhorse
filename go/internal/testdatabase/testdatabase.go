// Package testdatabase decides whether a PostgreSQL test runs, skips, or fails.
//
// A local run without DATABASE_URL_TEST skips the database tests. CI, or
// WORKHORSE_REQUIRE_DATABASE=1, turns that skip into a failure, so a CI job that loses its database
// URL cannot report a pass. A short run (go test -short) skips every database test and does not
// read the URL. The Rust, Ruby, JVM, and Python test helpers use the same rule. The .NET helper
// reads the two variables in a different way.
//
// Create makes the scratch databases of the Go tests, so each one commits without a wait for the
// WAL flush, and holds the lease that keeps pnpm db:sweep from dropping it.
package testdatabase

import (
	"context"
	"fmt"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// SourceURL returns DATABASE_URL_TEST for a PostgreSQL test, or skips or fails the test.
func SourceURL(t testing.TB) string {
	t.Helper()
	return sourceURL(t, testing.Short(), os.Getenv)
}

// required reports whether CI or WORKHORSE_REQUIRE_DATABASE has a value other than off.
func required(getenv func(string) string) bool {
	return set(getenv("CI")) || set(getenv("WORKHORSE_REQUIRE_DATABASE"))
}

func sourceURL(t testing.TB, short bool, getenv func(string) string) string {
	t.Helper()
	if short {
		t.Skip("PostgreSQL tests do not run in short mode")
	}
	source := getenv("DATABASE_URL_TEST")
	if source != "" {
		return source
	}
	if required(getenv) {
		t.Fatal("DATABASE_URL_TEST is unset, but this run requires PostgreSQL (CI or WORKHORSE_REQUIRE_DATABASE=1)")
	}
	t.Skip("DATABASE_URL_TEST is required for PostgreSQL tests")
	return ""
}

func set(value string) bool {
	return value != "" && value != "0" && value != "false"
}

// Executor is the part of *pgx.Conn that Create uses.
type Executor interface {
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
}

// LeaseStatement takes the lease of a scratch database on a session of the postgres database.
//
// A live test can have no session on its scratch database, for example after it closes a pool.
// pnpm db:sweep takes the exclusive lock of the name with no wait before it drops a scratch
// database, so it skips a database under this shared lock. The TypeScript harness holds the same
// lease (SM-1702).
const LeaseStatement = "SELECT pg_advisory_lock_shared(hashtextextended($1, 0))"

// Create creates the empty scratch database name on an admin connection.
//
// Before it creates the database, Create opens a session on adminURL that holds the lease of
// name. A cleanup of t closes that session. The caller registers its drop of the database after
// Create returns, so the session ends after the drop. If the process stops or crashes, PostgreSQL
// ends the session and its lock, and the sweep can drop the database again.
//
// A scratch database is for tests only, so its commits do not wait for the WAL flush. A host I/O
// stall can make one flush take seconds, and a lease of a few seconds then lapses although the
// worker is correct (SM-1809). Visibility and order do not change. Only a server crash can lose
// such a commit, and no Go test restarts PostgreSQL or reads the WAL.
func Create(t testing.TB, ctx context.Context, admin Executor, adminURL string, name string) error {
	t.Helper()
	lease, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		return fmt.Errorf("open the lease session of %s: %w", name, err)
	}
	t.Cleanup(func() { _ = lease.Close(context.Background()) })
	if _, err := lease.Exec(ctx, LeaseStatement, name); err != nil {
		return fmt.Errorf("take the lease of %s: %w", name, err)
	}
	quoted := pgx.Identifier{name}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+quoted); err != nil {
		return err
	}
	if _, err := admin.Exec(ctx, "ALTER DATABASE "+quoted+" SET synchronous_commit = off"); err != nil {
		return fmt.Errorf("let %s commit without a WAL flush wait: %w", name, err)
	}
	return nil
}
