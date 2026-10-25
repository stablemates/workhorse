package workhorse_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

// delayProxy forwards TCP connections to PostgreSQL. It delays each write from the client to the
// server by delay and keeps their order, so PostgreSQL sees an idle gap of delay before each
// statement. The writes from the server to the client are not delayed.
type delayProxy struct {
	listener net.Listener
	network  string
	target   string
	delay    time.Duration
	mu       sync.Mutex
	conns    []net.Conn
	closed   bool
	wait     sync.WaitGroup
}

// startDelayProxy starts a proxy in front of the PostgreSQL server of config and points config at
// it. The test cleanup stops the proxy.
func startDelayProxy(t *testing.T, config *pgxpool.Config, delay time.Duration) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	host, port := config.ConnConfig.Host, config.ConnConfig.Port
	proxy := &delayProxy{
		listener: listener, network: "tcp", target: net.JoinHostPort(host, strconv.Itoa(int(port))), delay: delay,
	}
	if strings.HasPrefix(host, "/") {
		proxy.network, proxy.target = "unix", fmt.Sprintf("%s/.s.PGSQL.%d", host, port)
	}
	proxy.wait.Go(proxy.accept)
	t.Cleanup(proxy.close)
	address := listener.Addr().(*net.TCPAddr)
	config.ConnConfig.Host = address.IP.String()
	config.ConnConfig.Port = uint16(address.Port)
	// The proxied connections do not use TLS (sslmode=disable). With sslmode=prefer, pgx keeps the
	// plain connection as a fallback, and a server without TLS, as in CI, refuses the TLS attempt.
	// The test measures round trips, so the same plain connection is right against every server.
	config.ConnConfig.TLSConfig = nil
	config.ConnConfig.Fallbacks = nil
}

func (proxy *delayProxy) track(conn net.Conn) bool {
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	if proxy.closed {
		_ = conn.Close()
		return false
	}
	proxy.conns = append(proxy.conns, conn)
	return true
}

func (proxy *delayProxy) accept() {
	for {
		client, err := proxy.listener.Accept()
		if err != nil {
			return
		}
		if !proxy.track(client) {
			return
		}
		server, err := net.Dial(proxy.network, proxy.target)
		if err != nil {
			_ = client.Close()
			continue
		}
		if !proxy.track(server) {
			_ = client.Close()
			return
		}
		proxy.wait.Go(func() {
			_, _ = io.Copy(client, server)
			_ = client.Close()
			_ = server.Close()
		})
		proxy.wait.Go(func() { proxy.forwardDelayed(server, client) })
	}
}

// forwardDelayed writes each chunk that it reads from source to destination delay after it read
// the chunk, in the order it read them.
func (proxy *delayProxy) forwardDelayed(destination, source net.Conn) {
	type chunk struct {
		data []byte
		at   time.Time
	}
	chunks := make(chan chunk, 1024)
	proxy.wait.Go(func() {
		defer close(chunks)
		for {
			buffer := make([]byte, 32*1024)
			read, err := source.Read(buffer)
			if read > 0 {
				chunks <- chunk{data: buffer[:read], at: time.Now().Add(proxy.delay)}
			}
			if err != nil {
				return
			}
		}
	})
	for next := range chunks {
		time.Sleep(time.Until(next.at))
		if _, err := destination.Write(next.data); err != nil {
			break
		}
	}
	_ = destination.Close()
	_ = source.Close()
	for range chunks {
	}
}

func (proxy *delayProxy) close() {
	_ = proxy.listener.Close()
	proxy.mu.Lock()
	proxy.closed = true
	for _, conn := range proxy.conns {
		_ = conn.Close()
	}
	proxy.mu.Unlock()
	proxy.wait.Wait()
}

