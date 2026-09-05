I read the Workhorse docs (`/llms.txt` → `for-ai-agents.md`, `installation.md`, `enqueue.md`, `workers.md`, `durable-execution.md`, `retries.md`, `api.md`, `examples.md`). Here is the complete Go code.

---

## `internal/jobs/jobs.go` — shared names and payload contract

```go
package jobs

import "encoding/json"

const (
	// QueueName is the queue the confirmation-email worker claims from.
	// A separate queue keeps provider-bound work off your other lanes.
	QueueName = "email"

	// TypeOrderConfirmation is the job type. Handler registration must match it exactly.
	TypeOrderConfirmation = "email.order_confirmation"

	// CheckpointSend names the durable boundary around the provider call.
	// Workhorse restarts handlers from the top; this name is program state.
	// Renaming it makes in-flight jobs re-send. Never change it.
	CheckpointSend = "send-confirmation-email"

	// IdempotencyScope namespaces the enqueue idempotency key.
	IdempotencyScope = "order-confirmation"
)

// OrderConfirmationPayload is the JSON payload carried by the job.
// Workhorse stores it as JSON, so handlers receive it as `any` and decode it.
type OrderConfirmationPayload struct {
	OrderID       string `json:"orderId"`
	CustomerEmail string `json:"customerEmail"`
	Locale        string `json:"locale,omitempty"`
}

// Map renders the payload as the map[string]any that Queue.Enqueue accepts.
func (p OrderConfirmationPayload) Map() map[string]any {
	return map[string]any{
		"orderId":       p.OrderID,
		"customerEmail": p.CustomerEmail,
		"locale":        p.Locale,
	}
}

// DecodePayload converts the decoded-JSON handler payload into a struct.
func DecodePayload(payload any, target any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, target)
}
```

---

## `internal/orders/create.go` — enqueue alongside the existing order write

```go
package orders

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"

	"yourapp/internal/jobs"
)

// EnqueueConfirmationEmail adds the background job to a transaction you already
// have open. This is the whole point of Workhorse: the job is one more row in
// your transaction, so it exists exactly when the order does. No outbox table,
// no relay process.
//
// Drop this call next to your existing INSERT, inside the same tx.
func EnqueueConfirmationEmail(
	ctx context.Context,
	tx pgx.Tx,
	payload jobs.OrderConfirmationPayload,
) (string, error) {
	if payload.OrderID == "" || payload.CustomerEmail == "" {
		return "", fmt.Errorf("orders: orderId and customerEmail are required")
	}

	// NewPGXExecutor(tx) binds the queue to the caller's transaction.
	// Workhorse never commits, rolls back, or closes what you hand it.
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(tx), jobs.QueueName)

	return queue.Enqueue(ctx, jobs.TypeOrderConfirmation, payload.Map(), workhorse.EnqueueOptions{
		// Attempt budget. Enforced in SQL — no client can create extra attempts.
		MaxAttempts: 5,

		// Decorrelated jitter is the right policy for anything that talks to an
		// external service: when a thousand jobs fail together, their wake times
		// spread out instead of stampeding the recovering provider.
		RetryPolicy: map[string]any{
			"type":         "decorrelated-jitter",
			"baseDelayMs":  1_000,
			"maxDelayMs":   60_000,
		},

		// Bounds one attempt. A hung provider socket loses the lease instead of
		// pinning a worker slot forever. Independent of the attempt budget.
		ExecutionTimeoutMS: 30_000,

		// If the same order write is replayed (retried API request, at-least-once
		// upstream), this returns the original job ID instead of a second email job.
		// A replay with a materially different payload returns a typed conflict error.
		Idempotency: &workhorse.Idempotency{
			Key:   "order-confirmation:" + payload.OrderID,
			Scope: jobs.IdempotencyScope,
			TTLMS: 7 * 24 * 60 * 60 * 1000, // 7 days
		},

		Tags: []string{"order:" + payload.OrderID},
	})
}

// CreateOrder shows the full shape if you want to see where the enqueue sits.
// If your application already has this transaction, keep it and call
// EnqueueConfirmationEmail inside it — that is the only change you need.
func CreateOrder(
	ctx context.Context,
	pool *pgxpool.Pool,
	orderID string,
	customerEmail string,
	totalCents int,
) (string, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx) // No-op after a successful Commit.

	if _, err := tx.Exec(ctx,
		"INSERT INTO orders (id, customer_email, total_cents, status) VALUES ($1, $2, $3, $4)",
		orderID, customerEmail, totalCents, "new",
	); err != nil {
		return "", err
	}

	jobID, err := EnqueueConfirmationEmail(ctx, tx, jobs.OrderConfirmationPayload{
		OrderID:       orderID,
		CustomerEmail: customerEmail,
		Locale:        "en-US",
	})
	if err != nil {
		return "", err
	}

	// COMMIT: the order and its job appear together.
	// ROLLBACK: neither exists, so nothing needs cleanup.
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return jobID, nil
}
```

