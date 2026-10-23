// Package testdatabase decides whether a PostgreSQL test runs, skips, or fails.
//
// A local run without DATABASE_URL_TEST skips the database tests. CI, or
// WORKHORSE_REQUIRE_DATABASE=1, turns that skip into a failure, so a CI job that loses its database
// URL cannot report a pass. A short run (go test -short) skips every database test and does not
// read the URL. The Rust, Ruby, JVM, and Python test helpers use the same rule. The .NET helper
// reads the two variables in a different way.
package testdatabase

import (
	"os"
	"testing"
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
