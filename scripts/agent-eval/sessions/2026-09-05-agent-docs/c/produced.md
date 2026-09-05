I have what I need. Here is the complete integration.

---

## What I read

`/llms.txt` → `/docs/for-ai-agents.md`, `/docs/installation.md`, `/docs/enqueue.md`, `/docs/workers.md`, `/docs/durable-execution.md`, `/docs/retries.md`, `/docs/api.md`, `/docs/idempotency.md`, `/docs/examples.md`, `/docs/contracts.md`, `/docs/releases.md`, `/docs/deadlines.md`.

Three constraints from the docs shaped the code:

1. **Enqueue must join the caller's transaction.** Go does this by wrapping the open `pgx.Tx` with `workhorse.NewPGXExecutor(tx)` and building a `Queue` over it — the job and the order row share one commit.
2. **Delivery is at-least-once.** `handler.Checkpoint` makes the send a replay boundary, but the docs are explicit that a checkpoint commits _after_ the operation, so a crash in that gap re-sends. The provider needs its own idempotency key. Both are below.
3. **The schema is a deployment step, never a startup step.** The app only calls `workhorse.AssertSchemaCompatible`.

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

// Provider sends transactional email through an external HTTP API.
type Provider struct {
	BaseURL string
	APIKey  string
	Client  *http.Client
}

func NewProvider(baseURL, apiKey string) *Provider {
	return &Provider{
		BaseURL: baseURL,
		APIKey:  apiKey,
		// Bound the socket independently of the job's execution timeout so a
		// wedged connection cannot hold a worker slot until the lease expires.
		Client: &http.Client{Timeout: 20 * time.Second},
	}
}

type SendRequest struct {
	To             string         `json:"to"`
	Template       string         `json:"template"`
	Variables      map[string]any `json:"variables"`
	IdempotencyKey string         `json:"-"`
}

type SendResult struct {
	MessageID string `json:"messageId"`
}

// PermanentError marks a provider rejection that another attempt cannot fix
// (malformed address, unknown template, rejected credentials).
type PermanentError struct {
	Status int
	Body   string
}

func (e *PermanentError) Error() string {
	return fmt.Sprintf("email provider rejected the request permanently: status %d: %s", e.Status, e.Body)
}

// Send posts one message. The idempotency key is stable per order, so a repeat
// caused by a crash between the HTTP response and the checkpoint commit returns
// the original message instead of sending a second email.
func (p *Provider) Send(ctx context.Context, request SendRequest) (SendResult, error) {
	body, err := json.Marshal(request)
	if err != nil {
		return SendResult{}, err
	}

	httpRequest, err := http.NewRequestWithContext(
		ctx, http.MethodPost, p.BaseURL+"/v1/messages", bytes.NewReader(body),
	)
	if err != nil {
		return SendResult{}, err
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	httpRequest.Header.Set("Authorization", "Bearer "+p.APIKey)
	httpRequest.Header.Set("Idempotency-Key", request.IdempotencyKey)

	response, err := p.Client.Do(httpRequest)
	if err != nil {
		// Transport failure, cancellation, or execution timeout. Retryable.
		return SendResult{}, fmt.Errorf("email provider request failed: %w", err)
	}
	defer response.Body.Close()

	payload, err := io.ReadAll(io.LimitReader(response.Body, 64*1024))
	if err != nil {
		return SendResult{}, err
	}

	switch {
	case response.StatusCode >= 200 && response.StatusCode < 300:
		var result SendResult
		if err := json.Unmarshal(payload, &result); err != nil {
			return SendResult{}, fmt.Errorf("email provider returned unreadable body: %w", err)
		}
		if result.MessageID == "" {
			return SendResult{}, fmt.Errorf("email provider returned no messageId")
		}
		return result, nil

	case response.StatusCode == http.StatusRequestTimeout,
		response.StatusCode == http.StatusTooManyRequests,
		response.StatusCode >= 500:
		// Retryable: the persisted retry policy decides when.
		return SendResult{}, fmt.Errorf(
			"email provider is unavailable: status %d: %s", response.StatusCode, string(payload))

	default:
		return SendResult{}, &PermanentError{Status: response.StatusCode, Body: string(payload)}
	}
}
```

---

## `internal/jobs/confirmation.go` — job type, payload, and the enqueue call

```go
package jobs

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	workhorse "github.com/stablemates/workhorse/go"
)

// TypeOrderConfirmationEmail is durable control flow: jobs accepted under this
// name outlive the deploy that accepted them, so never rename it in place.
const TypeOrderConfirmationEmail = "order.confirmation_email"

// QueueEmail isolates provider-bound work from other background work so it can
// carry its own worker capacity and be paused on its own during an incident.
const QueueEmail = "email"

// ConfirmationEmailPayload is the JSON contract carried by every job of this type.
type ConfirmationEmailPayload struct {
	OrderID       string  `json:"orderId"`
	CustomerEmail string  `json:"customerEmail"`
	TotalCents    int64   `json:"totalCents"`
	Currency      string  `json:"currency"`
	PlacedAt      string  `json:"placedAt"`
}