// SM-1633: eight workers on one pool share one heartbeat connection, and each round trip takes
// 80 ms. When each worker sent its own transaction, the rounds of the pool needed more round trips
// than the lease allows, and PostgreSQL ended the session at its idle timeout. The rounds that wait
// now share one transaction, so every handler that outlives its lease keeps it.
func TestManyWorkersOnASmallPoolKeepEveryLeaseWhenEachRoundTripTakes80Ms(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-heartbeat-pool-delay")
	ctx := context.Background()
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	// The test measures round trips, not the disk. A server that other test runs share can take
	// seconds to flush a COMMIT, so the scratch database does not wait for the flush.
	if _, err := observeDatabase(t, ctx, databaseURL).Exec(ctx, fmt.Sprintf(
		"ALTER DATABASE %s SET synchronous_commit = off",
		pgx.Identifier{config.ConnConfig.Database}.Sanitize(),
	)); err != nil {
		t.Fatal(err)
	}
	config.MaxConns = 6
	startDelayProxy(t, config, 80*time.Millisecond)
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	operator, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(operator.Close)

	const (
		queueName   = "go-worker-heartbeat-pool-delay"
		workers     = 8
		concurrency = 2
		tasks       = 2 * workers * concurrency
	)
	var startsMu sync.Mutex
	starts := make(map[string]int)
	results := make([]chan error, 0, workers)
	runContext, stop := context.WithCancel(ctx)
	t.Cleanup(func() {
		stop()
		for _, result := range results {
			if err := awaitSignal(t, result, "each Run to return after the stop"); err != nil && !errors.Is(err, context.Canceled) {
				t.Error(err)
			}
		}
	})
	for index := range workers {
		worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
			Queue:             queueName,
			WorkerID:          fmt.Sprintf("heartbeat-pool-delay-worker-%d", index),
			Concurrency:       concurrency,
			LeaseDuration:     3 * time.Second,
			HeartbeatInterval: time.Second,
			PollInterval:      100 * time.Millisecond,
		})
		if err != nil {
			t.Fatal(err)
		}
		worker.Handle("sleep", func(ctx context.Context, _ any, handler *workhorse.HandlerContext) (any, error) {
			startsMu.Lock()
			starts[handler.Task.ID]++
			startsMu.Unlock()
			// The handler outlives the lease, so it succeeds only while the heartbeats renew it.
			select {
			case <-time.After(4 * time.Second):
				return nil, nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		})
		result := make(chan error, 1)
		results = append(results, result)
		go func() { result <- worker.Run(runContext) }()
	}

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(operator), queueName)
	ids := make([]string, 0, tasks)
	for range tasks {
		id, err := queue.Enqueue(ctx, "sleep", nil)
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}

	deadline := time.Now().Add(90 * time.Second)
	for {
		var settled int
		if err := operator.QueryRow(
			ctx, "SELECT count(*) FROM workhorse.task_outcome WHERE task_id = ANY($1::uuid[])", ids,
		).Scan(&settled); err != nil {
			t.Fatal(err)
		}
		if settled == tasks {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d of %d tasks settled before the deadline", settled, tasks)
		}
		time.Sleep(200 * time.Millisecond)
	}
	rows, err := operator.Query(
		ctx,
		"SELECT task_id::text, state, current_attempt FROM workhorse.task_outcome WHERE task_id = ANY($1::uuid[])",
		ids,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, state string
		var attempt int
		if err := rows.Scan(&id, &state, &attempt); err != nil {
			t.Fatal(err)
		}
		if state != "succeeded" || attempt != 1 {
			t.Errorf("task %s ended %s after attempt %d; want succeeded after attempt 1", id, state, attempt)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	startsMu.Lock()
	defer startsMu.Unlock()
	for _, id := range ids {
		if starts[id] != 1 {
			t.Errorf("the handler of task %s started %d times; want once, with no lost lease", id, starts[id])
		}
	}
}

// SM-1633: a worker with the smallest supported interval, 100 ms, on a database 60 ms away. A new
// heartbeat connection prepares two statements, so its preparation takes about 120 ms. When the
// preparation had a bound of one interval, it never finished, the pool never got its heartbeat
// connection, and the worker refused to start. The preparation now has the bound of the startup
// budget, so the worker starts and keeps its lease.
func TestAWorkerWithTheSmallestIntervalStartsWhenEachRoundTripTakes60Ms(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-heartbeat-prepare-delay")
	ctx := context.Background()
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.MaxConns = 4
	startDelayProxy(t, config, 60*time.Millisecond)
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	queueName := "go-worker-heartbeat-prepare-delay"
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
	taskID, err := queue.Enqueue(ctx, "prepare-delay", nil)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:             queueName,
		WorkerID:          "prepare-delay-worker",
		LeaseDuration:     3 * time.Second,
		HeartbeatInterval: 100 * time.Millisecond,
		PollInterval:      50 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	worker.Handle("prepare-delay", func(_ context.Context, _ any, _ *workhorse.HandlerContext) (any, error) {
		return nil, nil
	})
	processed, err := worker.RunOnce(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !processed {
		t.Fatal("the worker did not process the task")
	}
	var state string
	if err := observeDatabase(t, ctx, databaseURL).QueryRow(
		ctx, "SELECT state FROM workhorse.task_outcome WHERE task_id = $1::uuid", taskID,
	).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if state != "succeeded" {
		t.Fatalf("the task ended %s; want succeeded", state)
	}
}
