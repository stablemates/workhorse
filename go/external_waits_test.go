package workhorse_test

import (
	"context"
	"errors"
	"os/exec"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

func TestSignalWaitSuspendsAndReplaysDeliveredPayload(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-signal-wait")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-signal-wait")
	jobID, err := queue.Enqueue(ctx, "signal.approval", nil)
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-signal-wait", WorkerID: "go-signal-worker", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}

	handlerCalls := 0
	worker.Handle("signal.approval", func(
		_ context.Context,
		_ any,
		handler *workhorse.HandlerContext,
	) (any, error) {
		handlerCalls++
		payload, err := handler.WaitForSignal("approval")
		if err != nil {
			return nil, err
		}
		return map[string]any{"approval": payload}, nil
	})

	if processed, err := worker.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("suspend signal wait: processed=%t err=%v", processed, err)
	}
	deliverSignalFromTypeScript(t, databaseURL, jobID)
	delivery, err := queue.SendSignal(
		ctx,
		jobID,
		"approval",
		map[string]any{"approved": true},
		workhorse.ExternalWaitDelivery{IdempotencyKey: "approval-delivery", RequestedBy: "typescript-billing-service"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if delivery.Status != workhorse.SignalDuplicate ||
		!reflect.DeepEqual(delivery.Payload, map[string]any{"approved": true}) {
		t.Fatalf("unexpected signal delivery: %#v", delivery)
	}
	_, err = queue.SendSignal(
		ctx,
		jobID,
		"approval",
		map[string]any{"approved": false},
		workhorse.ExternalWaitDelivery{IdempotencyKey: "approval-delivery", RequestedBy: "typescript-billing-service"},
	)
	var signalConflict *workhorse.SignalIdempotencyConflictError
	if !errors.As(err, &signalConflict) || signalConflict.JobID != jobID || signalConflict.WaitName != "approval" {
		t.Fatalf("unexpected signal conflict: %#v", err)
	}
	if processed, err := worker.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("replay signal wait: processed=%t err=%v", processed, err)
	}
	if handlerCalls != 2 {
		t.Fatalf("expected two handler activations, received %d", handlerCalls)
	}

	var state string
	var result any
	if err := pool.QueryRow(
		ctx,
		"SELECT state, result FROM workhorse.job_outcome WHERE job_id = $1",
		jobID,
	).Scan(&state, &result); err != nil {
		t.Fatal(err)
	}
	if state != "succeeded" || !reflect.DeepEqual(result, map[string]any{
		"approval": map[string]any{"approved": true},
	}) {
		t.Fatalf("unexpected signal outcome: state=%s result=%#v", state, result)
	}
}

func deliverSignalFromTypeScript(t *testing.T, databaseURL, jobID string) {
	t.Helper()
	command := exec.Command(
		"pnpm",
		"exec",
		"tsx",
		"typescript/core/test/go-interop-signal.ts",
		databaseURL,
		jobID,
	)
	command.Dir = ".."
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("TypeScript signal delivery failed: %v: %s", err, output)
	}
}

