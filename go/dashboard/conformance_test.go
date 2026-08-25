package dashboard

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

type dashboardFixture struct {
	Harness   dashboardHarness    `json:"harness"`
	Scenarios []dashboardScenario `json:"scenarios"`
}

type dashboardHarness struct {
	BasePath           string         `json:"basePath"`
	Origin             string         `json:"origin"`
	CrossOrigin        string         `json:"crossOrigin"`
	AuthenticatedActor string         `json:"authenticatedActor"`
	Environment        string         `json:"environment"`
	ConfiguredWorkers  []string       `json:"configuredWorkers"`
	MaintenanceLoops   map[string]int `json:"maintenanceLoops"`
}

type dashboardScenario struct {
	ID        string              `json:"id"`
	Seed      []dashboardSeedStep `json:"seed"`
	Exchanges []dashboardExchange `json:"exchanges"`
}

type dashboardSeedStep struct {
	ID         string            `json:"id"`
	SQL        string            `json:"sql"`
	Parameters []any             `json:"parameters"`
	Expect     dashboardSeedRows `json:"expect"`
	Capture    map[string]string `json:"capture"`
}

type dashboardSeedRows struct {
	Rows []any `json:"rows"`
}

type dashboardExchange struct {
	ID        string                    `json:"id"`
	Procedure string                    `json:"procedure"`
	Method    string                    `json:"method"`
	Mode      string                    `json:"mode"`
	Origin    string                    `json:"origin"`
	Request   any                       `json:"request"`
	Expect    dashboardExchangeExpected `json:"expect"`
	Capture   map[string]string         `json:"capture"`
}

type dashboardExchangeExpected struct {
	Status int `json:"status"`
	Body   any `json:"body"`
}

func TestDashboardSatisfiesEverySharedHTTPScenario(t *testing.T) {
	sourceURL := os.Getenv("DATABASE_URL_TEST")
	if sourceURL == "" {
		t.Skip("DATABASE_URL_TEST is required for dashboard conformance tests")
	}
	ctx := context.Background()
	databaseURL := createDashboardConformanceDatabase(t, sourceURL)
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	executor := workhorse.NewPGXExecutor(pool)
	fixture := readDashboardFixture(t)
	references := make(map[string]any)
	for _, scenario := range fixture.Scenarios {
		for _, step := range scenario.Seed {
			executeDashboardSeedStep(t, ctx, executor, scenario.ID, step, references)
		}
	}

	host := newDashboardConformanceHandler(t, fixture.Harness, executor, false)
	readOnlyHost := newDashboardConformanceHandler(t, fixture.Harness, executor, true)
	for _, scenario := range fixture.Scenarios {
		for _, exchange := range scenario.Exchanges {
			t.Run(scenario.ID+"/"+exchange.ID, func(t *testing.T) {
				selected := host
				if exchange.Mode == "read-only" {
					selected = readOnlyHost
				}
				status, body := executeDashboardExchange(t, selected, fixture.Harness, exchange, references)
				if status != exchange.Expect.Status {
					t.Fatalf("status: expected %d, received %d: %#v", exchange.Expect.Status, status, body)
				}
				if err := matchDashboardFixtureValue(exchange.Expect.Body, body, references, exchange.ID+".body"); err != nil {
					t.Fatal(err)
				}
				for name, pointer := range exchange.Capture {
					value, err := readDashboardFixturePointer(body, pointer)
					if err != nil {
						t.Fatalf("capture %s: %v", name, err)
					}
					references[name] = value
				}
			})
		}
	}
}

func newDashboardConformanceHandler(t *testing.T, harness dashboardHarness, executor workhorse.Executor, readOnly bool) http.Handler {
	t.Helper()
	procedures := map[string]Procedure{}
	if !readOnly {
		queue := workhorse.NewQueue(executor, "conformance-demo")
		procedures["enqueueTest"] = func(ctx context.Context, input any, _ string) (any, error) {
			value := input.(map[string]any)
			priority, _ := dashboardInteger(value["priority"])
			jobID, err := queue.Enqueue(ctx, "conformance.demo-"+value["kind"].(string), map[string]any{}, workhorse.EnqueueOptions{Priority: priority})
			if err != nil {
				return nil, err
			}
			return map[string]any{"jobId": jobID}, nil
		}
		procedures["setScheduleEnabled"] = func(ctx context.Context, input any, _ string) (any, error) {
			value := input.(map[string]any)
			rows, err := executor.Query(ctx, `UPDATE workhorse.schedule_definition
SET enabled=$1,revision=revision+1,updated_at=clock_timestamp()
WHERE namespace=$2 AND schedule_name=$3 RETURNING enabled`, value["enabled"], value["namespace"], value["name"])
			if err != nil {
				return nil, err
			}
			if len(rows) != 1 {
				return nil, fmt.Errorf("setScheduleEnabled updated %d schedules", len(rows))
			}
			return map[string]any{"enabled": rows[0]["enabled"]}, nil
		}
	}
	handler, err := NewHandler(HandlerOptions{
		Executor: executor,
		Authorize: func(*http.Request) Authorization {
			return Authorization{Principal: &Principal{Actor: harness.AuthenticatedActor}}
		},
		Path: harness.BasePath, Environment: harness.Environment, ReadOnly: readOnly,
		ConfiguredWorkers: harness.ConfiguredWorkers, MaintenanceLoops: harness.MaintenanceLoops,
		Procedures: procedures,
	})
	if err != nil {
		t.Fatal(err)
	}
	return handler
}

