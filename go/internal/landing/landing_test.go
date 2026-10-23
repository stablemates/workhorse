package example

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
	"github.com/stablemates/workhorse/go/internal/testdatabase"
)

// Each other file in this directory is one Go snippet of the landing page, byte for byte.
// site/scripts/check-language-examples.ts fails when a file and its snippet in
// site/lib/landing-snippets.ts differ. These tests call each snippet on a scratch database, so a
// snippet that sends a value PostgreSQL refuses fails here.

// How long a test waits for a task to reach a state.
const landingWait = 20 * time.Second

type landing struct {
	t     *testing.T
	ctx   context.Context
	pool  *pgxpool.Pool
	queue *workhorse.Queue
	admin *workhorse.Admin
}

func newLanding(t *testing.T) *landing {
	t.Helper()
	sourceURL := testdatabase.SourceURL(t)
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, createLandingDatabase(t, sourceURL))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	executor := workhorse.NewPGXExecutor(pool)
	return &landing{
		t:     t,
		ctx:   ctx,
		pool:  pool,
		queue: workhorse.NewQueue(executor, "default"),
		admin: workhorse.NewAdmin(executor),
	}
}

// worker is a polling worker on queues that claims at once.
func (l *landing) worker(queues ...string) *workhorse.Worker {
	l.t.Helper()
	worker, err := workhorse.NewWorker(l.pool, workhorse.WorkerOptions{
		Queues:          queues,
		Concurrency:     3,
		PollingOnly:     true,
		PollInterval:    20 * time.Millisecond,
		DisableRegistry: true,
	})
	if err != nil {
		l.t.Fatal(err)
	}
	return worker
}

func (l *landing) enqueue(taskType string, payload any, options ...workhorse.EnqueueOptions) string {
	l.t.Helper()
	taskID, err := l.queue.Enqueue(l.ctx, taskType, payload, options...)
	if err != nil {
		l.t.Fatal(err)
	}
	return taskID
}

func (l *landing) task(taskID string) *workhorse.TaskSnapshot {
	l.t.Helper()
	task, err := l.admin.GetTask(l.ctx, taskID)
	if err != nil {
		l.t.Fatal(err)
	}
	if task == nil {
		l.t.Fatalf("task %s does not exist", taskID)
	}
	return task
}

// drain runs worker once at a time until the task reaches state.
func (l *landing) drain(worker *workhorse.Worker, taskID string, state workhorse.TaskState) {
	l.t.Helper()
	deadline := time.Now().Add(landingWait)
	for l.task(taskID).State != state {
		if time.Now().After(deadline) {
			l.t.Fatalf("task %s is %s, want %s", taskID, l.task(taskID).State, state)
		}
		ran, err := worker.RunOnce(l.ctx)
		if err != nil {
			l.t.Fatal(err)
		}
		if !ran {
			time.Sleep(20 * time.Millisecond)
		}
	}
}