func TestHumanWaitSuspendsAndReplaysCompletedDecision(t *testing.T) {
	databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-human-wait")
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "go-human-wait")
	jobID, err := queue.Enqueue(ctx, "account.review", map[string]any{"accountId": "account-42"})
	if err != nil {
		t.Fatal(err)
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue: "go-human-wait", WorkerID: "go-human-worker", LeaseDuration: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}

	handlerCalls := 0
	worker.Handle("account.review", func(
		_ context.Context,
		payload any,
		handler *workhorse.HandlerContext,
	) (any, error) {
		handlerCalls++
		accountID := payload.(map[string]any)["accountId"]
		decision, err := handler.WaitForHuman("review", map[string]any{
			"accountId": accountID,
			"prompt":    "Approve this account?",
		})
		if err != nil {
			return nil, err
		}
		return map[string]any{"decision": decision}, nil
	})

	if processed, err := worker.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("suspend human wait: processed=%t err=%v", processed, err)
	}
	completeHumanWaitFromDashboard(t, databaseURL, jobID)
	completion, err := queue.CompleteHumanWait(
		ctx,
		jobID,
		"review",
		map[string]any{"approved": true},
		workhorse.ExternalWaitDelivery{IdempotencyKey: "review-completion", RequestedBy: "dashboard-go-interop"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if completion.Status != workhorse.HumanWaitDuplicate ||
		!reflect.DeepEqual(completion.Payload, map[string]any{"approved": true}) {
		t.Fatalf("unexpected human wait completion: %#v", completion)
	}
	_, err = queue.CompleteHumanWait(
		ctx,
		jobID,
		"review",
		map[string]any{"approved": false},
		workhorse.ExternalWaitDelivery{IdempotencyKey: "review-completion", RequestedBy: "dashboard-go-interop"},
	)
	var humanConflict *workhorse.HumanWaitIdempotencyConflictError
	if !errors.As(err, &humanConflict) || humanConflict.JobID != jobID || humanConflict.WaitName != "review" {
		t.Fatalf("unexpected human wait conflict: %#v", err)
	}
	if processed, err := worker.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("replay human wait: processed=%t err=%v", processed, err)
	}
	if handlerCalls != 2 {
		t.Fatalf("expected two handler activations, received %d", handlerCalls)
	}

	var state string
	var result any
	if err := pool.QueryRow(
		ctx,
		"SELECT state, result FROM workhorse.job_outcome WHERE job_id = $1",
		jobID,
	).Scan(&state, &result); err != nil {
		t.Fatal(err)
	}
	if state != "succeeded" || !reflect.DeepEqual(result, map[string]any{
		"decision": map[string]any{"approved": true},
	}) {
		t.Fatalf("unexpected human wait outcome: state=%s result=%#v", state, result)
	}
}

func completeHumanWaitFromDashboard(t *testing.T, databaseURL, jobID string) {
	t.Helper()
	command := exec.Command(
		"pnpm",
		"exec",
		"tsx",
		"--conditions=workhorse-source",
		"typescript/dashboard-server/test/go-interop-human-dashboard.ts",
		databaseURL,
		jobID,
	)
	command.Dir = ".."
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("dashboard human completion failed: %v: %s", err, output)
	}
}

func TestExternalWaitDeadlinesProduceDurableDeadlineOutcome(t *testing.T) {
	tests := []struct {
		name string
		wait func(*workhorse.HandlerContext) (any, error)
	}{
		{
			name: "signal",
			wait: func(handler *workhorse.HandlerContext) (any, error) {
				return handler.WaitForSignal("approval", workhorse.ExternalWaitOptions{Timeout: 40 * time.Millisecond})
			},
		},
		{
			name: "human",
			wait: func(handler *workhorse.HandlerContext) (any, error) {
				return handler.WaitForHuman(
					"review",
					map[string]any{"prompt": "Review?"},
					workhorse.ExternalWaitOptions{Timeout: 40 * time.Millisecond},
				)
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			databaseURL := createConformanceDatabase(t, testDatabaseURL(t), "worker-"+test.name+"-timeout")
			ctx := context.Background()
			pool, err := pgxpool.New(ctx, databaseURL)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(pool.Close)

			queueName := "go-" + test.name + "-timeout"
			queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), queueName)
			jobID, err := queue.Enqueue(ctx, test.name+".timeout", nil)
			if err != nil {
				t.Fatal(err)
			}
			worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
				Queue: queueName, WorkerID: queueName + "-worker", LeaseDuration: time.Second,
			})
			if err != nil {
				t.Fatal(err)
			}
			worker.Handle(test.name+".timeout", func(
				_ context.Context,
				_ any,
				handler *workhorse.HandlerContext,
			) (any, error) {
				return test.wait(handler)
			})

			if processed, err := worker.RunOnce(ctx); err != nil || !processed {
				t.Fatalf("suspend external wait: processed=%t err=%v", processed, err)
			}
			time.Sleep(60 * time.Millisecond)
			if processed, err := worker.RunOnce(ctx); err != nil || processed {
				t.Fatalf("terminalize external wait: processed=%t err=%v", processed, err)
			}

			var state, errorName string
			if err := pool.QueryRow(
				ctx,
				"SELECT state, error->>'name' FROM workhorse.job_outcome WHERE job_id = $1",
				jobID,
			).Scan(&state, &errorName); err != nil {
				t.Fatal(err)
			}
			if state != "failed" || errorName != "DeadlineExceeded" {
				t.Fatalf("unexpected timeout outcome: state=%s error=%s", state, errorName)
			}
		})
	}
}