func executeDashboardExchange(t *testing.T, handler http.Handler, harness dashboardHarness, exchange dashboardExchange, references map[string]any) (int, any) {
	t.Helper()
	requestValue, err := resolveDashboardFixtureReferences(exchange.Request, references)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(requestValue)
	if err != nil {
		t.Fatal(err)
	}
	method := exchange.Method
	if method == "" {
		method = http.MethodPost
	}
	request := httptest.NewRequest(method, harness.Origin+harness.BasePath+"/rpc/dashboard/"+exchange.Procedure, bytes.NewReader(payload))
	switch exchange.Origin {
	case "none":
	case "cross":
		request.Header.Set("Origin", harness.CrossOrigin)
	default:
		request.Header.Set("Origin", harness.Origin)
	}
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	var body any
	if err := decodeDashboardJSON(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v: %s", err, response.Body.String())
	}
	body, err = normalizeDashboardFixtureValue(body)
	if err != nil {
		t.Fatal(err)
	}
	return response.Code, body
}

func executeDashboardSeedStep(t *testing.T, ctx context.Context, executor workhorse.Executor, scenario string, step dashboardSeedStep, references map[string]any) {
	t.Helper()
	arguments := make([]any, len(step.Parameters))
	for index, parameter := range step.Parameters {
		resolved, err := resolveDashboardFixtureReferences(parameter, references)
		if err != nil {
			t.Fatalf("%s/%s parameter %d: %v", scenario, step.ID, index+1, err)
		}
		arguments[index], err = encodeDashboardFixtureArgument(resolved)
		if err != nil {
			t.Fatalf("%s/%s parameter %d: %v", scenario, step.ID, index+1, err)
		}
	}
	rows, err := executor.Query(ctx, step.SQL, arguments...)
	if err != nil {
		t.Fatalf("%s/%s: %v", scenario, step.ID, err)
	}
	normalized, err := normalizeDashboardFixtureValue(rows)
	if err != nil {
		t.Fatalf("%s/%s: %v", scenario, step.ID, err)
	}
	location := scenario + "/" + step.ID
	if err := matchDashboardFixtureValue(step.Expect.Rows, normalized, references, location+".rows"); err != nil {
		t.Fatal(err)
	}
	for name, pointer := range step.Capture {
		value, err := readDashboardFixturePointer(normalized, pointer)
		if err != nil {
			t.Fatalf("%s capture %s: %v", location, name, err)
		}
		references[name] = value
	}
}

func resolveDashboardFixtureReferences(value any, references map[string]any) (any, error) {
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
			resolved[key], err = resolveDashboardFixtureReferences(item, references)
			if err != nil {
				return nil, err
			}
		}
		return resolved, nil
	case []any:
		resolved := make([]any, len(value))
		for index, item := range value {
			var err error
			resolved[index], err = resolveDashboardFixtureReferences(item, references)
			if err != nil {
				return nil, err
			}
		}
		return resolved, nil
	default:
		return value, nil
	}
}