---

## `internal/email/provider.go` — the external HTTP provider client

```go
package email

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Provider is a minimal client for an external transactional-email HTTP API.
type Provider struct {
	BaseURL string
	APIKey  string
	Client  *http.Client
}

func NewProvider(baseURL, apiKey string) *Provider {
	return &Provider{
		BaseURL: baseURL,
		APIKey:  apiKey,
		Client:  &http.Client{Timeout: 20 * time.Second},
	}
}

type SendRequest struct {
	To       string `json:"to"`
	Template string `json:"template"`
	OrderID  string `json:"orderId"`
	Locale   string `json:"locale,omitempty"`
}

type sendResponse struct {
	ID string `json:"id"`
}

// Send posts one message. idempotencyKey is derived from the order, so a
// duplicate call — the rare case where the process dies after the HTTP call but
// before the checkpoint commits — is absorbed by the provider, not by luck.
//
// ctx is the handler's context: Workhorse cancels it on a cancellation request,
// a deadline, or the execution timeout, which aborts the in-flight request.
func (p *Provider) Send(ctx context.Context, idempotencyKey string, message SendRequest) (string, error) {
	body, err := json.Marshal(message)
	if err != nil {
		return "", err
	}

	request, err := http.NewRequestWithContext(
		ctx, http.MethodPost, p.BaseURL+"/v1/messages", bytes.NewReader(body),
	)
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+p.APIKey)
	request.Header.Set("Idempotency-Key", idempotencyKey)

	response, err := p.Client.Do(request)
	if err != nil {
		// Transport failure: returning an error fails this attempt, and the
		// persisted retry policy schedules the next one.
		return "", fmt.Errorf("email provider request failed: %w", err)
	}
	defer response.Body.Close()

	payload, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return "", fmt.Errorf("email provider read failed: %w", err)
	}

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		// Every non-2xx fails the attempt. The attempt budget bounds how many
		// times a permanently-bad request is retried; after that the job lands
		// in dead letters with this message as evidence.
		return "", fmt.Errorf(
			"email provider returned %d: %s", response.StatusCode, string(payload),
		)
	}

	var decoded sendResponse
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return "", fmt.Errorf("email provider returned unreadable body: %w", err)
	}
	if decoded.ID == "" {
		return "", fmt.Errorf("email provider returned no message id")
	}
	return decoded.ID, nil
}
```

---

## `internal/email/handler.go` — the worker handler

