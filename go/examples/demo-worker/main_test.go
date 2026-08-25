package main

import (
	"context"
	"strings"
	"testing"

	workhorse "github.com/stablemates/workhorse/go"
)

func TestWorkerUsesDedicatedAndSharedQueues(t *testing.T) {
	if goQueue != "demo-go" || sharedQueue != "demo-shared" {
		t.Fatalf("unexpected queues: %q, %q", goQueue, sharedQueue)
	}
}

func TestSharedJobIdentifiesGoRuntime(t *testing.T) {
	result, err := sharedJob(
		context.Background(),
		map[string]any{"source": "schedule"},
		&workhorse.HandlerContext{Job: workhorse.ClaimedJob{Attempt: 3}},
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

func TestLanguageJobIdentifiesGoRuntime(t *testing.T) {
	result, err := languageJob(
		context.Background(),
		map[string]any{"language": "go"},
		&workhorse.HandlerContext{Job: workhorse.ClaimedJob{Attempt: 2}},
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

func TestLanguageJobRefusesAnotherRuntime(t *testing.T) {
	_, err := languageJob(
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
