package workhorse_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	_ "github.com/jackc/pgx/v5/stdlib"
	workhorse "github.com/stablemates/workhorse/go"
)

type protocolFixtureManifest struct {
	Coverage        []string `json:"coverage"`
	RuntimeCoverage []string `json:"runtimeCoverage"`
}

type protocolScenario struct {
	ID    string         `json:"id"`
	Steps []protocolStep `json:"steps"`
}

type protocolStep struct {
	ID         string                    `json:"id"`
	Covers     []string                  `json:"covers"`
	SQL        string                    `json:"sql"`
	Parameters []any                     `json:"parameters"`
	Expect     protocolExpectation       `json:"expect"`
	Capture    map[string]string         `json:"capture"`
	Error      *protocolErrorExpectation `json:"error"`
}

type protocolExpectation struct {
	Rows []any `json:"rows"`
}

type protocolErrorExpectation struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Detail  any    `json:"detail"`
}

func matchFixtureType(kind string, actual any) error {
	accepted := false
	switch kind {
	case "any":
		accepted = true
	case "uuid":
		value, ok := actual.(string)
		accepted = ok && isUUID(value)
	case "timestamp":
		value, ok := actual.(string)
		if ok {
			_, err := time.Parse(time.RFC3339Nano, value)
			accepted = err == nil
		}
	case "integer":
		accepted = isInteger(actual)
	case "string":
		_, accepted = actual.(string)
	case "number":
		accepted = isNumber(actual)
	case "boolean":
		_, accepted = actual.(bool)
	default:
		return fmt.Errorf("unknown fixture type %q", kind)
	}
	if !accepted {
		return fmt.Errorf("expected %s, received %#v", kind, actual)
	}
	return nil
}

func isInteger(value any) bool {
	switch value := value.(type) {
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
		return true
	case float64:
		return !math.IsNaN(value) && !math.IsInf(value, 0) && math.Trunc(value) == value
	case json.Number:
		_, err := value.Int64()
		return err == nil
	default:
		return false
	}
}

func isNumber(value any) bool {
	switch value.(type) {
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64, json.Number:
		return true
	default:
		return false
	}
}

func verifyFixtureCoverage(manifest protocolFixtureManifest, coverage map[string]struct{}) error {
	runtime := make(map[string]struct{}, len(manifest.RuntimeCoverage))
	for _, capability := range manifest.RuntimeCoverage {
		runtime[capability] = struct{}{}
	}
	missing := make([]string, 0)
	for _, capability := range manifest.Coverage {
		_, coveredByRuntime := runtime[capability]
		_, coveredByScenario := coverage[capability]
		if !coveredByRuntime && !coveredByScenario {
			missing = append(missing, capability)
		}
	}
	if len(missing) > 0 {
		return errors.New("SQL protocol fixtures lack coverage: " + strings.Join(missing, ", "))
	}
	return nil
}

