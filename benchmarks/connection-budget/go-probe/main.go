// Command go-probe is the Go probe of the connection budget benchmark (SM-1566).
//
// It runs W workers on one pool. A task whose payload has handlerMs returns after that time; any
// other task holds its slot until SIGTERM. Every handler returns at SIGTERM, so the stop time
// measures the SDK. scripts/benchmark-connection-budget.ts builds it, starts it, and reads the
// WH_BENCH_* variables below. Nothing in CI runs it.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

func setting(name string) string {
	value := os.Getenv(name)
	if value == "" {
		fail(fmt.Errorf("%s is required", name))
	}
	return value
}

func count(name string) int {
	value, err := strconv.Atoi(setting(name))
	if err != nil || value < 1 {
		fail(fmt.Errorf("%s must be a positive integer", name))
	}
	return value
}

// optionalCount reads an optional variable. It returns 0 when the variable is empty.
func optionalCount(name string) int {
	if os.Getenv(name) == "" {
		return 0
	}
	return count(name)
}

// nullable gives null for 0, so the started event names a setting that the probe did not set.
func nullable(value int) any {
	if value == 0 {
		return nil
	}
	return value
}

// payloadHandlerMs reads the handler time of a task from its payload, which pgx decodes from jsonb.
func payloadHandlerMs(payload any) (int64, bool) {
	fields, ok := payload.(map[string]any)
	if !ok {
		return 0, false
	}
	switch value := fields["handlerMs"].(type) {
	case float64:
		return int64(value), true
	case json.Number:
		parsed, err := value.Int64()
		return parsed, err == nil
	default:
		return 0, false
	}
}

var output sync.Mutex

func emit(event map[string]any) {
	line, _ := json.Marshal(event)
	output.Lock()
	defer output.Unlock()
	fmt.Println(string(line))
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}

func main() {
	queue := setting("WH_BENCH_QUEUE")
	workers := count("WH_BENCH_WORKERS")
	pollMs := optionalCount("WH_BENCH_POLL_MS")
	shutdownGraceMs := count("WH_BENCH_SHUTDOWN_GRACE_MS")
	config, err := pgxpool.ParseConfig(setting("WH_BENCH_DATABASE_URL"))
	if err != nil {
		fail(err)
	}
	config.MaxConns = int32(count("WH_BENCH_POOL_SIZE"))
	config.ConnConfig.RuntimeParams["application_name"] = setting("WH_BENCH_APPLICATION_NAME")
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		fail(err)
	}
	defer pool.Close()

	runContext, stopRun := context.WithCancel(context.Background())
	// A handler returns when the probe stops, before the workers drain, or when the worker cancels
	// the attempt. A handler with a time also returns after it.
	stopped := make(chan struct{})
	handler := func(ctx context.Context, payload any, _ *workhorse.HandlerContext) (any, error) {
		if handlerMs, ok := payloadHandlerMs(payload); ok {
			select {
			case <-time.After(time.Duration(handlerMs) * time.Millisecond):
			case <-stopped:
			case <-ctx.Done():
			}
			return nil, nil
		}
		select {
		case <-stopped:
		case <-ctx.Done():
		}
		return nil, nil
	}
	var group sync.WaitGroup
	for index := range workers {
		worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
			Queue:             queue,
			WorkerID:          fmt.Sprintf("wh-bench-go-%d-%d", os.Getpid(), index),
			Concurrency:       count("WH_BENCH_CONCURRENCY"),
			HeartbeatInterval: time.Duration(count("WH_BENCH_HEARTBEAT_MS")) * time.Millisecond,
			LeaseDuration:     time.Duration(count("WH_BENCH_LEASE_MS")) * time.Millisecond,
			// Zero keeps the default polling interval.
			PollInterval:        time.Duration(pollMs) * time.Millisecond,
			ShutdownGracePeriod: time.Duration(shutdownGraceMs) * time.Millisecond,
		})
		if err != nil {
			emit(map[string]any{"event": "worker_error", "worker": index, "error": err.Error()})
			continue
		}
		worker.Handle(setting("WH_BENCH_TASK_TYPE"), handler)
		group.Add(1)
		go func() {
			defer group.Done()
			if err := worker.Run(runContext); err != nil {
				emit(map[string]any{"event": "worker_error", "worker": index, "error": err.Error()})
			}
		}()
	}
	emit(map[string]any{
		"event":           "started",
		"sdk":             "go",
		"workers":         workers,
		"pollMs":          nullable(pollMs),
		"shutdownGraceMs": shutdownGraceMs,
		"grace":           "ShutdownGracePeriod",
	})

	// The pool state, seen from inside the process. pgxpool counts no current waiters, so
	// "waiting" is null. EmptyAcquireCount counts the acquires that had to wait, since the start.
	reporting := make(chan struct{})
	reported := make(chan struct{})
	go func() {
		defer close(reported)
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-reporting:
				return
			case <-ticker.C:
				stat := pool.Stat()
				emit(map[string]any{
					"event":          "pool",
					"total":          stat.TotalConns(),
					"idle":           stat.IdleConns(),
					"checkedOut":     stat.AcquiredConns(),
					"waiting":        nil,
					"max":            stat.MaxConns(),
					"waitedAcquires": stat.EmptyAcquireCount(),
				})
			}
		}
	}()

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, os.Interrupt)
	<-signals
	close(reporting)
	<-reported
	// Stop claims first, then let the handlers return.
	stopRun()
	close(stopped)
	group.Wait()
	emit(map[string]any{"event": "stopped"})
}
