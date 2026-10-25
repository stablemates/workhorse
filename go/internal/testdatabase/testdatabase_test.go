package testdatabase

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/url"
	"os"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const databaseURL = "postgres://workhorse:workhorse@localhost:5432/workhorse_test"

// recorder is a testing.TB that records the first Fatal or Skip and stops the goroutine, as the
// testing package does.
type recorder struct {
	testing.TB
	outcome string
	message string
}

func (r *recorder) Helper() {}

func (r *recorder) Fatal(arguments ...any) { r.stop("fail", arguments) }

func (r *recorder) Skip(arguments ...any) { r.stop("skip", arguments) }

func (r *recorder) stop(outcome string, arguments []any) {
	r.outcome = outcome
	for _, argument := range arguments {
		if text, ok := argument.(string); ok {
			r.message += text
		}
	}
	runtime.Goexit()
}

func resolve(short bool, environment map[string]string) (string, *recorder) {
	result := &recorder{}
	source := make(chan string, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		source <- sourceURL(result, short, func(key string) string { return environment[key] })
	}()
	<-done
	select {
	case value := <-source:
		return value, result
	default:
		return "", result
	}
}

func TestRequiredRunFailsWithoutDatabaseURL(t *testing.T) {
	for _, environment := range []map[string]string{
		{"CI": "true"},
		{"CI": "true", "DATABASE_URL_TEST": ""},
		{"WORKHORSE_REQUIRE_DATABASE": "1"},
		{"WORKHORSE_REQUIRE_DATABASE": "1", "DATABASE_URL_TEST": ""},
		{"CI": "yes"},
		{"WORKHORSE_REQUIRE_DATABASE": "yes"},
		{"CI": "true", "WORKHORSE_REQUIRE_DATABASE": "0"},
		{"CI": "false", "WORKHORSE_REQUIRE_DATABASE": "1"},
	} {
		_, result := resolve(false, environment)
		if result.outcome != "fail" || !strings.Contains(result.message, "requires PostgreSQL") {
			t.Fatalf("environment %v: outcome %q %q, want a failure", environment, result.outcome, result.message)
		}
	}
}

func TestOptionalRunSkipsWithoutDatabaseURL(t *testing.T) {
	for _, environment := range []map[string]string{
		{},
		{"DATABASE_URL_TEST": ""},
		{"CI": "", "WORKHORSE_REQUIRE_DATABASE": "0"},
		{"CI": "false", "WORKHORSE_REQUIRE_DATABASE": "false"},
	} {
		_, result := resolve(false, environment)
		if result.outcome != "skip" {
			t.Fatalf("environment %v: outcome %q %q, want a skip", environment, result.outcome, result.message)
		}
	}
}

func TestShortRunSkipsEvenWhenRequired(t *testing.T) {
	for _, environment := range []map[string]string{
		{"CI": "true"},
		{"WORKHORSE_REQUIRE_DATABASE": "1", "DATABASE_URL_TEST": databaseURL},
	} {
		value, result := resolve(true, environment)
		if result.outcome != "skip" || value != "" {
			t.Fatalf("environment %v: outcome %q, value %q, want a skip", environment, result.outcome, value)
		}
	}
}

func TestDatabaseURLIsReturnedWhenSet(t *testing.T) {
	for _, environment := range []map[string]string{
		{"DATABASE_URL_TEST": databaseURL},
		{"CI": "true", "DATABASE_URL_TEST": databaseURL},
	} {
		value, result := resolve(false, environment)
		if result.outcome != "" || value != databaseURL {
			t.Fatalf("environment %v: outcome %q, value %q, want the URL", environment, result.outcome, value)
		}
	}
}

// A host I/O stall can make a WAL flush take seconds, so a commit in a test does not wait for it
// (SM-1809). A new session of a database that Create makes takes the setting.
func TestCreateCommitsWithoutWaitingForTheWalFlush(t *testing.T) {
	parsed, err := url.Parse(SourceURL(t))
	if err != nil {
		t.Fatal(err)
	}
	sourceName := strings.TrimPrefix(parsed.Path, "/")
	if !strings.Contains(sourceName, "test") {
		t.Fatal("DATABASE_URL_TEST must name a test database")
	}
	digest := fmt.Sprintf("%x", sha256.Sum256([]byte(t.Name()+strconv.Itoa(os.Getpid()))))[:10]
	databaseName := sourceName[:min(len(sourceName), 44)] + "_go_" + digest
	adminURL := *parsed
	adminURL.Path = "/postgres"
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, err := pgx.Connect(ctx, adminURL.String())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = admin.Close(ctx) }()
	drop := func() error {
		statement := "DROP DATABASE IF EXISTS " + pgx.Identifier{databaseName}.Sanitize()
		for attempt := 1; ; attempt++ {
			_, err := admin.Exec(ctx, statement)
			var databaseError *pgconn.PgError
			if err == nil || !errors.As(err, &databaseError) || databaseError.Code != "55006" || attempt >= 10 {
				return err
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
	if err := drop(); err != nil {
		t.Fatal(err)
	}
	if err := Create(ctx, admin, databaseName); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := drop(); err != nil {
			t.Errorf("drop %s: %v; run pnpm db:sweep", databaseName, err)
		}
	}()

	databaseURL := *parsed
	databaseURL.Path = "/" + databaseName
	connection, err := pgx.Connect(ctx, databaseURL.String())
	if err != nil {
		t.Fatal(err)
	}
	var commit string
	err = connection.QueryRow(ctx, "SHOW synchronous_commit").Scan(&commit)
	_ = connection.Close(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if commit != "off" {
		t.Fatalf("the scratch database has synchronous_commit %q; want off", commit)
	}
}