```go
package email

import (
	"context"
	"fmt"

	workhorse "github.com/stablemates/workhorse/go"

	"yourapp/internal/jobs"
)

// Register binds the confirmation-email handler to the worker.
func Register(worker *workhorse.Worker, provider *Provider) {
	worker.Handle(jobs.TypeOrderConfirmation, func(
		ctx context.Context,
		payload any,
		handler *workhorse.HandlerContext,
	) (any, error) {
		var message jobs.OrderConfirmationPayload
		if err := jobs.DecodePayload(payload, &message); err != nil {
			return nil, fmt.Errorf("order confirmation payload is not decodable: %w", err)
		}
		if message.OrderID == "" || message.CustomerEmail == "" {
			return nil, fmt.Errorf("order confirmation payload needs orderId and customerEmail")
		}

		// Handlers restart from the top after a retry, a crash, or a redeploy.
		// The checkpoint runs the send once and persists its JSON result; every
		// later activation replays that stored value without calling the provider.
		//
		// The checkpoint commits *after* the send, so a process that dies in
		// between can still repeat the call — that is why Send also carries a
		// provider idempotency key. Checkpoint makes repeats rare; the key makes
		// them harmless.
		sent, err := handler.Checkpoint(jobs.CheckpointSend, func() (any, error) {
			messageID, sendErr := provider.Send(
				ctx,
				"order-confirmation:"+message.OrderID,
				SendRequest{
					To:       message.CustomerEmail,
					Template: "order-confirmation",
					OrderID:  message.OrderID,
					Locale:   message.Locale,
				},
			)
			if sendErr != nil {
				return nil, sendErr
			}
			// Return JSON-shaped values only: this is what gets stored and replayed.
			return map[string]any{
				"providerMessageId": messageID,
				"to":                message.CustomerEmail,
			}, nil
		})
		if err != nil {
			return nil, err
		}

		// On replay this is the decoded stored JSON, so read it as a map — never
		// type-assert a checkpoint result back to your own struct type.
		receipt, ok := sent.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("checkpoint %q did not store an object", jobs.CheckpointSend)
		}
		providerMessageID, _ := receipt["providerMessageId"].(string)

		return map[string]any{
			"orderId":           message.OrderID,
			"deliveredTo":       message.CustomerEmail,
			"providerMessageId": providerMessageID,
		}, nil
	})
}
```

---

## `cmd/worker/main.go` — the worker process

```go
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"

	"yourapp/internal/email"
	"yourapp/internal/jobs"
)

func main() {
	if err := run(); err != nil {
		log.Fatalf("worker exited: %v", err)
	}
}

func run() error {
	// The first SIGTERM/SIGINT stops claiming and drains active handlers.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := pgxpool.New(ctx, mustEnv("DATABASE_URL"))
	if err != nil {
		return err
	}
	defer pool.Close()

	// Runtime processes verify the schema; they never install it. Installation is
	// the deployment command listed below.
	if err := workhorse.AssertSchemaCompatible(ctx, workhorse.NewPGXExecutor(pool)); err != nil {
		return fmt.Errorf("workhorse schema is not compatible with this build: %w", err)
	}

	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queues:        []string{jobs.QueueName},
		Concurrency:   8,                // simultaneous handlers in this process
		LeaseDuration: 30 * time.Second, // how long a claim owns a job before recovery
	})
	if err != nil {
		return err
	}

	provider := email.NewProvider(
		mustEnv("EMAIL_PROVIDER_URL"),
		mustEnv("EMAIL_PROVIDER_API_KEY"),
	)
	email.Register(worker, provider)

	log.Printf("workhorse worker running on queue %q", jobs.QueueName)
	return worker.Run(ctx) // Loops until ctx is cancelled, then drains.
}

func mustEnv(name string) string {
	value := os.Getenv(name)
	if value == "" {
		log.Fatalf("%s is required", name)
	}
	return value
}
```

---

## `internal/orders/status.go` — optional: confirm a job settled

```go
package orders

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

// ConfirmationEmailStatus reads the durable outcome of the job by its ID.
// A settled job reports its state and result; until then it reports the state
// it is in, which is how you tell a slow worker from a missing one.
func ConfirmationEmailStatus(
	ctx context.Context,
	pool *pgxpool.Pool,
	jobID string,
) (string, any, error) {
	admin := workhorse.NewAdmin(workhorse.NewPGXExecutor(pool))
	job, err := admin.GetJob(ctx, jobID)
	if err != nil || job == nil {
		return "", nil, err
	}
	return string(job.State), job.Result, nil
}
```

Two notes worth keeping in review: the enqueue must stay **inside** your existing order transaction (an enqueue on the pool commits even when the order rolls back, and a worker then emails about an order that does not exist), and the schema install must stay a **deployment** step, never application startup.

```install
go get github.com/stablemates/workhorse/go
go get github.com/jackc/pgx/v5
npx --package @stablemates/workhorse@0.1.0 workhorse schema install
```