func TestConformanceValueMatcherSupportsSharedTypes(t *testing.T) {
	tests := []struct {
		name   string
		kind   string
		actual any
	}{
		{name: "uuid", kind: "uuid", actual: "11111111-1111-4111-8111-111111111111"},
		{name: "timestamp", kind: "timestamp", actual: "2026-08-21T12:34:56Z"},
		{name: "integer", kind: "integer", actual: int64(1)},
		{name: "string", kind: "string", actual: "value"},
		{name: "any", kind: "any", actual: nil},
		{name: "number", kind: "number", actual: 1.5},
		{name: "boolean", kind: "boolean", actual: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := matchFixtureType(test.kind, test.actual); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestConformanceCoverageRejectsMissingCapability(t *testing.T) {
	manifest := protocolFixtureManifest{
		Coverage:        []string{"enqueue", "claim", "graceful-drain"},
		RuntimeCoverage: []string{"graceful-drain"},
	}

	err := verifyFixtureCoverage(manifest, map[string]struct{}{"enqueue": {}})
	if err == nil || err.Error() != "SQL protocol fixtures lack coverage: claim" {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestConformanceValueMatcherRejectsUnknownReference(t *testing.T) {
	err := matchFixtureValue(
		map[string]any{"$ref": "missing"},
		nil,
		map[string]any{},
		"fixture",
	)
	if err == nil || err.Error() != `fixture references unknown capture "missing"` {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestPGXAndDatabaseSQLSatisfyEverySharedSQLScenario(t *testing.T) {
	databaseURL := testDatabaseURL(t)
	var pgxTranscript []protocolStepTranscript

	for _, adapter := range []string{"pgx", "database-sql"} {
		t.Run(adapter, func(t *testing.T) {
			transcript := runProtocolConformance(t, databaseURL, adapter)
			if adapter == "pgx" {
				pgxTranscript = transcript
				return
			}
			if !reflect.DeepEqual(transcript, pgxTranscript) {
				t.Fatalf("normalized adapter transcripts differ\npgx: %#v\n%s: %#v", pgxTranscript, adapter, transcript)
			}
		})
	}
}

type protocolStepTranscript struct {
	Location string
	Rows     any
	Error    string
}

func runProtocolConformance(t *testing.T, sourceURL, adapter string) []protocolStepTranscript {
	t.Helper()
	ctx := context.Background()
	databaseURL := createConformanceDatabase(t, sourceURL, adapter)

	var executor workhorse.Executor
	switch adapter {
	case "pgx":
		pool, err := pgxpool.New(ctx, databaseURL)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(pool.Close)
		executor = workhorse.NewPGXExecutor(pool)
	case "database-sql":
		database, err := sql.Open("pgx", databaseURL)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = database.Close() })
		executor = workhorse.NewSQLExecutor(database)
	default:
		t.Fatalf("unknown adapter %q", adapter)
	}

	manifest := readFixture[protocolFixtureManifest](t, "manifest.json")
	scenarios := readFixture[[]protocolScenario](t, "scenarios.json")
	coverage := make(map[string]struct{})
	transcript := make([]protocolStepTranscript, 0)
	for _, scenario := range scenarios {
		references := make(map[string]any)
		for _, step := range scenario.Steps {
			location := scenario.ID + "/" + step.ID
			transcript = append(
				transcript,
				executeProtocolStep(t, ctx, executor, step, references, location),
			)
			for _, capability := range step.Covers {
				coverage[capability] = struct{}{}
			}
		}
	}
	if err := verifyFixtureCoverage(manifest, coverage); err != nil {
		t.Fatal(err)
	}
	return transcript
}

func executeProtocolStep(
	t *testing.T,
	ctx context.Context,
	executor workhorse.Executor,
	step protocolStep,
	references map[string]any,
	location string,
) protocolStepTranscript {
	t.Helper()
	arguments := make([]any, len(step.Parameters))
	for index, parameter := range step.Parameters {
		resolved, err := resolveFixtureReferences(parameter, references)
		if err != nil {
			t.Fatalf("%s parameter %d: %v", location, index+1, err)
		}
		arguments[index], err = encodeProtocolArgument(resolved)
		if err != nil {
			t.Fatalf("%s parameter %d: %v", location, index+1, err)
		}
	}

	rows, err := executor.Query(ctx, step.SQL, arguments...)
	if step.Error != nil {
		if err == nil {
			t.Fatalf("%s expected database error %s", location, step.Error.Code)
		}
		assertProtocolDatabaseError(t, err, *step.Error, references, location)
		return protocolStepTranscript{Location: location, Error: step.Error.Code}
	}
	if err != nil {
		t.Fatalf("%s: %v", location, err)
	}
	normalized, err := normalizeProtocolValue(rows)
	if err != nil {
		t.Fatalf("%s normalize rows: %v", location, err)
	}
	if err := matchFixtureValue(step.Expect.Rows, normalized, references, location+".rows"); err != nil {
		t.Fatal(err)
	}
	canonicalRows, err := canonicalizeFixtureValue(step.Expect.Rows, normalized, references)
	if err != nil {
		t.Fatalf("%s canonical rows: %v", location, err)
	}
	for name, pointer := range step.Capture {
		value, err := readFixturePointer(normalized, pointer)
		if err != nil {
			t.Fatalf("%s capture %s: %v", location, name, err)
		}
		references[name] = value
	}
	return protocolStepTranscript{Location: location, Rows: canonicalRows}
}

func resolveFixtureReferences(value any, references map[string]any) (any, error) {
	switch value := value.(type) {
	case map[string]any:
		if len(value) == 1 {
			if name, ok := value["$ref"].(string); ok {
				resolved, exists := references[name]
				if !exists {
					return nil, fmt.Errorf("unknown reference %q", name)
				}
				return resolved, nil
			}
		}
		resolved := make(map[string]any, len(value))
		for key, item := range value {
			var err error
			resolved[key], err = resolveFixtureReferences(item, references)
			if err != nil {
				return nil, err
			}
		}
		return resolved, nil
	case []any:
		resolved := make([]any, len(value))
		for index, item := range value {
			var err error
			resolved[index], err = resolveFixtureReferences(item, references)
			if err != nil {
				return nil, err
			}
		}
		return resolved, nil
	default:
		return value, nil
	}
}

func encodeProtocolArgument(value any) (any, error) {
	switch value.(type) {
	case map[string]any, []any:
		encoded, err := json.Marshal(value)
		if err != nil {
			return nil, err
		}
		return string(encoded), nil
	default:
		return value, nil
	}
}

func normalizeProtocolValue(value any) (any, error) {
	switch value := value.(type) {
	case []workhorse.Row:
		result := make([]any, len(value))
		for index, item := range value {
			normalized, err := normalizeProtocolValue(map[string]any(item))
			if err != nil {
				return nil, err
			}
			result[index] = normalized
		}
		return result, nil
	case map[string]any:
		result := make(map[string]any, len(value))
		for key, item := range value {
			normalized, err := normalizeProtocolValue(item)
			if err != nil {
				return nil, err
			}
			result[key] = normalized
		}
		return result, nil
	case []any:
		result := make([]any, len(value))
		for index, item := range value {
			normalized, err := normalizeProtocolValue(item)
			if err != nil {
				return nil, err
			}
			result[index] = normalized
		}
		return result, nil
	case []byte:
		var decoded any
		if err := decodeJSON(value, &decoded); err == nil {
			return normalizeProtocolValue(decoded)
		}
		return string(value), nil
	case json.Number:
		if integer, err := value.Int64(); err == nil {
			return integer, nil
		}
		return value.Float64()
	case int:
		return int64(value), nil
	case int8:
		return int64(value), nil
	case int16:
		return int64(value), nil
	case int32:
		return int64(value), nil
	case uint:
		return int64(value), nil
	case uint8:
		return int64(value), nil
	case uint16:
		return int64(value), nil
	case uint32:
		return int64(value), nil
	case float32:
		return normalizeProtocolValue(float64(value))
	case float64:
		if !math.IsNaN(value) && !math.IsInf(value, 0) && math.Trunc(value) == value {
			return int64(value), nil
		}
		return value, nil
	case time.Time:
		return value.Format(time.RFC3339Nano), nil
	default:
		return value, nil
	}
}

func isUUID(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return false
	}
	compact := strings.ReplaceAll(value, "-", "")
	_, err := hex.DecodeString(compact)
	return err == nil
}

func matchFixtureValue(expected, actual any, references map[string]any, location string) error {
	switch expected := expected.(type) {
	case map[string]any:
		if name, ok := expected["$ref"].(string); ok {
			reference, exists := references[name]
			if !exists {
				return fmt.Errorf("%s references unknown capture %q", location, name)
			}
			if !reflect.DeepEqual(actual, reference) {
				return fmt.Errorf("%s expected reference %s (%#v), received %#v", location, name, reference, actual)
			}
			return nil
		}
		if kind, ok := expected["$type"].(string); ok {
			if err := matchFixtureType(kind, actual); err != nil {
				return fmt.Errorf("%s %w", location, err)
			}
			return nil
		}
		actualMap, ok := actual.(map[string]any)
		if !ok || len(actualMap) != len(expected) {
			return fmt.Errorf("%s expected %#v, received %#v", location, expected, actual)
		}
		for key, item := range expected {
			actualItem, exists := actualMap[key]
			if !exists {
				return fmt.Errorf("%s missing key %q", location, key)
			}
			if err := matchFixtureValue(item, actualItem, references, location+"."+key); err != nil {
				return err
			}
		}
		return nil
	case []any:
		actualSlice, ok := actual.([]any)
		if !ok || len(actualSlice) != len(expected) {
			return fmt.Errorf("%s expected %#v, received %#v", location, expected, actual)
		}
		for index, item := range expected {
			if err := matchFixtureValue(item, actualSlice[index], references, fmt.Sprintf("%s[%d]", location, index)); err != nil {
				return err
			}
		}
		return nil
	default:
		normalizedExpected, err := normalizeProtocolValue(expected)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(normalizedExpected, actual) {
			return fmt.Errorf("%s expected %#v, received %#v", location, normalizedExpected, actual)
		}
		return nil
	}
}

func canonicalizeFixtureValue(expected, actual any, references map[string]any) (any, error) {
	switch expected := expected.(type) {
	case map[string]any:
		if name, ok := expected["$ref"].(string); ok {
			if _, exists := references[name]; !exists {
				return nil, fmt.Errorf("unknown capture %q", name)
			}
			return map[string]any{"$ref": name}, nil
		}
		if kind, ok := expected["$type"].(string); ok {
			if kind == "uuid" || kind == "timestamp" {
				return map[string]any{"$type": kind}, nil
			}
			return actual, nil
		}
		actualMap := actual.(map[string]any)
		result := make(map[string]any, len(expected))
		for key, item := range expected {
			canonical, err := canonicalizeFixtureValue(item, actualMap[key], references)
			if err != nil {
				return nil, err
			}
			result[key] = canonical
		}
		return result, nil
	case []any:
		actualSlice := actual.([]any)
		result := make([]any, len(expected))
		for index, item := range expected {
			canonical, err := canonicalizeFixtureValue(item, actualSlice[index], references)
			if err != nil {
				return nil, err
			}
			result[index] = canonical
		}
		return result, nil
	default:
		return actual, nil
	}
}

func assertProtocolDatabaseError(
	t *testing.T,
	err error,
	expected protocolErrorExpectation,
	references map[string]any,
	location string,
) {
	t.Helper()
	var databaseError *pgconn.PgError
	if !errors.As(err, &databaseError) {
		t.Fatalf("%s expected PostgreSQL error, received %T: %v", location, err, err)
	}
	if databaseError.Code != expected.Code {
		t.Errorf("%s SQLSTATE: expected %s, received %s", location, expected.Code, databaseError.Code)
	}
	if databaseError.Message != expected.Message {
		t.Errorf("%s message: expected %q, received %q", location, expected.Message, databaseError.Message)
	}
	if expected.Detail == nil {
		return
	}
	var detail any
	if err := decodeJSON([]byte(databaseError.Detail), &detail); err != nil {
		t.Fatalf("%s detail: %v", location, err)
	}
	normalized, err := normalizeProtocolValue(detail)
	if err != nil {
		t.Fatalf("%s detail: %v", location, err)
	}
	if err := matchFixtureValue(expected.Detail, normalized, references, location+".detail"); err != nil {
		t.Fatal(err)
	}
}

func readFixturePointer(value any, pointer string) (any, error) {
	current := value
	for _, segment := range strings.Split(pointer, ".") {
		switch current := current.(type) {
		case []any:
			index, err := strconv.Atoi(segment)
			if err != nil || index < 0 || index >= len(current) {
				return nil, fmt.Errorf("invalid list segment %q", segment)
			}
			currentValue := current[index]
			value = currentValue
		case map[string]any:
			currentValue, ok := current[segment]
			if !ok {
				return nil, fmt.Errorf("missing object segment %q", segment)
			}
			value = currentValue
		default:
			return nil, fmt.Errorf("cannot read segment %q from %T", segment, current)
		}
		current = value
	}
	return current, nil
}

func readFixture[T any](t *testing.T, name string) T {
	t.Helper()
	contents, err := os.ReadFile(filepath.Join("..", "protocol", "v1", name))
	if err != nil {
		t.Fatal(err)
	}
	var fixture T
	if err := decodeJSON(contents, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func decodeJSON(contents []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(contents))
	decoder.UseNumber()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("JSON contains trailing data")
	}
	return nil
}

func createConformanceDatabase(t *testing.T, sourceURL, adapter string) string {
	t.Helper()
	parsed, err := url.Parse(sourceURL)
	if err != nil {
		t.Fatal(err)
	}
	sourceName := strings.TrimPrefix(parsed.Path, "/")
	if parsed.Hostname() != "localhost" && parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "::1" {
		t.Fatalf("Go conformance tests refuse non-loopback database host %q", parsed.Hostname())
	}
	if !strings.Contains(sourceName, "test") {
		t.Fatalf("WORKHORSE_TEST_DATABASE_URL must name a test database")
	}
	digest := fmt.Sprintf("%x", sha256.Sum256([]byte(t.Name()+adapter+strconv.Itoa(os.Getpid()))))[:10]
	prefix := sourceName
	if len(prefix) > 44 {
		prefix = prefix[:44]
	}
	databaseName := prefix + "_go_" + digest
	if !isSafeDatabaseName(databaseName) {
		t.Fatalf("generated unsafe database name %q", databaseName)
	}

	adminURL := *parsed
	adminURL.Path = "/postgres"
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, adminURL.String())
	if err != nil {
		t.Fatal(err)
	}
	quotedName := pgx.Identifier{databaseName}.Sanitize()
	if _, err := admin.Exec(ctx, "DROP DATABASE IF EXISTS "+quotedName); err != nil {
		_ = admin.Close(ctx)
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, "CREATE DATABASE "+quotedName); err != nil {
		_ = admin.Close(ctx)
		t.Fatal(err)
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
			t.Errorf("drop conformance database: %v", err)
		}
	})

	databaseURL := *parsed
	databaseURL.Path = "/" + databaseName
	schema, err := os.ReadFile(filepath.Join("..", "sql", "schema.sql"))
	if err != nil {
		t.Fatal(err)
	}
	connection, err := pgx.Connect(ctx, databaseURL.String())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := connection.Exec(ctx, string(schema)); err != nil {
		_ = connection.Close(ctx)
		t.Fatal(err)
	}
	if err := connection.Close(ctx); err != nil {
		t.Fatal(err)
	}

	return databaseURL.String()
}

func isSafeDatabaseName(name string) bool {
	if name == "" || len(name) > 63 {
		return false
	}
	for _, character := range name {
		if (character < 'a' || character > 'z') && (character < 'A' || character > 'Z') && (character < '0' || character > '9') && character != '_' {
			return false
		}
	}
	return true
}
