package main

import (
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDemoLogFileNeedsADirectoryAndAServiceName(t *testing.T) {
	t.Setenv("WORKHORSE_DEMO_LOG_DIRECTORY", "")
	t.Setenv("WORKHORSE_DEMO_SERVICE_NAME", "workhorse-demo-worker-go")
	file, err := newDemoLogFile()
	if err != nil || file != nil {
		t.Fatalf("newDemoLogFile() = %v, %v; want nil, nil", file, err)
	}
}

func TestDemoLogFileRefusesAnInvalidSize(t *testing.T) {
	t.Setenv("WORKHORSE_DEMO_LOG_DIRECTORY", t.TempDir())
	t.Setenv("WORKHORSE_DEMO_SERVICE_NAME", "w")
	t.Setenv("WORKHORSE_DEMO_LOG_MAX_BYTES", "0")
	if _, err := newDemoLogFile(); err == nil ||
		!strings.Contains(err.Error(), "WORKHORSE_DEMO_LOG_MAX_BYTES") {
		t.Fatalf("newDemoLogFile() error = %v", err)
	}
}

func TestDemoLoggerWritesTheTypeScriptRecordShape(t *testing.T) {
	directory := t.TempDir()
	t.Setenv("WORKHORSE_DEMO_LOG_DIRECTORY", directory)
	t.Setenv("WORKHORSE_DEMO_SERVICE_NAME", "workhorse-demo-worker-go")
	t.Setenv("WORKHORSE_DEMO_ENV", "test env")
	file, err := newDemoLogFile()
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(newDemoLogHandler(file)).With("workhorse.worker.id", "w1")
	logger.Debug("Task claimed", "event.name", "workhorse.task.claimed", slog.Group("workhorse", "queue", "q"))
	logger.Info("Task completed", "event.name", "workhorse.task.completed", "elapsed", 1500*time.Millisecond,
		"error", errors.New("boom"))

	contents, err := os.ReadFile(filepath.Join(directory, "test_env", "workhorse-demo-worker-go.ndjson"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(contents)), "\n")
	if len(lines) != 2 {
		t.Fatalf("got %d lines, want 2: %s", len(lines), contents)
	}
	keys := []string{
		`"timestamp"`, `"observedTimestamp"`, `"severityText"`, `"severityNumber"`, `"eventName"`,
		`"body"`, `"attributes"`, `"resource"`, `"scope"`,
	}
	last := -1
	for _, key := range keys {
		index := strings.Index(lines[1], key)
		if index <= last {
			t.Fatalf("key %s is out of order in %s", key, lines[1])
		}
		last = index
	}
	var debug, info map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &debug); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(lines[1]), &info); err != nil {
		t.Fatal(err)
	}
	if debug["severityText"] != "DEBUG" || debug["severityNumber"] != float64(5) {
		t.Fatalf("debug severity = %v %v", debug["severityText"], debug["severityNumber"])
	}
	if got := debug["attributes"].(map[string]any)["workhorse.queue"]; got != "q" {
		t.Fatalf("group attribute = %v", got)
	}
	if info["eventName"] != "workhorse.task.completed" || info["body"] != "Task completed" {
		t.Fatalf("record = %v", info)
	}
	if !strings.HasSuffix(info["timestamp"].(string), "Z") {
		t.Fatalf("timestamp %v is not UTC", info["timestamp"])
	}
	attributes := info["attributes"].(map[string]any)
	if attributes["workhorse.worker.id"] != "w1" || attributes["elapsed"] != float64(1500) ||
		attributes["error"] != "boom" {
		t.Fatalf("attributes = %v", attributes)
	}
	if _, ok := attributes["event.name"]; ok {
		t.Fatalf("attributes keep event.name: %v", attributes)
	}
	resource := info["resource"].(map[string]any)
	if resource["service.name"] != "workhorse-demo-worker-go" ||
		resource["deployment.environment.name"] != "test env" ||
		resource["telemetry.sdk.language"] != "go" {
		t.Fatalf("resource = %v", resource)
	}
}

func TestDemoLogFileRotatesBeforeTheLimit(t *testing.T) {
	directory := t.TempDir()
	file := &demoLogFile{path: filepath.Join(directory, "w.ndjson"), maxBytes: 400, archives: 2}
	logger := slog.New(newDemoLogHandler(file))
	for index := range 12 {
		logger.Info("record", "index", index)
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
		info, _ := entry.Info()
		if info.Size() > 400 {
			t.Fatalf("%s has %d bytes", entry.Name(), info.Size())
		}
	}
	if strings.Join(names, ",") != "w.ndjson,w.ndjson.1,w.ndjson.2" {
		t.Fatalf("files = %v", names)
	}
	contents, _ := os.ReadFile(filepath.Join(directory, "w.ndjson"))
	if !strings.Contains(string(contents), `"index":11`) {
		t.Fatalf("the newest record is not in the current file: %s", contents)
	}
}

// A record that JSON cannot encode, such as a channel attribute, reports the failure once. Run with
// -race: two writers then share the failure flag.
func TestDemoLogFileReportsAnEncodingFailureUnderConcurrency(t *testing.T) {
	file := &demoLogFile{path: filepath.Join(t.TempDir(), "w.ndjson"), maxBytes: 1000, archives: 1}
	logger := slog.New(newDemoLogHandler(file))
	done := make(chan struct{})
	for range 2 {
		go func() {
			defer func() { done <- struct{}{} }()
			for range 20 {
				logger.Info("record", "value", make(chan int))
			}
		}()
	}
	<-done
	<-done
	file.mu.Lock()
	defer file.mu.Unlock()
	if !file.failed {
		t.Fatal("the encoding failure was not recorded")
	}
}

func TestDemoLogHandlerWritesNonFiniteNumbersAsNullAndInlinesEmptyGroups(t *testing.T) {
	path := filepath.Join(t.TempDir(), "w.ndjson")
	file := &demoLogFile{path: path, maxBytes: 10_000, archives: 1}
	logger := slog.New(newDemoLogHandler(file))
	logger.Info("record", "nan", math.NaN(), slog.Group("", "queue", "q"),
		slog.Group("workhorse", slog.Group("", "inner", 1)), "", "dropped")
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var record map[string]any
	if err := json.Unmarshal(contents, &record); err != nil {
		t.Fatal(err)
	}
	attributes := record["attributes"].(map[string]any)
	want := map[string]any{"nan": nil, "queue": "q", "workhorse.inner": float64(1)}
	if len(attributes) != len(want) {
		t.Fatalf("attributes = %v, want %v", attributes, want)
	}
	for key, value := range want {
		if got, ok := attributes[key]; !ok || got != value {
			t.Fatalf("attributes = %v, want %v", attributes, want)
		}
	}
}