func encodeDashboardFixtureArgument(value any) (any, error) {
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

func normalizeDashboardFixtureValue(value any) (any, error) {
	switch value := value.(type) {
	case []workhorse.Row:
		result := make([]any, len(value))
		for index, item := range value {
			normalized, err := normalizeDashboardFixtureValue(map[string]any(item))
			if err != nil {
				return nil, err
			}
			result[index] = normalized
		}
		return result, nil
	case map[string]any:
		result := make(map[string]any, len(value))
		for key, item := range value {
			normalized, err := normalizeDashboardFixtureValue(item)
			if err != nil {
				return nil, err
			}
			result[key] = normalized
		}
		return result, nil
	case []any:
		result := make([]any, len(value))
		for index, item := range value {
			normalized, err := normalizeDashboardFixtureValue(item)
			if err != nil {
				return nil, err
			}
			result[index] = normalized
		}
		return result, nil
	case []byte:
		var decoded any
		if err := decodeDashboardJSON(value, &decoded); err == nil {
			return normalizeDashboardFixtureValue(decoded)
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
		return normalizeDashboardFixtureValue(float64(value))
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

func matchDashboardFixtureValue(expected, actual any, references map[string]any, location string) error {
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
			if err := matchDashboardFixtureType(kind, actual); err != nil {
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
			if err := matchDashboardFixtureValue(item, actualItem, references, location+"."+key); err != nil {
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
			if err := matchDashboardFixtureValue(item, actualSlice[index], references, fmt.Sprintf("%s[%d]", location, index)); err != nil {
				return err
			}
		}
		return nil
	default:
		normalizedExpected, err := normalizeDashboardFixtureValue(expected)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(normalizedExpected, actual) {
			return fmt.Errorf("%s expected %#v, received %#v", location, normalizedExpected, actual)
		}
		return nil
	}
}

func matchDashboardFixtureType(kind string, actual any) error {
	accepted := false
	switch kind {
	case "any":
		accepted = true
	case "uuid":
		value, ok := actual.(string)
		accepted = ok && isDashboardUUID(value)
	case "timestamp":
		value, ok := actual.(string)
		accepted = ok && isDashboardTimestamp(value)
	case "integer":
		_, accepted = dashboardInteger(actual)
	case "string":
		_, accepted = actual.(string)
	case "number":
		switch actual.(type) {
		case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64, json.Number:
			accepted = true
		}
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

func dashboardInteger(value any) (int, bool) {
	switch value := value.(type) {
	case int:
		return value, true
	case int64:
		return int(value), true
	case json.Number:
		integer, err := value.Int64()
		return int(integer), err == nil
	case float64:
		return int(value), !math.IsNaN(value) && !math.IsInf(value, 0) && math.Trunc(value) == value
	default:
		return 0, false
	}
}

func isDashboardUUID(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return false
	}
	_, err := hex.DecodeString(strings.ReplaceAll(value, "-", ""))
	return err == nil
}

func isDashboardTimestamp(value string) bool {
	for _, layout := range []string{
		time.RFC3339Nano,
		"2006-01-02T15:04:05.999999999",
		"2006-01-02 15:04:05.999999999Z07:00",
		"2006-01-02 15:04:05.999999999",
		time.DateOnly,
		"20060102T150405.999999999Z07:00",
		"20060102T150405.999999999",
		"20060102",
	} {
		if _, err := time.Parse(layout, value); err == nil {
			return true
		}
	}
	return false
}

func readDashboardFixturePointer(value any, pointer string) (any, error) {
	current := value
	for _, segment := range strings.Split(pointer, ".") {
		switch current := current.(type) {
		case []any:
			index, err := strconv.Atoi(segment)
			if err != nil || index < 0 || index >= len(current) {
				return nil, fmt.Errorf("invalid list segment %q", segment)
			}
			value = current[index]
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

func readDashboardFixture(t *testing.T) dashboardFixture {
	t.Helper()
	contents, err := os.ReadFile(filepath.Join("..", "..", "dashboard", "v1", "conformance.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture dashboardFixture
	if err := decodeDashboardJSON(contents, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func decodeDashboardJSON(contents []byte, target any) error {
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

func createDashboardConformanceDatabase(t *testing.T, sourceURL string) string {
	t.Helper()
	parsed, err := url.Parse(sourceURL)
	if err != nil {
		t.Fatal(err)
	}
	sourceName := strings.TrimPrefix(parsed.Path, "/")
	if parsed.Hostname() != "localhost" && parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "::1" {
		t.Fatalf("Go dashboard conformance tests refuse non-loopback database host %q", parsed.Hostname())
	}
	if !strings.Contains(sourceName, "test") {
		t.Fatalf("DATABASE_URL_TEST must name a test database")
	}
	digest := fmt.Sprintf("%x", sha256.Sum256([]byte(t.Name()+strconv.Itoa(os.Getpid()))))[:10]
	prefix := sourceName
	if len(prefix) > 39 {
		prefix = prefix[:39]
	}
	databaseName := prefix + "_go_dashboard_" + digest
	if !isSafeDashboardDatabaseName(databaseName) {
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
			t.Errorf("drop dashboard conformance database: %v", err)
		}
	})

	databaseURL := *parsed
	databaseURL.Path = "/" + databaseName
	schema, err := os.ReadFile(filepath.Join("..", "..", "sql", "schema", "current.sql"))
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

func isSafeDashboardDatabaseName(name string) bool {
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
