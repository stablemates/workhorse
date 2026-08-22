package workhorse_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"

	workhorse "github.com/stablemates/workhorse/go"
)

type compatibilityFixture struct {
	ID                     string  `json:"id"`
	InstalledSchemaVersion *int    `json:"installedSchemaVersion"`
	ClientProtocolVersion  int     `json:"clientProtocolVersion"`
	Compatible             bool    `json:"compatible"`
	RefusalCode            *string `json:"refusalCode"`
}

func TestCompatibilityFixtures(t *testing.T) {
	contents, err := os.ReadFile("../protocol/v1/compatibility.json")
	if err != nil {
		t.Fatal(err)
	}

	var fixtures []compatibilityFixture
	if err := json.Unmarshal(contents, &fixtures); err != nil {
		t.Fatal(err)
	}

	for _, fixture := range fixtures {
		t.Run(fixture.ID, func(t *testing.T) {
			err := workhorse.CheckCompatibility(
				fixture.InstalledSchemaVersion,
				fixture.ClientProtocolVersion,
			)
			if fixture.Compatible {
				if err != nil {
					t.Fatalf("expected compatible versions, got %v", err)
				}
				return
			}

			var compatibilityError *workhorse.CompatibilityError
			if !errors.As(err, &compatibilityError) {
				t.Fatalf("expected CompatibilityError, got %T: %v", err, err)
			}
			if fixture.RefusalCode == nil {
				t.Fatal("incompatible fixture has no refusalCode")
			}
			if got := string(compatibilityError.Code); got != *fixture.RefusalCode {
				t.Fatalf("expected refusal code %q, got %q", *fixture.RefusalCode, got)
			}
		})
	}
}

func TestAssertCompatibleChecksEveryCall(t *testing.T) {
	executor := &recordingExecutor{rows: []workhorse.Row{{"version": int32(1)}}}

	for range 2 {
		if err := workhorse.AssertCompatible(context.Background(), executor); err != nil {
			t.Fatal(err)
		}
	}

	if executor.calls != 2 {
		t.Fatalf("expected two compatibility queries, got %d", executor.calls)
	}
}

func TestCachedCompatibilityCheckQueriesOnce(t *testing.T) {
	executor := &recordingExecutor{rows: []workhorse.Row{{"version": int64(1)}}}
	check := workhorse.NewCachedCompatibilityCheck(executor)

	for range 2 {
		if err := check.Assert(context.Background()); err != nil {
			t.Fatal(err)
		}
	}

	if executor.calls != 1 {
		t.Fatalf("expected one compatibility query, got %d", executor.calls)
	}
}

func TestAssertCompatibleTranslatesMissingSchema(t *testing.T) {
	executor := &recordingExecutor{err: sqlStateError{state: "42P01"}}

	err := workhorse.AssertCompatible(context.Background(), executor)
	var compatibilityError *workhorse.CompatibilityError
	if !errors.As(err, &compatibilityError) {
		t.Fatalf("expected CompatibilityError, got %T: %v", err, err)
	}
	if compatibilityError.Code != workhorse.SchemaNotInstalled {
		t.Fatalf("expected %q, got %q", workhorse.SchemaNotInstalled, compatibilityError.Code)
	}
}

type recordingExecutor struct {
	rows  []workhorse.Row
	err   error
	calls int
}

func (executor *recordingExecutor) Query(context.Context, string, ...any) ([]workhorse.Row, error) {
	executor.calls++
	return executor.rows, executor.err
}

type sqlStateError struct {
	state string
}

func (err sqlStateError) Error() string {
	return err.state
}

func (err sqlStateError) SQLState() string {
	return err.state
}
