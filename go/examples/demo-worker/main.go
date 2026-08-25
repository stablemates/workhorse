package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

const (
	languageJobType         = "demo.language-worker"
	sharedJobType           = "demo.shared-worker"
	goQueue                 = "demo-go"
	sharedQueue             = "demo-shared"
	workerConcurrency       = 3
	defaultPollMilliseconds = 15_000
)

func workerID() (string, error) {
	hostname, err := os.Hostname()
	if err != nil {
		return "", err
	}
	random := make([]byte, 4)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	return fmt.Sprintf("demo-go-%s-%d-%s", hostname, os.Getpid(), hex.EncodeToString(random)), nil
}

func databaseURL() (string, error) {
	if value := os.Getenv("DATABASE_URL_DEV_PRIMARY"); value != "" {
		return value, nil
	}
	return "", errors.New("DATABASE_URL_DEV_PRIMARY is required")
}

func pollInterval() (time.Duration, error) {
	value := os.Getenv("WORKHORSE_WORKER_POLL_MS")
	if value == "" {
		return defaultPollMilliseconds * time.Millisecond, nil
	}
	milliseconds, err := strconv.Atoi(value)
	if err != nil || milliseconds < 0 {
		return 0, errors.New("WORKHORSE_WORKER_POLL_MS must be a non-negative integer")
	}
	return time.Duration(milliseconds) * time.Millisecond, nil
}

func languageJob(
	_ context.Context,
	payload any,
	handler *workhorse.HandlerContext,
) (any, error) {
	object, ok := payload.(map[string]any)
	if !ok || object["language"] != "go" {
		return nil, errors.New("go worker received a job for another language")
	}
	return map[string]any{
		"language": "go",
		"runtime":  "go",
		"attempt":  handler.Job.Attempt,
	}, nil
}

func sharedJob(
	_ context.Context,
	payload any,
	handler *workhorse.HandlerContext,
) (any, error) {
	object, ok := payload.(map[string]any)
	source, hasSource := object["source"].(string)
	if !ok || !hasSource {
		return nil, errors.New("shared worker requires a source")
	}
	return map[string]any{
		"source":  source,
		"runtime": "go",
		"attempt": handler.Job.Attempt,
	}, nil
}

func main() {
	runContext, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	url, err := databaseURL()
	if err != nil {
		panic(err)
	}
	poll, err := pollInterval()
	if err != nil {
		panic(err)
	}
	id, err := workerID()
	if err != nil {
		panic(err)
	}
	pool, err := pgxpool.New(runContext, url)
	if err != nil {
		panic(err)
	}
	defer pool.Close()

	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queues:              []string{goQueue, sharedQueue},
		WorkerID:            id,
		Concurrency:         workerConcurrency,
		PollInterval:        poll,
		MaintenanceInterval: time.Second,
		RegistryInterval:    250 * time.Millisecond,
		ShutdownGracePeriod: 25 * time.Second,
		Logger:              slog.New(slog.NewJSONHandler(os.Stdout, nil)),
	})
	if err != nil {
		panic(err)
	}
	worker.Handle(languageJobType, languageJob)
	worker.Handle(sharedJobType, sharedJob)
	if err := worker.Run(runContext); err != nil {
		panic(err)
	}
}
