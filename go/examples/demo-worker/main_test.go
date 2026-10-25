package main

import (
	"context"
	"strings"
	"testing"
	"time"

	workhorse "github.com/stablemates/workhorse/go"
)

func TestWorkerUsesDedicatedAndSharedQueues(t *testing.T) {
	if goQueue != "demo-go" || sharedQueue != "demo-shared" {
		t.Fatalf("unexpected queues: %q, %q", goQueue, sharedQueue)
	}
}

func TestSharedTaskIdentifiesGoRuntime(t *testing.T) {
	result, err := sharedTask(
		context.Background(),
		map[string]any{"source": "schedule"},
		&workhorse.HandlerContext{Task: workhorse.ClaimedTask{Attempt: 3}},
	)
	if err != nil {
		t.Fatal(err)
	}
	object, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("expected object result, got %T", result)
	}
	if object["source"] != "schedule" || object["runtime"] != "go" || object["attempt"] != 3 {
		t.Fatalf("unexpected result: %#v", object)
	}
}

func TestLanguageTaskIdentifiesGoRuntime(t *testing.T) {
	result, err := languageTask(
		context.Background(),
		map[string]any{"language": "go"},
		&workhorse.HandlerContext{Task: workhorse.ClaimedTask{Attempt: 2}},
	)
	if err != nil {
		t.Fatal(err)
	}
	object, ok := result.(map[string]any)
	if !ok {
		t.Fatalf("expected object result, got %T", result)
	}
	if object["language"] != "go" || object["runtime"] != "go" || object["attempt"] != 2 {
		t.Fatalf("unexpected result: %#v", object)
	}
}

func TestLanguageTaskRefusesAnotherRuntime(t *testing.T) {
	_, err := languageTask(
		context.Background(),
		map[string]any{"language": "python"},
		&workhorse.HandlerContext{},
	)
	if err == nil {
		t.Fatal("expected language mismatch to fail")
	}
}

func TestWorkerIDExposesRuntimeAndStaysProcessUnique(t *testing.T) {
	first, err := workerID()
	if err != nil {
		t.Fatal(err)
	}
	second, err := workerID()
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("expected generated worker IDs to differ")
	}
	if !strings.HasPrefix(first, "demo-go-") {
		t.Fatalf("worker ID does not expose Go runtime: %q", first)
	}
}

// SM-1778: a value above 2147483647 ms could wrap the time.Duration multiplication to a value in
// the SDK range, so the demo refuses it first.
func TestPollIntervalReadsTheEnvironment(t *testing.T) {
	for value, want := range map[string]time.Duration{
		"0": 0, "15": 15 * time.Millisecond, "2147483647": 2147483647 * time.Millisecond,
	} {
		t.Setenv("WORKHORSE_WORKER_POLL_MS", value)
		if got, err := pollInterval(); err != nil || got != want {
			t.Fatalf("%s: got %s, %v; want %s", value, got, err, want)
		}
	}
	for _, value := range []string{"-1", "2147483648", "288230376151711745", "soon"} {
		t.Setenv("WORKHORSE_WORKER_POLL_MS", value)
		if _, err := pollInterval(); err == nil {
			t.Fatalf("%s: got no error", value)
		}
	}
}
