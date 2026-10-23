package testdatabase

import (
	"runtime"
	"strings"
	"testing"
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