// taskOfType waits until a task of taskType reaches state, and returns it.
func (l *landing) taskOfType(taskType string, state workhorse.TaskState) *workhorse.TaskSnapshot {
	l.t.Helper()
	deadline := time.Now().Add(landingWait)
	for {
		var taskID string
		err := l.pool.QueryRow(l.ctx,
			"SELECT id::text FROM workhorse.task WHERE task_type = $1", taskType,
		).Scan(&taskID)
		if err == nil {
			if task := l.task(taskID); task.State == state {
				return task
			}
		} else if err != pgx.ErrNoRows {
			l.t.Fatal(err)
		}
		if time.Now().After(deadline) {
			l.t.Fatalf("no %s task reached %s", taskType, state)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// process starts a snippet that runs until its context ends. The returned function stops it and
// fails the test if it stopped early or with an error other than the cancellation.
func (l *landing) process(run func(context.Context) error) func() {
	ctx, cancel := context.WithCancel(l.ctx)
	done := make(chan error, 1)
	go func() { done <- run(ctx) }()
	return func() {
		l.t.Helper()
		select {
		case err := <-done:
			l.t.Fatalf("the snippet stopped early: %v", err)
		default:
		}
		cancel()
		select {
		case err := <-done:
			if err != nil && !errors.Is(err, context.Canceled) {
				l.t.Fatalf("the snippet stopped with an error: %v", err)
			}
		case <-time.After(landingWait):
			l.t.Fatal("the snippet did not stop after its context ended")
		}
	}
}

func sameJSON(t *testing.T, got any, want any) {
	t.Helper()
	gotJSON, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	wantJSON, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	if string(gotJSON) != string(wantJSON) {
		t.Fatalf("got %s, want %s", gotJSON, wantJSON)
	}
}

func TestHeroEnqueuesAndCompletesAWelcomeEmail(t *testing.T) {
	l := newLanding(t)
	stop := l.process(func(ctx context.Context) error { return run(ctx, l.pool) })
	task := l.taskOfType("email.welcome", workhorse.TaskSucceeded)
	stop()
	sameJSON(t, task.Result, map[string]any{"deliveredTo": "ada@example.com"})
}

func TestLanguageEnqueuesAWelcomeEmail(t *testing.T) {
	l := newLanding(t)
	if err := enqueueWelcome(l.ctx, l.pool); err != nil {
		t.Fatal(err)
	}
	sameJSON(t, l.taskOfType("email.welcome", workhorse.TaskReady).Payload, map[string]any{"to": "ada@example.com"})
}

func TestEnqueueCommitsTheOrderAndItsTaskTogether(t *testing.T) {
	l := newLanding(t)
	if _, err := l.pool.Exec(l.ctx, "CREATE TABLE orders (id text PRIMARY KEY, total bigint)"); err != nil {
		t.Fatal(err)
	}
	if err := createOrder(l.ctx, l.pool, "order-1", 42); err != nil {
		t.Fatal(err)
	}
	var total int
	if err := l.pool.QueryRow(l.ctx, "SELECT total FROM orders WHERE id = 'order-1'").Scan(&total); err != nil {
		t.Fatal(err)
	}
	if total != 42 {
		t.Fatalf("total = %d, want 42", total)
	}
	sameJSON(t, l.taskOfType("order.confirm", workhorse.TaskReady).Payload, map[string]any{"orderId": "order-1"})
}

func TestCheckpointsCompleteAnInvoice(t *testing.T) {
	l := newLanding(t)
	worker := l.worker("default")
	registerInvoice(worker)
	invoice := map[string]any{"amount": 5, "email": "ada@example.com"}
	taskID := l.enqueue("invoice.issue", invoice)
	l.drain(worker, taskID, workhorse.TaskSucceeded)
	sameJSON(t, l.task(taskID).Result, map[string]any{"chargeId": "ch_5"})
}

func TestSleepSuspendsTheSettlement(t *testing.T) {
	l := newLanding(t)
	worker := l.worker("default")
	registerSettlement(worker)
	taskID := l.enqueue("order.settle", map[string]any{"orderId": "order-1"})
	l.drain(worker, taskID, workhorse.TaskScheduled)
	if runAt := l.task(taskID).RunAt; runAt.Before(time.Now().Add(59 * time.Minute)) {
		t.Fatalf("the settlement sleeps until %s, want about one hour", runAt)
	}
}

func TestRetriesStoreTheRetryPolicy(t *testing.T) {
	l := newLanding(t)
	taskID, err := enqueueReminder(l.ctx, l.queue, "match-1", time.Now().Add(2*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	task := l.task(taskID)
	sameJSON(t, task.RetryPolicy, map[string]any{
		"initialDelayMs": 1000, "maxDelayMs": 60000, "multiplier": 2, "type": "exponential",
	})
	if task.MaxAttempts != 5 || task.ExecutionTimeoutMS == nil || *task.ExecutionTimeoutMS != 30_000 {
		t.Fatalf("max attempts %d and execution timeout %v, want 5 and 30000", task.MaxAttempts, task.ExecutionTimeoutMS)
	}
}

func TestIdempotencyReturnsTheSameTaskTwice(t *testing.T) {
	l := newLanding(t)
	first, err := captureInvoice(l.ctx, l.queue)
	if err != nil {
		t.Fatal(err)
	}
	second, err := captureInvoice(l.ctx, l.queue)
	if err != nil {
		t.Fatal(err)
	}
	if second != first || l.task(first).Queue != "billing" {
		t.Fatalf("tasks %s and %s in queue %s, want one billing task", first, second, l.task(first).Queue)
	}
}

func TestSchedulesSyncTheScheduleAndRunAWorker(t *testing.T) {
	l := newLanding(t)
	stop := l.process(func(ctx context.Context) error { return runBilling(ctx, l.pool) })
	deadline := time.Now().Add(landingWait)
	var cron, taskType string
	for {
		err := l.pool.QueryRow(l.ctx,
			"SELECT cron_expression, task_type FROM workhorse.schedule_definition WHERE namespace = 'billing' AND schedule_name = 'nightly-invoice-run'",
		).Scan(&cron, &taskType)
		if err == nil {
			break
		}
		if err != pgx.ErrNoRows || time.Now().After(deadline) {
			t.Fatalf("the schedule is not synchronized: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	// The worker runs a maintenance pass before it waits for its context.
	time.Sleep(500 * time.Millisecond)
	stop()
	if cron != "0 2 * * *" || taskType != "invoices.generate" {
		t.Fatalf("schedule %q for %q", cron, taskType)
	}
}

func TestFlowControlStoresItsPoliciesAndEnqueuesMail(t *testing.T) {
	l := newLanding(t)
	if err := configureFlowControl(l.ctx, l.queue, "msg-1", "acme"); err != nil {
		t.Fatal(err)
	}
	var maxActive, maxActivePerKey, limit, interval, burst int
	if err := l.pool.QueryRow(l.ctx,
		"SELECT max_active, max_active_per_key FROM workhorse.concurrency_policy WHERE queue_name = 'mail'",
	).Scan(&maxActive, &maxActivePerKey); err != nil {
		t.Fatal(err)
	}
	if err := l.pool.QueryRow(l.ctx,
		"SELECT rate_limit, rate_interval_ms, rate_burst FROM workhorse.rate_limit_policy WHERE queue_name = 'provider-api'",
	).Scan(&limit, &interval, &burst); err != nil {
		t.Fatal(err)
	}
	if maxActive != 20 || maxActivePerKey != 2 || limit != 100 || interval != 1000 || burst != 200 {
		t.Fatalf("policies %d/%d and %d/%d/%d", maxActive, maxActivePerKey, limit, interval, burst)
	}
	task := l.taskOfType("mail.send", workhorse.TaskReady)
	if task.Queue != "mail" || task.ConcurrencyKey == nil || *task.ConcurrencyKey != "tenant:acme" {
		t.Fatalf("mail task in queue %s with key %v", task.Queue, task.ConcurrencyKey)
	}
}

func TestDependenciesBlockTheConfirmationAndJoinAChild(t *testing.T) {
	l := newLanding(t)
	worker := l.worker("default")
	if err := configureCheckout(l.ctx, l.queue, worker, "order-1"); err != nil {
		t.Fatal(err)
	}
	inventory := l.taskOfType("inventory.reserve", workhorse.TaskReady)
	confirmation := l.taskOfType("order.confirm", workhorse.TaskBlocked)
	if len(confirmation.PrerequisiteTaskIDs) != 1 || confirmation.PrerequisiteTaskIDs[0] != inventory.ID {
		t.Fatalf("prerequisites %v, want %s", confirmation.PrerequisiteTaskIDs, inventory.ID)
	}

	worker.Handle("payment.capture", func(_ context.Context, payload any, _ *workhorse.HandlerContext) (any, error) {
		return map[string]any{"captured": payload}, nil
	})
	taskID := l.enqueue("order.fulfill", map[string]any{"id": "order-1"})
	l.drain(worker, taskID, workhorse.TaskSucceeded)
	sameJSON(t, l.task(taskID).Result, map[string]any{"captured": map[string]any{"id": "order-1"}})
}

func TestCoalescingKeepsTheLatestRevision(t *testing.T) {
	l := newLanding(t)
	if err := reindex(l.ctx, l.queue, "doc-1", 60_000); err != nil {
		t.Fatal(err)
	}
	task := l.taskOfType("search.reindex", workhorse.TaskScheduled)
	sameJSON(t, task.Payload, map[string]any{"documentId": "doc-1", "revision": 2})
}

func TestExternalWaitsResumeWithTheScanAndTheReview(t *testing.T) {
	l := newLanding(t)
	worker := l.worker("default")
	configureRelease(worker)
	taskID := l.enqueue("release.publish", map[string]any{"id": "v1"})
	l.drain(worker, taskID, workhorse.TaskScheduled)

	if err := deliverScan(l.ctx, l.queue, taskID, map[string]any{"clean": true}, "scan-1"); err != nil {
		t.Fatal(err)
	}
	l.drain(worker, taskID, workhorse.TaskScheduled)
	if _, err := l.queue.CompleteHumanWait(l.ctx, taskID, "release-approval", map[string]any{"approved": true},
		workhorse.ExternalWaitDelivery{IdempotencyKey: "review-1", RequestedBy: "landing-test"},
	); err != nil {
		t.Fatal(err)
	}
	l.drain(worker, taskID, workhorse.TaskSucceeded)
	sameJSON(t, l.task(taskID).Result, map[string]any{"published": true})
}

func TestBatchHandlersCompleteEachTaskWithItsPayload(t *testing.T) {
	l := newLanding(t)
	worker := l.worker("default")
	registerEmailBatch(worker, 3, 50*time.Millisecond)
	payloads := map[string]map[string]any{}
	for _, name := range []string{"ada", "grace", "edsger"} {
		payload := map[string]any{"to": name + "@example.com"}
		payloads[l.enqueue("email.send", payload)] = payload
	}
	for taskID, payload := range payloads {
		l.drain(worker, taskID, workhorse.TaskSucceeded)
		sameJSON(t, l.task(taskID).Result, payload)
	}
}

func TestCancellationCancelsTheExportAndRunsTheNextOne(t *testing.T) {
	l := newLanding(t)
	worker := l.worker("default")
	rows := []any{map[string]any{"id": 1}, map[string]any{"id": 2}}
	canceled := l.enqueue("rows.export", rows)
	if err := configureExport(l.ctx, l.queue, worker, canceled); err != nil {
		t.Fatal(err)
	}
	task := l.task(canceled)
	failure, ok := task.Error.(map[string]any)
	if task.State != workhorse.TaskCanceled || !ok ||
		failure["requested_by"] != "operator@example.com" || failure["reason"] != "customer withdrew the request" {
		t.Fatalf("export is %s with error %v", task.State, task.Error)
	}

	taskID := l.enqueue("rows.export", rows)
	l.drain(worker, taskID, workhorse.TaskSucceeded)
	sameJSON(t, l.task(taskID).Result, map[string]any{"stopped": false})
}

// cardDeclined is the failure the dead-letters snippet filters for.
type cardDeclined struct{}

func (cardDeclined) Error() string     { return "the card was declined" }
func (cardDeclined) ErrorName() string { return "CardDeclined" }

func TestDeadLettersRedriveTheDeclinedBillingTask(t *testing.T) {
	l := newLanding(t)
	worker := l.worker("billing")
	worker.Handle("invoice.capture", func(context.Context, any, *workhorse.HandlerContext) (any, error) {
		return nil, cardDeclined{}
	})
	taskID := l.enqueue("invoice.capture", map[string]any{}, workhorse.EnqueueOptions{Queue: "billing", MaxAttempts: 1})
	l.drain(worker, taskID, workhorse.TaskFailed)

	if err := redriveBilling(l.ctx, l.admin); err != nil {
		t.Fatal(err)
	}

	// A redrive leaves the failed task as it is and enqueues a copy of it.
	var copyID string
	if err := l.pool.QueryRow(l.ctx,
		"SELECT id::text FROM workhorse.task WHERE task_type = 'invoice.capture' AND id::text <> $1", taskID,
	).Scan(&copyID); err != nil {
		t.Fatal(err)
	}
	if copied := l.task(copyID); copied.Queue != "billing" || copied.State != workhorse.TaskReady {
		t.Fatalf("the redriven copy is in %s as %s", copied.Queue, copied.State)
	}
}

func TestOperateDashboardServesAnOperatorAndRefusesAStranger(t *testing.T) {
	l := newLanding(t)
	mux := http.NewServeMux()
	if err := mountDashboard(mux, workhorse.NewPGXExecutor(l.pool)); err != nil {
		t.Fatal(err)
	}
	serve := func(actor string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodGet, "/workhorse/", nil)
		if actor != "" {
			request = request.WithContext(context.WithValue(request.Context(), operatorContextKey{}, actor))
		}
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, request)
		return response
	}

	operator := serve("ada")
	stranger := serve("")
	if operator.Code == http.StatusUnauthorized || operator.Code >= http.StatusInternalServerError {
		t.Fatalf("operator status %d: %s", operator.Code, operator.Body)
	}
	if stranger.Code != http.StatusUnauthorized {
		t.Fatalf("stranger status %d, want 401", stranger.Code)
	}
}

func TestOperateHealthReadsHealthAndLiveTasks(t *testing.T) {
	l := newLanding(t)
	l.enqueue("email.send", map[string]any{})
	if err := inspect(l.ctx, l.pool); err != nil {
		t.Fatal(err)
	}
}

func TestOperateFleetPausesOnlyBillingWorkers(t *testing.T) {
	l := newLanding(t)
	var stops []func()
	for _, queue := range []string{"billing", "email"} {
		worker, err := workhorse.NewWorker(l.pool, workhorse.WorkerOptions{
			Queue: queue, WorkerID: queue + "-worker", PollingOnly: true,
		})
		if err != nil {
			t.Fatal(err)
		}
		stops = append(stops, l.process(worker.Run))
	}
	deadline := time.Now().Add(landingWait)
	for {
		workers, err := l.admin.ListWorkers(l.ctx)
		if err != nil {
			t.Fatal(err)
		}
		if len(workers) == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d workers registered, want 2", len(workers))
		}
		time.Sleep(20 * time.Millisecond)
	}

	if err := pauseBilling(l.ctx, l.pool); err != nil {
		t.Fatal(err)
	}

	workers, err := l.admin.ListWorkers(l.ctx)
	if err != nil {
		t.Fatal(err)
	}
	var paused []string
	for _, entry := range workers {
		paused = append(paused, entry.WorkerID+"="+strconv.FormatBool(entry.Paused))
	}
	sort.Strings(paused)
	if strings.Join(paused, ",") != "billing-worker=true,email-worker=false" {
		t.Fatalf("workers %v", paused)
	}
	for _, stop := range stops {
		stop()
	}
}

func TestDeployRunsAnEmailWorker(t *testing.T) {
	l := newLanding(t)
	email := map[string]any{"to": "ada@example.com"}
	l.enqueue("email.send", email, workhorse.EnqueueOptions{Queue: "email"})
	stop := l.process(func(ctx context.Context) error { return runWorker(ctx, l.pool) })
	task := l.taskOfType("email.send", workhorse.TaskSucceeded)
	stop()
	sameJSON(t, task.Result, email)
}

// createLandingDatabase gives one test its own database so it never touches the checkout's shared
// test database.
func createLandingDatabase(t *testing.T, sourceURL string) string {
	t.Helper()
	parsed, err := url.Parse(sourceURL)
	if err != nil {
		t.Fatal(err)
	}
	host := parsed.Hostname()
	if host != "localhost" && host != "127.0.0.1" && host != "::1" {
		t.Fatalf("landing example tests refuse non-loopback database host %q", host)
	}
	sourceName := strings.TrimPrefix(parsed.Path, "/")
	if !strings.Contains(sourceName, "test") {
		t.Fatal("DATABASE_URL_TEST must name a test database")
	}
	digest := fmt.Sprintf("%x", sha256.Sum256([]byte(t.Name()+strconv.Itoa(os.Getpid()))))[:10]
	prefix := sourceName
	if len(prefix) > 44 {
		prefix = prefix[:44]
	}
	databaseName := prefix + "_gt_" + digest

	adminURL := *parsed
	adminURL.Path = "/postgres"
	ctx := context.Background()
	quotedName := pgx.Identifier{databaseName}.Sanitize()
	admin, err := pgx.Connect(ctx, adminURL.String())
	if err != nil {
		t.Fatal(err)
	}
	if err := dropScratchDatabase(ctx, admin, databaseName); err != nil {
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
		if err := dropScratchDatabase(ctx, admin, databaseName); err != nil {
			t.Errorf("drop landing example database: %v; run pnpm db:sweep", err)
		}
	})

	databaseURL := *parsed
	databaseURL.Path = "/" + databaseName
	schema, err := os.ReadFile(filepath.Join("..", "..", "..", "sql", "schema", "current.sql"))
	if err != nil {
		t.Fatal(err)
	}
	connection, err := pgx.Connect(ctx, databaseURL.String())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = connection.Close(ctx) }()
	if _, err := connection.Exec(ctx, string(schema)); err != nil {
		t.Fatal(err)
	}
	return databaseURL.String()
}