func (p ConfirmationEmailPayload) toJSON() (map[string]any, error) {
	encoded, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		return nil, err
	}
	return decoded, nil
}

func decodeConfirmationEmailPayload(payload any) (ConfirmationEmailPayload, error) {
	var decoded ConfirmationEmailPayload
	encoded, err := json.Marshal(payload)
	if err != nil {
		return decoded, fmt.Errorf("confirmation email payload is not JSON: %w", err)
	}
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		return decoded, fmt.Errorf("confirmation email payload has the wrong shape: %w", err)
	}
	if decoded.OrderID == "" || decoded.CustomerEmail == "" {
		return decoded, fmt.Errorf("confirmation email payload needs orderId and customerEmail")
	}
	return decoded, nil
}

// EnqueueConfirmationEmail accepts the job on the caller's open transaction.
// The job and the order row commit together or roll back together, so there is
// no window where a worker can see an order that does not exist — and no window
// where an order exists with no job. This is what replaces an outbox table.
func EnqueueConfirmationEmail(
	ctx context.Context,
	tx pgx.Tx,
	payload ConfirmationEmailPayload,
) (string, error) {
	jsonPayload, err := payload.toJSON()
	if err != nil {
		return "", err
	}

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(tx), QueueEmail)

	return queue.Enqueue(ctx, TypeOrderConfirmationEmail, jsonPayload, workhorse.EnqueueOptions{
		Queue: QueueEmail,

		// Failure policy is chosen at enqueue, not in the worker.
		MaxAttempts: 6,
		// Decorrelated jitter is the right shape for an external service: when a
		// provider outage fails a thousand jobs at once, jitter spreads their
		// wake times so the retry wave cannot re-flatten the recovering service.
		RetryPolicy: map[string]any{
			"type":         "decorrelated-jitter",
			"baseDelayMs":  2_000,
			"maxDelayMs":   300_000,
		},
		// Bounds one attempt, not the job. A stuck HTTP call is abandoned and
		// retried rather than holding a worker slot until the lease expires.
		ExecutionTimeoutMS: 60_000,

		// Deduplicates *acceptance*: a retried API request or a double-clicked
		// "Place order" converges on the original job instead of creating a
		// second one. The scope keeps this key namespace separate from any
		// other feature that also keys on an order ID.
		Idempotency: &workhorse.Idempotency{
			Key:   "confirmation:" + payload.OrderID,
			Scope: "order-confirmation-email",
		},

		Tags: []string{"order:" + payload.OrderID},
	})
}
```

---

## `internal/jobs/handler.go` — the worker-side handler

```go
package jobs

import (
	"context"
	"errors"

	workhorse "github.com/stablemates/workhorse/go"

	"example.com/app/internal/email"
)

// RegisterConfirmationEmailHandler binds the job type to its handler.
//
// Handlers run outside any transaction and delivery is at-least-once, so this
// function may be invoked more than once for the same job — after a crash, a
// lease expiry, or a retry. Two mechanisms make that safe, and both are needed:
//
//  1. Checkpoint("provider-send", ...) records the send under a durable name.
//     A later activation replays the stored result rather than sending again.
//  2. The provider's own idempotency key. The checkpoint commits *after* the
//     HTTP call returns, so a process death in that gap still re-sends. Only
//     the provider can close that last gap, so the key is derived from the
//     order ID and is therefore stable across every attempt of every job for
//     that order.
func RegisterConfirmationEmailHandler(worker *workhorse.Worker, provider *email.Provider) {
	worker.Handle(TypeOrderConfirmationEmail, func(
		ctx context.Context,
		payload any,
		handler *workhorse.HandlerContext,
	) (any, error) {
		order, err := decodeConfirmationEmailPayload(payload)
		if err != nil {
			return nil, err
		}

		sent, err := handler.Checkpoint("provider-send", func() (any, error) {
			// ctx is the handler's context: it is cancelled when an operator
			// cancels the job, when the deadline passes, or when the execution
			// timeout fires, which aborts the in-flight HTTP request.
			result, sendErr := provider.Send(ctx, email.SendRequest{
				To:       order.CustomerEmail,
				Template: "order-confirmation",
				Variables: map[string]any{
					"orderId":    order.OrderID,
					"totalCents": order.TotalCents,
					"currency":   order.Currency,
					"placedAt":   order.PlacedAt,
				},
				IdempotencyKey: "order-confirmation:" + order.OrderID,
			})
			if sendErr != nil {
				return nil, sendErr
			}
			// Checkpoint values are stored as JSON and size-capped: keep this
			// to the receipt, not the whole provider response.
			return map[string]any{"messageId": result.MessageID}, nil
		})
		if err != nil {
			var permanent *email.PermanentError
			if errors.As(err, &permanent) {
				// Still a failed attempt — the SDK has no "stop retrying now"
				// verb. The attempt budget bounds it, and the job then dead
				// letters with this error name, where an operator can redrive
				// it after fixing the underlying cause.
				return nil, err
			}
			return nil, err
		}

		receipt, _ := sent.(map[string]any)
		return map[string]any{
			"orderId":   order.OrderID,
			"messageId": receipt["messageId"],
		}, nil
	})
}
```

---

## `internal/orders/place.go` — the existing order write, with the job alongside it

```go
package orders

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"example.com/app/internal/jobs"
)

