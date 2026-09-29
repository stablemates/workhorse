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
	languageTaskType          = "demo.language-worker"
	sharedTaskType            = "demo.shared-worker"
	goQueue                   = "demo-go"
	goFastQueue               = "demo-go-fast"
	sharedQueue               = "demo-shared"
	scheduleNamespace         = "workhorse-demo"
	fastTierScheduleNamespace = "workhorse-demo-fast-tier"
	workerConcurrency         = 3
	defaultPollMilliseconds   = 15_000
	schemaRetryInterval       = 500 * time.Millisecond
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
	if value := os.Getenv("DATABASE_URL_PRIMARY"); value != "" {
		return value, nil
	}
	return "", errors.New("DATABASE_URL_PRIMARY is required")
}

// waitsForSchema reports whether the worker should wait for a missing schema, which only the
// development demo does. The production demo keeps a read-only startup and refuses at once.
func waitsForSchema() (bool, error) {
	switch mode := os.Getenv("WORKHORSE_DEMO_MODE"); mode {
	case "development":
		return true, nil
	case "", "production":
		return false, nil
	default:
		return false, errors.New("WORKHORSE_DEMO_MODE must be either development or production")
	}
}

// waitForSchema waits while the demo server has not installed the schema yet.
//
// In development the server installs the schema on first start, so a worker that starts beside it
// can see an empty database. Every other compatibility refusal fails at once. It returns the
// context's error when shutdown arrives first.
func waitForSchema(ctx context.Context, executor workhorse.Executor, logger *slog.Logger) error {
	logged := false
	for {
		err := workhorse.AssertSchemaCompatible(ctx, executor)
		var compatibility *workhorse.CompatibilityError
		if !errors.As(err, &compatibility) || compatibility.Code != workhorse.SchemaNotInstalled {
			return err
		}
		if !logged {
			logger.Info("Waiting for the demo server to install the Workhorse schema")
			logged = true
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(schemaRetryInterval):
		}
	}
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

func languageTask(
	_ context.Context,
	payload any,
	handler *workhorse.HandlerContext,
) (any, error) {
	object, ok := payload.(map[string]any)
	if !ok || object["language"] != "go" {
		return nil, errors.New("go worker received a task for another language")
	}
	return map[string]any{
		"language": "go",
		"runtime":  "go",
		"attempt":  handler.Task.Attempt,
	}, nil
}

func sharedTask(
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
		"attempt": handler.Task.Attempt,
	}, nil
}

func newWorker(
	pool *pgxpool.Pool,
	poll time.Duration,
	id string,
	logger *slog.Logger,
) (*workhorse.Worker, error) {
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queues:              []string{goQueue, sharedQueue, goFastQueue},
		WorkerID:            id,
		Concurrency:         workerConcurrency,
		PollInterval:        poll,
		ScheduleNamespaces:  []string{scheduleNamespace, fastTierScheduleNamespace},
		MaintenanceInterval: time.Second,
		RegistryInterval:    250 * time.Millisecond,
		ShutdownGracePeriod: 25 * time.Second,
		Logger:              logger,
	})
	if err != nil {
		return nil, err
	}
	worker.Handle(languageTaskType, languageTask)
	worker.Handle(sharedTaskType, sharedTask)
	return worker, nil
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
	waits, err := waitsForSchema()
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

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if waits {
		if err := waitForSchema(runContext, workhorse.NewPGXExecutor(pool), logger); err != nil {
			if runContext.Err() != nil {
				return
			}
			panic(err)
		}
	}
	worker, err := newWorker(pool, poll, id, logger)
	if err != nil {
		panic(err)
	}
	if err := worker.Run(runContext); err != nil {
		panic(err)
	}
}
