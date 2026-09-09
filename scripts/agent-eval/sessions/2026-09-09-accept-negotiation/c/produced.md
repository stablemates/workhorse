I've read enough of the docs. Here is the complete integration.

## What I read (and what it constrains)

- Go SDK: `github.com/stablemates/workhorse/go`, needs Go ≥ 1.25 and pgx v5 (≥ 5.9.2).
- Go `Enqueue` always takes 4 args: `Enqueue(ctx, type, payload map[string]any, workhorse.EnqueueOptions{})`.
- Transactional enqueue in Go = wrap the `pgx.Tx` you already opened: `workhorse.NewQueue(workhorse.NewPGXExecutor(tx), "queue-name")`.
- Delivery is **at-least-once**. A checkpoint commits _after_ its effect, so the provider still needs its own idempotency key — that's the documented rule, and the confirmation email is exactly the effect it protects.
- The schema is installed by a **Node.js** CLI step even for Go apps; runtime processes call `AssertSchemaCompatible` and never install.

---

## `internal/emailprovider/client.go` — the external HTTP provider

```go
package emailprovider

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// Client talks to the external transactional-email provider over HTTP.
type Client struct {
	BaseURL    string
	APIKey     string
	HTTPClient *http.Client
}

func New(baseURL, apiKey string) *Client {
	return &Client{
		BaseURL: baseURL,
		APIKey:  apiKey,
		// Per-request bound; the job's ExecutionTimeoutMS bounds the whole attempt.
		HTTPClient: &http.Client{Timeout: 20 * time.Second},
	}
}

type SendRequest struct {
	To             string         `json:"to"`
	Template       string         `json:"template"`
	Variables      map[string]any `json:"variables"`
	IdempotencyKey string         `json:"-"`
}

type SendResponse struct {
	MessageID string `json:"id"`
}

// RetryableError means "try again later": 5xx, 429, 408, or a transport failure.
type RetryableError struct {
	Status int
	Body   string
	Err    error
}

func (e *RetryableError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("email provider unavailable: %v", e.Err)
	}
	return fmt.Sprintf("email provider returned %d (retryable): %s", e.Status, e.Body)
}

func (e *RetryableError) Unwrap() error { return e.Err }

// PermanentError means the request itself is wrong: bad address, rejected template, bad key.
type PermanentError struct {
	Status int
	Body   string
}

func (e *PermanentError) Error() string {
	return fmt.Sprintf("email provider rejected the request with %d: %s", e.Status, e.Body)
}

// Send posts one message. ctx is the handler's context, so a cancellation,
// deadline, or execution timeout aborts the in-flight HTTP call.
func (c *Client) Send(ctx context.Context, request SendRequest) (SendResponse, error) {
	body, err := json.Marshal(request)
	if err != nil {
		return SendResponse{}, err
	}

	httpRequest, err := http.NewRequestWithContext(
		ctx, http.MethodPost, c.BaseURL+"/v1/messages", bytes.NewReader(body),
	)
	if err != nil {
		return SendResponse{}, err
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	httpRequest.Header.Set("Authorization", "Bearer "+c.APIKey)
	// The key that makes a replayed send harmless. Workhorse guarantees the job
	// runs at least once; this guarantees the customer is mailed at most once.
	httpRequest.Header.Set("Idempotency-Key", request.IdempotencyKey)

	response, err := c.HTTPClient.Do(httpRequest)
	if err != nil {
		// Do not wrap a cancelled context as retryable; let the job settle.
		if cause := context.Cause(ctx); cause != nil {
			return SendResponse{}, cause
		}
		return SendResponse{}, &RetryableError{Err: err}
	}
	defer response.Body.Close()

	payload, _ := io.ReadAll(io.LimitReader(response.Body, 64<<10))

	switch {
	case response.StatusCode >= 200 && response.StatusCode < 300:
		var decoded SendResponse
		if err := json.Unmarshal(payload, &decoded); err != nil {
			return SendResponse{}, &RetryableError{Status: response.StatusCode, Body: string(payload), Err: err}
		}
		return decoded, nil
	case response.StatusCode >= 500,
		response.StatusCode == http.StatusTooManyRequests,
		response.StatusCode == http.StatusRequestTimeout:
		return SendResponse{}, &RetryableError{Status: response.StatusCode, Body: string(payload)}
	default:
		return SendResponse{}, &PermanentError{Status: response.StatusCode, Body: string(payload)}
	}
}
```

---

## `internal/mailjobs/jobs.go` — the job contract and the transactional enqueue