type Order struct {
	ID            string
	CustomerEmail string
	TotalCents    int64
	Currency      string
}

// PlaceOrder writes the order and accepts its confirmation-email job in one
// transaction. If the insert fails, no job exists. If the enqueue fails, no
// order exists. The returned job ID is what you read back to confirm the job
// settled.
func PlaceOrder(ctx context.Context, pool *pgxpool.Pool, order Order) (jobID string, err error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx) // No-op once Commit succeeds.

	placedAt := time.Now().UTC()

	if _, err = tx.Exec(ctx,
		`INSERT INTO orders (id, customer_email, total_cents, currency, status, placed_at)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		order.ID, order.CustomerEmail, order.TotalCents, order.Currency, "placed", placedAt,
	); err != nil {
		return "", err
	}

	jobID, err = jobs.EnqueueConfirmationEmail(ctx, tx, jobs.ConfirmationEmailPayload{
		OrderID:       order.ID,
		CustomerEmail: order.CustomerEmail,
		TotalCents:    order.TotalCents,
		Currency:      order.Currency,
		PlacedAt:      placedAt.Format(time.RFC3339),
	})
	if err != nil {
		return "", err
	}

	if err = tx.Commit(ctx); err != nil {
		return "", err
	}
	return jobID, nil
}
```

---

## `cmd/worker/main.go` — the worker process

```go
package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"

	"example.com/app/internal/email"
	"example.com/app/internal/jobs"
)

func main() {
	if err := run(); err != nil {
		log.Fatalf("worker exited: %v", err)
	}
}

func run() error {
	// The first signal stops claiming and drains active handlers. A second one
	// exits immediately and leaves PostgreSQL to recover the active leases.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		return err
	}
	defer pool.Close()

	// Verify the schema; never install it here. Installation is a deployment
	// step — see the install block below. A refusal is a *workhorse.CompatibilityError.
	if err := workhorse.AssertSchemaCompatible(ctx, workhorse.NewPGXExecutor(pool)); err != nil {
		return err
	}

	provider := email.NewProvider(
		os.Getenv("EMAIL_PROVIDER_URL"),
		os.Getenv("EMAIL_PROVIDER_API_KEY"),
	)

	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queues:      []string{jobs.QueueEmail},
		Concurrency: 8,
		// Shorter lease = faster recovery after a crash; longer = more tolerance
		// for network pauses. Keep it comfortably above the provider timeout.
		LeaseDuration: 60 * time.Second,
		// Leave WorkerID generated unless your process manager guarantees
		// uniqueness: two live workers sharing an identity collide over ownership.
	})
	if err != nil {
		return err
	}

	jobs.RegisterConfirmationEmailHandler(worker, provider)

	log.Printf("workhorse worker started on queue %q", jobs.QueueEmail)
	return worker.Run(ctx) // Loops until ctx is cancelled, then drains.
}
```

---

## `internal/jobs/status.go` — confirming a job settled (optional)

```go
package jobs

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

// Status reads a job back by the ID PlaceOrder returned. A settled job reports
// its terminal state and result; anything else reports the state it is in,
// which is how you tell a slow worker from a missing one.
func Status(ctx context.Context, pool *pgxpool.Pool, jobID string) (any, any, error) {
	admin := workhorse.NewAdmin(workhorse.NewPGXExecutor(pool))
	job, err := admin.GetJob(ctx, jobID)
	if err != nil {
		return nil, nil, err
	}
	if job == nil {
		return nil, nil, nil
	}
	return job.State, job.Result, nil
}
```

---

## Notes on the choices

- **`ExecutionTimeoutMS` not `Deadline`.** A confirmation email does not expire at a wall-clock moment, so the whole-job deadline is wrong here; bounding each _attempt_ is what you want for a stuck HTTP call. The two are independent clocks and each is terminal on its own.
- **Two idempotency layers, deliberately.** Workhorse's `Idempotency` deduplicates _acceptance_ (double-clicked checkout, retried API call). It never sees a re-run of an accepted job. The provider `Idempotency-Key` covers _execution_. Neither substitutes for the other.
- **Checkpoint name `"provider-send"` is program state.** Renaming it in a later deploy creates a different boundary, and in-flight jobs will re-send. Reusing it with a different value raises `CheckpointConflictError`.
- **Schema install version must match the SDK version.** A Go project has no `node_modules` to resolve the CLI from, so the command names the package _and_ the version — currently `0.1.0` for all three lines, which release in lockstep. Pin both numbers together when you bump.
- **Consider a payload contract** (`Queue.SyncContracts`) if `customerEmail` should be hidden from the dashboard and dead-letter views — it redacts named top-level keys from operator reads while still handing the raw value to the handler.

```install
go get github.com/stablemates/workhorse/go
go get github.com/jackc/pgx/v5
go mod tidy
npx --package @stablemates/workhorse@0.1.0 workhorse schema install
npx --package @stablemates/workhorse@0.1.0 workhorse schema status --json
```