```go
package mailjobs

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	workhorse "github.com/stablemates/workhorse/go"
)

const (
	// JobType and Queue are durable protocol: workers claim by queue and
	// dispatch by type. Do not rename either without draining first.
	JobType = "order.confirmation_email"
	Queue   = "email"

	// Checkpoint and idempotency names are durable control flow. A rename
	// creates a *different* boundary, so in-flight jobs would re-send.
	checkpointSend  = "provider-send"
	idempotencyScope = "order-confirmation"
)

// ConfirmationPayload is the JSON contract carried by the job row.
type ConfirmationPayload struct {
	OrderID    string `json:"orderId"`
	Email      string `json:"to"`
	CustomerName string `json:"customerName"`
	TotalCents int64  `json:"totalCents"`
	Currency   string `json:"currency"`
}

func (p ConfirmationPayload) toMap() map[string]any {
	return map[string]any{
		"orderId":      p.OrderID,
		"to":           p.Email,
		"customerName": p.CustomerName,
		"totalCents":   p.TotalCents,
		"currency":     p.Currency,
	}
}

// EffectKey is the stable domain key used for BOTH enqueue idempotency and the
// provider's own idempotency key. One order, one confirmation email, forever.
func EffectKey(orderID string) string { return "order-confirmation:" + orderID }

// EnqueueConfirmationEmail writes the job into the caller's OPEN transaction.
// It does not begin, commit, or roll back anything: the job becomes one more
// row in the transaction that inserts the order. If the order rolls back, the
// job never existed; there is no outbox and no relay process.
func EnqueueConfirmationEmail(ctx context.Context, tx pgx.Tx, payload ConfirmationPayload) (string, error) {
	if payload.OrderID == "" || payload.Email == "" {
		return "", fmt.Errorf("mailjobs: orderId and to are required")
	}

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(tx), Queue)

	return queue.Enqueue(ctx, JobType, payload.toMap(), workhorse.EnqueueOptions{
		Queue: Queue,
		Tags:  []string{"order:" + payload.OrderID},

		// A double-submitted checkout returns the original job id instead of
		// creating a second one. An equivalent replay converges; a replay with
		// a materially different payload returns a typed conflict rather than
		// silently enqueueing a second email.
		Idempotency: &workhorse.Idempotency{
			Key:   EffectKey(payload.OrderID),
			Scope: idempotencyScope,
			TTLMS: 86_400_000, // 24h replay window
		},

		// The provider is an external service, so back off with jitter: when a
		// thousand jobs fail together, their wake times spread out instead of
		// knocking the recovering provider over again.
		MaxAttempts: 8,
		RetryPolicy: map[string]any{
			"type":         "decorrelated-jitter",
			"baseDelayMs":  2_000,
			"maxDelayMs":   300_000,
		},

		// Bounds ONE attempt, not the job: a wedged HTTP call is abandoned and
		// retried rather than holding a worker slot.
		ExecutionTimeoutMS: 30_000,
	})
}

// decodePayload converts the handler's `any` (decoded JSON) into our struct.
func decodePayload(value any, target *ConfirmationPayload) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("mailjobs: cannot re-encode payload: %w", err)
	}
	if err := json.Unmarshal(raw, target); err != nil {
		return fmt.Errorf("mailjobs: payload does not match the confirmation contract: %w", err)
	}
	if target.OrderID == "" || target.Email == "" {
		return fmt.Errorf("mailjobs: payload needs string orderId and to fields")
	}
	return nil
}
```

---

## `internal/orders/create.go` — the existing order write, now carrying the job

```go
package orders

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"

	"yourapp/internal/mailjobs"
)

type Order struct {
	ID           string
	Email        string
	CustomerName string
	TotalCents   int64
	Currency     string
}

// Create inserts the order row and enqueues its confirmation email in ONE
// transaction. Either both are visible or neither is. There is no window in
// which the order exists without its email job, or the reverse.
func Create(ctx context.Context, pool *pgxpool.Pool, order Order) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) // no-op after a successful Commit

	if _, err := tx.Exec(ctx,
		`INSERT INTO orders (id, email, customer_name, total_cents, currency)
		 VALUES ($1, $2, $3, $4, $5)`,
		order.ID, order.Email, order.CustomerName, order.TotalCents, order.Currency,
	); err != nil {
		return err
	}

	if _, err := mailjobs.EnqueueConfirmationEmail(ctx, tx, mailjobs.ConfirmationPayload{
		OrderID:      order.ID,
		Email:        order.Email,
		CustomerName: order.CustomerName,
		TotalCents:   order.TotalCents,
		Currency:     order.Currency,
	}); err != nil {
		return err
	}

	return tx.Commit(ctx)
}
```

---

## `internal/mailjobs/handler.go` — the worker-side handler

```go
package mailjobs

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	workhorse "github.com/stablemates/workhorse/go"

	"yourapp/internal/emailprovider"
)

// Register binds the confirmation-email handler to a worker.
func Register(worker *workhorse.Worker, provider *emailprovider.Client, logger *slog.Logger) {
	worker.Handle(JobType, func(
		ctx context.Context, // cancelled on cancel request, deadline, or execution timeout
		payload any,
		handler *workhorse.HandlerContext,
	) (any, error) {
		var message ConfirmationPayload
		if err := decodePayload(payload, &message); err != nil {
			return nil, err
		}

		// A handler restarts FROM THE TOP after any retry or crash. The
		// checkpoint is what stops a second send: the first activation runs
		// the provider call and persists its result; every later activation
		// replays that stored result without calling the provider again.
		//
		// Honest caveat, straight from the docs: the checkpoint commits AFTER
		// the HTTP call returns. A crash in that gap re-runs the send. The
		// Idempotency-Key below is what makes that repeat harmless — the
		// checkpoint makes repeats rare, the provider key makes them free.
		result, err := handler.Checkpoint(checkpointSend, func() (any, error) {
			if cause := context.Cause(ctx); cause != nil {
				return nil, cause // cancelled before we touched the provider
			}

			sent, sendErr := provider.Send(ctx, emailprovider.SendRequest{
				To:             message.Email,
				Template:       "order-confirmation",
				IdempotencyKey: EffectKey(message.OrderID),
				Variables: map[string]any{
					"orderId":      message.OrderID,
					"customerName": message.CustomerName,
					"totalCents":   message.TotalCents,
					"currency":     message.Currency,
				},
			})
			if sendErr != nil {
				return nil, sendErr
			}

			// Return plain JSON: this exact value is what a replay hands back.
			return map[string]any{
				"messageId": sent.MessageID,
				"to":        message.Email,
			}, nil
		})
		if err != nil {
			var permanent *emailprovider.PermanentError
			if errors.As(err, &permanent) {
				// The request will never succeed as written. It still spends
				// attempts and lands in the dead-letter relation with this
				// error name attached — which is where an operator wants a bad
				// address to show up, with its evidence, rather than vanishing.
				logger.ErrorContext(ctx, "confirmation email permanently rejected",
					"jobId", handler.Job.ID, "orderId", message.OrderID, "status", permanent.Status)
			}
			return nil, err
		}

		stored, ok := result.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("mailjobs: checkpoint %q returned an unexpected shape", checkpointSend)
		}

		logger.InfoContext(ctx, "confirmation email sent",
			"jobId", handler.Job.ID, "orderId", message.OrderID, "messageId", stored["messageId"])

		// Becomes the job's durable, queryable outcome.
		return map[string]any{
			"orderId":   message.OrderID,
			"messageId": stored["messageId"],
			"to":        message.Email,
		}, nil
	})
}
```

---

## `cmd/emailworker/main.go` — the worker process

```go
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"

	"yourapp/internal/emailprovider"
	"yourapp/internal/mailjobs"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(logger); err != nil {
		logger.Error("email worker exited", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	// The first SIGTERM stops new claims and drains active handlers; a second
	// exits immediately and PostgreSQL recovers the leases.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		return err
	}
	defer pool.Close()

	// Runtime processes VERIFY the schema; they never install it. Installation
	// is a deployment step (see the install block below).
	if err := workhorse.AssertSchemaCompatible(ctx, workhorse.NewPGXExecutor(pool)); err != nil {
		return err
	}

	provider := emailprovider.New(
		os.Getenv("EMAIL_PROVIDER_URL"),
		os.Getenv("EMAIL_PROVIDER_API_KEY"),
	)

	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:               mailjobs.Queue,
		Concurrency:         8,
		LeaseDuration:       30 * time.Second,
		ShutdownGracePeriod: 25 * time.Second,
	})
	if err != nil {
		return err
	}

	mailjobs.Register(worker, provider, logger)

	logger.Info("email worker started", "queue", mailjobs.Queue)
	return worker.Run(ctx) // returns after a clean drain
}
```

---

## `cmd/workhorse-policies/main.go` — optional deploy step, fleet-wide throttling

The provider has rate limits that a single worker's `Concurrency` cannot enforce across replicas. These policies live in the database, so they bind the whole fleet.

```go
package main

import (
	"context"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"

	"yourapp/internal/mailjobs"
)

func main() {
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		panic(err)
	}
	defer pool.Close()

	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), mailjobs.Queue)

	maxPerRecipientDomain := 4
	if _, err := queue.SyncConcurrencyPolicies(ctx, "email", []workhorse.ConcurrencyPolicyDefinition{
		{Queue: mailjobs.Queue, MaxActive: 40, MaxActivePerKey: &maxPerRecipientDomain},
	}); err != nil {
		panic(err)
	}

	if _, err := queue.SyncRateLimitPolicies(ctx, "email", []workhorse.RateLimitPolicyDefinition{
		{
			Queue: mailjobs.Queue,
			Rate:  workhorse.RateLimit{Limit: 100, IntervalMS: 1_000, Burst: 200},
		},
	}); err != nil {
		panic(err)
	}
}
```

---

### Two things worth knowing before you ship this

1. **The schema step runs on Node.js even though this app is Go.** The migration tool ships only in the TypeScript package; that's a deliberate design decision, not a gap. Pin it to the same version as the Go module. For a local dev database without Node, the `v0.1.0` GitHub release attaches a `schema.sql` you can apply with `psql` — dev only, since it skips every guard the CLI applies.
2. **Nothing I read offers a handler-side "do not retry this" signal.** So a permanently-rejected address burns the attempt budget before it dead-letters. That's why `MaxAttempts` is 8 rather than 30: the failure still lands in the dead-letter relation with its error and attempts intact, and `Admin.redrive` can replay it after you fix the address.

```install
go get github.com/stablemates/workhorse/go
go get github.com/jackc/pgx/v5
npx --package @stablemates/workhorse@0.1.0 workhorse schema install
```
