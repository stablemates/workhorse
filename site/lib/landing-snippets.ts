/**
 * Every snippet on the landing page, as source strings.
 *
 * `scripts/gen-landing-code.ts` highlights these at build time into
 * `.source/landing-code.json`, which `components/code-sample.tsx` renders as
 * static markup. The landing page ships no client JavaScript for code.
 *
 * Every snippet is verified against the current API surface: `Queue` and
 * `Admin` in typescript/core/src, `Worker` and `HandlerContext` in
 * typescript/core/src/worker.ts, and option types in
 * typescript/core/src/types.ts. Change the source, change the snippet. Never
 * the other way around.
 *
 * Every Rust snippet is a copy of one `landing-*` region in
 * rust/examples/landing.rs, which `pnpm rust:clippy` compiles.
 * `scripts/check-language-examples.ts` fails when a copy and its region differ.
 */
export const landingSnippets = {
  hero: `import { installSchema, Pool, Queue, Worker } from "@stablemates/workhorse";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await installSchema(pool);

const queue = new Queue(pool);
await queue.enqueue("email.welcome", { to: "ada@example.com" });

const worker = new Worker(queue, { concurrency: 4 }).handle(
  "email.welcome",
  async ({ to }) => ({ deliveredTo: to }),
);

await worker.run();`,

  heroPython: `import psycopg
from psycopg_pool import ConnectionPool

from workhorse import HandlerContext, Json, Queue, Worker


def run(database_url: str) -> None:
    with psycopg.connect(database_url) as connection:
        Queue(connection).enqueue("email.welcome", {"to": "ada@example.com"})

    def welcome(payload: object, _context: HandlerContext) -> dict[str, Json]:
        assert isinstance(payload, dict)
        return {"deliveredTo": payload["to"]}

    with ConnectionPool(
        database_url, min_size=3, max_size=3, kwargs={"autocommit": True}
    ) as pool:
        Worker(pool, concurrency=4).handle("email.welcome", welcome).run()`,

  heroGo: `package example

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

func run(ctx context.Context, pool *pgxpool.Pool) error {
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "default")
	if _, err := queue.Enqueue(ctx, "email.welcome", map[string]any{
		"to": "ada@example.com",
	}); err != nil {
		return err
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{Concurrency: 4})
	if err != nil {
		return err
	}
	worker.Handle("email.welcome", func(
		_ context.Context, payload any, _ *workhorse.HandlerContext,
	) (any, error) {
		message, ok := payload.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("payload must be an object")
		}
		return map[string]any{"deliveredTo": message["to"]}, nil
	})
	return worker.Run(ctx)
}`,

  heroRust: `use serde_json::{json, Value};
use workhorse::deadpool_postgres::Pool;
use workhorse::{run_worker_process, EnqueueOptions, Queue, Worker, WorkerOptions};

pub async fn run(pool: Pool) -> Result<(), Box<dyn std::error::Error>> {
    let welcome = json!({ "to": "ada@example.com" });
    Queue::new(&pool, "default")
        .enqueue("email.welcome", &welcome, EnqueueOptions::default())
        .await?;

    let worker = Worker::new(pool, WorkerOptions { concurrency: 4, ..Default::default() })?;
    worker.handle("email.welcome", |payload: Value, _context| async move {
        Ok(json!({ "deliveredTo": payload["to"] }))
    });
    run_worker_process(&worker).await?;
    Ok(())
}`,

  languageTypeScript: `import { Pool, Queue } from "@stablemates/workhorse";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const queue = new Queue(pool);

await queue.enqueue("email.welcome", {
  to: "ada@example.com",
});`,

  languagePython: `import psycopg

from workhorse import Queue


def enqueue_welcome(database_url: str) -> None:
    with psycopg.connect(database_url) as connection:
        Queue(connection).enqueue(
            "email.welcome",
            {"to": "ada@example.com"},
        )`,

  languageGo: `package example

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

func enqueueWelcome(ctx context.Context, pool *pgxpool.Pool) error {
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "default")
	_, err := queue.Enqueue(ctx, "email.welcome", map[string]any{
		"to": "ada@example.com",
	}, workhorse.EnqueueOptions{})
	return err
}`,

  enqueue: `const client = await pool.connect();
try {
  await client.query("BEGIN");

  await client.query(
    "INSERT INTO orders (id, total) VALUES ($1, $2)",
    [orderId, total],
  );

  // Same transaction: the task exists exactly when the order does.
  await queue.enqueue("order.confirm", { orderId }, {}, client);

  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
}`,

  enqueuePython: `import psycopg

from workhorse import Queue


def create_order(database_url: str, order_id: str, total: int) -> None:
    with psycopg.connect(database_url) as connection:
        connection.execute(
            "INSERT INTO orders (id, total) VALUES (%s, %s)",
            (order_id, total),
        )
        Queue(connection).enqueue("order.confirm", {"orderId": order_id})`,

  enqueueGo: `package example

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

func createOrder(ctx context.Context, pool *pgxpool.Pool, orderID string, total int) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx,
		"INSERT INTO orders (id, total) VALUES ($1, $2)", orderID, total,
	); err != nil {
		return err
	}
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(tx), "default")
	if _, err := queue.Enqueue(ctx, "order.confirm", map[string]any{
		"orderId": orderID,
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}`,

  enqueueRust: `use serde_json::json;
use workhorse::deadpool_postgres::Pool;
use workhorse::{EnqueueOptions, Queue};

pub async fn create_order(
    pool: &Pool,
    order_id: &str,
    total: i64,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut client = pool.get().await?;
    let transaction = client.transaction().await?;
    transaction
        .execute("INSERT INTO orders (id, total) VALUES ($1, $2)", &[&order_id, &total])
        .await?;

    // Same transaction: the task exists exactly when the order does.
    Queue::new(&transaction, "default")
        .enqueue("order.confirm", &json!({ "orderId": order_id }), EnqueueOptions::default())
        .await?;

    transaction.commit().await?;
    Ok(())
}`,

  checkpoints: `worker.handle("invoice.issue", async (payload, ctx) => {
  // Runs once. Every later activation replays the stored result.
  const charge = await ctx.checkpoint("charge", () =>
    payments.charge(payload.amount),
  );

  const pdf = await ctx.checkpoint("render", () =>
    renderInvoice(charge.id),
  );

  await sendEmail(payload.email, pdf);
  return { chargeId: charge.id };
});`,

  checkpointsPython: `from workhorse import HandlerContext, Json, Worker


def charge_card(amount: int) -> dict[str, Json]:
    return {"id": f"ch_{amount}"}


def render_invoice(charge_id: Json) -> dict[str, Json]:
    return {"chargeId": charge_id}


def register_invoice(worker: Worker) -> None:
    def issue(payload: object, context: HandlerContext) -> dict[str, Json]:
        assert isinstance(payload, dict)
        amount, email = payload["amount"], payload["email"]
        assert isinstance(amount, int) and isinstance(email, str)
        charge = context.checkpoint("charge", lambda: charge_card(amount))
        assert isinstance(charge, dict)
        pdf = context.checkpoint("render", lambda: render_invoice(charge["id"]))
        print("email", email, pdf)
        return {"chargeId": charge["id"]}

    worker.handle("invoice.issue", issue)`,

  checkpointsGo: `package example

import (
	"context"

	workhorse "github.com/stablemates/workhorse/go"
)

func registerInvoice(worker *workhorse.Worker) {
	worker.Handle("invoice.issue", func(
		_ context.Context, payload any, handler *workhorse.HandlerContext,
	) (any, error) {
		charge, err := handler.Checkpoint("charge", func() (any, error) {
			return map[string]any{"payload": payload}, nil
		})
		if err != nil {
			return nil, err
		}
		pdf, err := handler.Checkpoint("render", func() (any, error) {
			return map[string]any{"charge": charge}, nil
		})
		if err != nil {
			return nil, err
		}
		return map[string]any{"charge": charge, "pdf": pdf}, nil
	})
}`,

  checkpointsRust: `use serde::Deserialize;
use serde_json::{json, Value};
use workhorse::{HandlerError, Worker};

#[derive(Deserialize)]
struct Invoice {
    amount: i64,
    email: String,
}

async fn charge_card(amount: i64) -> Result<Value, HandlerError> {
    Ok(json!({ "id": format!("ch_{amount}") }))
}

async fn render_invoice(charge_id: Value) -> Result<Value, HandlerError> {
    Ok(json!({ "chargeId": charge_id }))
}

pub fn register_invoice(worker: &Worker) {
    worker.handle("invoice.issue", |invoice: Invoice, context| async move {
        // Runs once. Every later activation replays the stored result.
        let charge: Value =
            context.checkpoint("charge", || charge_card(invoice.amount)).await?;

        let pdf: Value =
            context.checkpoint("render", || render_invoice(charge["id"].clone())).await?;

        println!("email {} {pdf}", invoice.email);
        Ok(json!({ "chargeId": charge["id"] }))
    });
}`,

  sleep: `worker.handle("order.settle", async (payload, ctx) => {
  const order = await ctx.checkpoint("place", () =>
    placeOrder(payload),
  );

  // Slot released here. The process can restart, deploy, or die.
  await ctx.sleep("settlement-window", 60 * 60 * 1000);

  await confirm(order.id);
  return { orderId: order.id };
});`,

  sleepPython: `from workhorse import HandlerContext, Json, Worker


def place_order(payload: object) -> dict[str, Json]:
    assert isinstance(payload, dict)
    return {"payload": payload}


def register_settlement(worker: Worker) -> None:
    def settle(payload: object, context: HandlerContext) -> dict[str, Json]:
        order = context.checkpoint("place", lambda: place_order(payload))
        context.sleep("settlement-window", 60 * 60 * 1000)
        assert isinstance(order, dict)
        return {"order": order, "confirmed": True}

    worker.handle("order.settle", settle)`,

  sleepGo: `package example

import (
	"context"
	"time"

	workhorse "github.com/stablemates/workhorse/go"
)

func registerSettlement(worker *workhorse.Worker) {
	worker.Handle("order.settle", func(
		_ context.Context, payload any, handler *workhorse.HandlerContext,
	) (any, error) {
		order, err := handler.Checkpoint("place", func() (any, error) {
			return map[string]any{"payload": payload}, nil
		})
		if err != nil {
			return nil, err
		}
		if err := handler.Sleep("settlement-window", time.Hour); err != nil {
			return nil, err
		}
		return map[string]any{"order": order, "confirmed": true}, nil
	})
}`,

  sleepRust: `use std::time::Duration;

use serde_json::{json, Value};
use workhorse::{HandlerError, Worker};

async fn place_order(payload: Value) -> Result<Value, HandlerError> {
    Ok(json!({ "orderId": payload["orderId"] }))
}

pub fn register_settlement(worker: &Worker) {
    worker.handle("order.settle", |payload: Value, context| async move {
        let order: Value = context.checkpoint("place", || place_order(payload)).await?;

        // Slot released here. The process can restart, deploy, or die.
        context.sleep("settlement-window", Duration::from_secs(60 * 60)).await?;

        Ok(json!({ "settled": order["orderId"] }))
    });
}`,

  retries: `await queue.enqueue(
  "match.reminder",
  { matchId },
  {
    // Pointless after kickoff, whatever else happens.
    deadline: kickoffTime,
    // Any single attempt is stuck after 30 seconds.
    executionTimeoutMs: 30_000,
    maxAttempts: 5,
    retryPolicy: {
      type: "exponential",
      initialDelayMs: 1_000,
      multiplier: 2,
      maxDelayMs: 60_000,
    },
  },
);`,

  retriesPython: `from datetime import datetime

from workhorse import EnqueueOptions, Queue


def enqueue_reminder(queue: Queue, match_id: str, kickoff: datetime) -> str:
    return queue.enqueue(
        "match.reminder",
        {"matchId": match_id},
        EnqueueOptions(
            deadline=kickoff,
            execution_timeout_ms=30_000,
            max_attempts=5,
            retry_policy={
                "type": "exponential",
                "initialDelayMs": 1_000,
                "multiplier": 2,
                "maxDelayMs": 60_000,
            },
        ),
    )`,

  retriesGo: `package example

import (
	"context"
	"time"

	workhorse "github.com/stablemates/workhorse/go"
)

func enqueueReminder(ctx context.Context, queue *workhorse.Queue, matchID string, kickoff time.Time) (string, error) {
	return queue.Enqueue(ctx, "match.reminder", map[string]any{
		"matchId": matchID,
	}, workhorse.EnqueueOptions{
		Deadline:           &kickoff,
		ExecutionTimeoutMS: 30_000,
		MaxAttempts:        5,
		RetryPolicy: map[string]any{
			"type": "exponential", "initialDelayMs": 1_000,
			"multiplier": 2, "maxDelayMs": 60_000,
		},
	})
}`,

  retriesRust: `use chrono::{DateTime, Utc};
use serde_json::json;
use workhorse::deadpool_postgres::Pool;
use workhorse::{EnqueueOptions, EnqueueResult, Error, Queue};

pub async fn remind(
    queue: &Queue<Pool>,
    match_id: &str,
    kickoff: DateTime<Utc>,
) -> Result<EnqueueResult, Error> {
    let options = EnqueueOptions {
        // Pointless after kickoff, whatever else happens.
        deadline: Some(kickoff),
        // Any single attempt is stuck after 30 seconds.
        execution_timeout_ms: Some(30_000),
        max_attempts: 5,
        retry_policy: json!({
            "kind": "exponential",
            "initialDelayMs": 1_000,
            "multiplier": 2,
            "maxDelayMs": 60_000,
        })
        .as_object()
        .cloned(),
        ..Default::default()
    };
    queue.enqueue("match.reminder", &json!({ "matchId": match_id }), options).await
}`,

  idempotency: `const taskId = await queue.enqueue(
  "invoice.capture",
  { invoiceId: "inv-1" },
  {
    queue: "billing",
    idempotency: {
      key: "capture:inv-1",
      scope: "tenant-42",
      ttlMs: 86_400_000,
    },
  },
);

// The retried webhook, the double-clicked button, the replayed
// message: all of them get the same taskId back.`,

  idempotencyPython: `from workhorse import EnqueueOptions, Idempotency, Queue


def capture_invoice(queue: Queue) -> str:
    return queue.enqueue(
        "invoice.capture",
        {"invoiceId": "inv-1"},
        EnqueueOptions(
            queue="billing",
            idempotency=Idempotency(
                key="capture:inv-1",
                scope="tenant-42",
                ttl_ms=86_400_000,
            ),
        ),
    )`,

  idempotencyGo: `package example

import (
	"context"

	workhorse "github.com/stablemates/workhorse/go"
)

func captureInvoice(ctx context.Context, queue *workhorse.Queue) (string, error) {
	return queue.Enqueue(ctx, "invoice.capture", map[string]any{
		"invoiceId": "inv-1",
	}, workhorse.EnqueueOptions{
		Queue: "billing",
		Idempotency: &workhorse.Idempotency{
			Key: "capture:inv-1", Scope: "tenant-42", TTLMS: 86_400_000,
		},
	})
}`,

  idempotencyRust: `use serde_json::json;
use workhorse::deadpool_postgres::Pool;
use workhorse::{EnqueueOptions, EnqueueResult, Error, Idempotency, Queue};

// A retried webhook gets the same task_id back instead of a second capture.
pub async fn capture(queue: &Queue<Pool>) -> Result<EnqueueResult, Error> {
    let options = EnqueueOptions {
        queue: Some("billing".into()),
        idempotency: Some(Idempotency {
            key: "capture:inv-1".into(),
            scope: "tenant-42".into(),
            ttl_ms: 86_400_000,
        }),
        ..Default::default()
    };
    queue.enqueue("invoice.capture", &json!({ "invoiceId": "inv-1" }), options).await
}`,

  schedules: `// Run on every deployment with the complete list.
await queue.syncSchedules(
  "billing",
  [
    {
      name: "nightly-invoice-run",
      schedule: "0 2 * * *",
      task: { type: "invoices.generate", payload: {} },
    },
  ],
  { prune: true }, // names not in the list are disabled
);

// Any worker in the namespace fires due schedules itself.
const worker = new Worker(queue, {
  scheduleNamespaces: ["billing"],
});`,

  schedulesPython: `import psycopg
from psycopg_pool import ConnectionPool

from workhorse import (
    HandlerContext,
    Json,
    Queue,
    ScheduleDefinition,
    ScheduledTask,
    Worker,
)


def run_billing(database_url: str) -> None:
    with psycopg.connect(database_url) as connection:
        Queue(connection).sync_schedules(
            "billing",
            (
                ScheduleDefinition(
                    name="nightly-invoice-run",
                    schedule="0 2 * * *",
                    task=ScheduledTask(type="invoices.generate", payload={}),
                ),
            ),
        )

    def generate(payload: object, _context: HandlerContext) -> dict[str, Json]:
        return {"generated": True}

    with ConnectionPool(
        database_url, min_size=3, max_size=3, kwargs={"autocommit": True}
    ) as pool:
        Worker(
            pool,
            schedule_namespaces=("billing",),
        ).handle("invoices.generate", generate).run()`,

  schedulesGo: `package example

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

func runBilling(ctx context.Context, pool *pgxpool.Pool) error {
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(pool), "default")
	if err := queue.SyncSchedules(ctx, "billing", []workhorse.ScheduleDefinition{
		{
			Name:     "nightly-invoice-run",
			Schedule: "0 2 * * *",
			Task: workhorse.ScheduledTask{
				Type: "invoices.generate", Payload: map[string]any{},
			},
		},
	}); err != nil {
		return err
	}
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		ScheduleNamespaces: []string{"billing"},
	})
	if err != nil {
		return err
	}
	worker.Handle("invoices.generate", func(
		_ context.Context, payload any, _ *workhorse.HandlerContext,
	) (any, error) {
		return map[string]any{"generated": true}, nil
	})
	return worker.Run(ctx)
}`,

  schedulesRust: `use serde_json::json;
use workhorse::deadpool_postgres::Pool;
use workhorse::{
    run_worker_process, Queue, ScheduleDefinition, ScheduledTask, Worker, WorkerOptions,
};

pub async fn run(pool: Pool) -> Result<(), Box<dyn std::error::Error>> {
    // Run on every deployment with the complete list.
    let task = ScheduledTask::new("invoices.generate", json!({}));
    let schedule = ScheduleDefinition::new("nightly-invoice-run", "0 2 * * *", task);
    Queue::new(&pool, "default").sync_schedules("billing", vec![schedule], true).await?;

    // Any worker in the namespace fires due schedules itself.
    let options =
        WorkerOptions { schedule_namespaces: vec!["billing".into()], ..Default::default() };
    let worker = Worker::new(pool, options)?;
    run_worker_process(&worker).await?;
    Ok(())
}`,

  flowControl: `await queue.syncConcurrencyPolicies("workers", [
  // At most 20 mail tasks active; at most 2 per tenant.
  { queue: "mail", maxActive: 20, maxActivePerKey: 2 },
]);

await queue.syncRateLimitPolicies("workers", [
  {
    queue: "provider-api",
    rate: { limit: 100, intervalMs: 1_000, burst: 200 },
  },
]);

await queue.enqueue(
  "mail.send",
  { messageId },
  { queue: "mail", concurrencyKey: \`tenant:\${tenantId}\` },
);`,

  flowControlPython: `from workhorse import (
    ConcurrencyPolicyDefinition,
    EnqueueOptions,
    Queue,
    RateLimit,
    RateLimitPolicyDefinition,
)


def configure_flow_control(queue: Queue, message_id: str, tenant_id: str) -> None:
    queue.sync_concurrency_policies(
        "workers",
        (
            ConcurrencyPolicyDefinition(
                queue="mail", max_active=20, max_active_per_key=2
            ),
        ),
    )
    queue.sync_rate_limit_policies(
        "workers",
        (
            RateLimitPolicyDefinition(
                queue="provider-api",
                rate=RateLimit(limit=100, interval_ms=1_000, burst=200),
            ),
        ),
    )
    queue.enqueue(
        "mail.send",
        {"messageId": message_id},
        EnqueueOptions(queue="mail", concurrency_key=f"tenant:{tenant_id}"),
    )`,

  flowControlGo: `package example

import (
	"context"

	workhorse "github.com/stablemates/workhorse/go"
)

func configureFlowControl(
	ctx context.Context,
	queue *workhorse.Queue,
	messageID string,
	tenantID string,
) error {
	maxPerTenant := 2
	if _, err := queue.SyncConcurrencyPolicies(ctx, "workers", []workhorse.ConcurrencyPolicyDefinition{
		{Queue: "mail", MaxActive: 20, MaxActivePerKey: &maxPerTenant},
	}); err != nil {
		return err
	}
	if _, err := queue.SyncRateLimitPolicies(ctx, "workers", []workhorse.RateLimitPolicyDefinition{
		{
			Queue: "provider-api",
			Rate:  workhorse.RateLimit{Limit: 100, IntervalMS: 1_000, Burst: 200},
		},
	}); err != nil {
		return err
	}
	_, err := queue.Enqueue(ctx, "mail.send", map[string]any{
		"messageId": messageID,
	}, workhorse.EnqueueOptions{
		Queue: "mail", ConcurrencyKey: "tenant:" + tenantID,
	})
	return err
}`,

  flowControlRust: `use serde_json::json;
use workhorse::deadpool_postgres::Pool;
use workhorse::policies::{ConcurrencyPolicyDefinition, RateLimit, RateLimitPolicyDefinition};
use workhorse::{EnqueueOptions, Error, Queue};

pub async fn configure(
    queue: &Queue<Pool>,
    message_id: &str,
    tenant_id: &str,
) -> Result<(), Error> {
    // At most 20 mail tasks active; at most 2 per tenant.
    let mail = ConcurrencyPolicyDefinition {
        queue: "mail".into(),
        max_active: 20,
        max_active_per_key: Some(2),
    };
    queue.sync_concurrency_policies("workers", &[mail], false).await?;

    let provider = RateLimitPolicyDefinition {
        queue: "provider-api".into(),
        rate: RateLimit { limit: 100, interval_ms: 1_000, burst: 200 },
        per_key: None,
    };
    queue.sync_rate_limit_policies("workers", &[provider], false).await?;

    let options = EnqueueOptions {
        queue: Some("mail".into()),
        concurrency_key: Some(format!("tenant:{tenant_id}")),
        ..Default::default()
    };
    queue.enqueue("mail.send", &json!({ "messageId": message_id }), options).await?;
    Ok(())
}`,

  dependencies: `const inventoryId = await queue.enqueue(
  "inventory.reserve",
  { orderId },
);

await queue.enqueue(
  "order.confirm",
  { orderId },
  {
    dependencies: {
      prerequisiteTaskIds: [inventoryId],
      onSuccess: "release",
      onFailure: "cancel",
      onCancellation: "cancel",
    },
  },
);

worker.handle("order.fulfill", async (order, ctx) => {
  const receipt = await ctx.runChild(
    "charge",
    "payment.capture",
    { orderId: order.id },
    { queue: "payments" },
  );
  return { receipt };
});`,

  dependenciesPython: `from workhorse import Dependencies, EnqueueOptions, HandlerContext, Json, Queue, Worker


def configure_checkout(queue: Queue, worker: Worker, order_id: str) -> None:
    inventory_id = queue.enqueue("inventory.reserve", {"orderId": order_id})
    queue.enqueue(
        "order.confirm",
        {"orderId": order_id},
        EnqueueOptions(
            dependencies=Dependencies(
                prerequisite_task_ids=(inventory_id,),
                on_success="release",
                on_failure="cancel",
                on_cancellation="cancel",
            ),
        ),
    )

    def fulfill(order: object, context: HandlerContext) -> dict[str, Json]:
        assert isinstance(order, dict)
        receipt = context.run_child("charge", "payment.capture", order)
        return {"receipt": receipt}

    worker.handle("order.fulfill", fulfill)`,

  dependenciesGo: `package example

import (
	"context"

	workhorse "github.com/stablemates/workhorse/go"
)

func configureCheckout(ctx context.Context, queue *workhorse.Queue, worker *workhorse.Worker, orderID string) error {
	inventoryID, err := queue.Enqueue(ctx, "inventory.reserve", map[string]any{"orderId": orderID})
	if err != nil {
		return err
	}
	if _, err := queue.Enqueue(ctx, "order.confirm", map[string]any{
		"orderId": orderID,
	}, workhorse.EnqueueOptions{Dependencies: &workhorse.Dependencies{
		PrerequisiteTaskIDs: []string{inventoryID},
		OnSuccess:           workhorse.DependencyRelease,
		OnFailure:           workhorse.DependencyCancel,
		OnCancellation:      workhorse.DependencyCancel,
	}}); err != nil {
		return err
	}

	worker.Handle("order.fulfill", func(
		_ context.Context, order any, handler *workhorse.HandlerContext,
	) (any, error) {
		return handler.RunChild("charge", "payment.capture", order, workhorse.EnqueueOptions{})
	})
	return nil
}`,

  dependenciesRust: `use serde_json::{json, Value};
use workhorse::deadpool_postgres::Pool;
use workhorse::{Dependencies, DependencyTerminalPolicy, EnqueueOptions, Error, Queue, Worker};

pub async fn confirm(queue: &Queue<Pool>, order_id: &str) -> Result<(), Error> {
    let order = json!({ "orderId": order_id });
    let inventory =
        queue.enqueue("inventory.reserve", &order, EnqueueOptions::default()).await?;

    let dependencies = Dependencies {
        prerequisite_task_ids: vec![inventory.task_id],
        on_success: DependencyTerminalPolicy::Release,
        on_failure: DependencyTerminalPolicy::Cancel,
        on_cancellation: DependencyTerminalPolicy::Cancel,
    };
    let options = EnqueueOptions { dependencies: Some(dependencies), ..Default::default() };
    queue.enqueue("order.confirm", &order, options).await?;
    Ok(())
}

pub fn register_fulfillment(worker: &Worker) {
    worker.handle("order.fulfill", |order: Value, context| async move {
        let options = EnqueueOptions { queue: Some("payments".into()), ..Default::default() };
        let capture = json!({ "orderId": order["id"] });
        let receipt: Value =
            context.run_child("charge", "payment.capture", &capture, options).await?;
        Ok(json!({ "receipt": receipt }))
    });
}`,

  coalescing: `const options = {
  debounce: {
    key: documentId,
    scope: "search-index",
    windowMs: quietPeriodMs,
    schedule: "reset",
  },
} as const;

const first = await queue.enqueueWithResult(
  "search.reindex",
  { documentId, revision: 1 },
  options,
);
const latest = await queue.enqueueWithResult(
  "search.reindex",
  { documentId, revision: 2 },
  options,
);

logger.info(first.outcome, latest.outcome);
// accepted, then replaced while the task remains pending`,

  coalescingPython: `from workhorse import Debounce, EnqueueOptions, Queue


def reindex(queue: Queue, document_id: str, quiet_ms: int) -> None:
    options = EnqueueOptions(
        debounce=Debounce(
            key=document_id,
            scope="search-index",
            window_ms=quiet_ms,
            schedule="reset",
        )
    )
    first = queue.enqueue_with_result(
        "search.reindex",
        {"documentId": document_id, "revision": 1},
        options,
    )
    latest = queue.enqueue_with_result(
        "search.reindex",
        {"documentId": document_id, "revision": 2},
        options,
    )
    print(first.outcome, latest.outcome)`,

  coalescingGo: `package example

import (
	"context"
	"fmt"

	workhorse "github.com/stablemates/workhorse/go"
)

func reindex(ctx context.Context, queue *workhorse.Queue, documentID string, quietMS int) error {
	options := workhorse.EnqueueOptions{Debounce: &workhorse.Debounce{
		Key: documentID, Scope: "search-index",
		WindowMS: quietMS, Schedule: workhorse.DebounceReset,
	}}
	first, err := queue.EnqueueWithResult(ctx, "search.reindex", map[string]any{
		"documentId": documentID, "revision": 1,
	}, options)
	if err != nil {
		return err
	}
	latest, err := queue.EnqueueWithResult(ctx, "search.reindex", map[string]any{
		"documentId": documentID, "revision": 2,
	}, options)
	if err == nil {
		fmt.Println(first.Outcome, latest.Outcome)
	}
	return err
}`,

  coalescingRust: `use serde_json::json;
use workhorse::deadpool_postgres::Pool;
use workhorse::{Debounce, DebounceSchedule, EnqueueOptions, Error, Queue};

pub async fn reindex(
    queue: &Queue<Pool>,
    document_id: &str,
    quiet_ms: i64,
) -> Result<(), Error> {
    let options = || EnqueueOptions {
        debounce: Some(Debounce {
            scope: "search-index".into(),
            ..Debounce::new(document_id, quiet_ms, DebounceSchedule::Reset)
        }),
        ..Default::default()
    };
    let first = json!({ "documentId": document_id, "revision": 1 });
    let first = queue.enqueue("search.reindex", &first, options()).await?;
    let latest = json!({ "documentId": document_id, "revision": 2 });
    let latest = queue.enqueue("search.reindex", &latest, options()).await?;
    println!("{:?} {:?}", first.outcome, latest.outcome);
    Ok(())
}`,

  externalWaits: `worker.handle("release.publish", async (release, ctx) => {
  const scan = await ctx.waitForSignal("security-scan");

  const review = await ctx.waitForHuman(
    "release-approval",
    { releaseId: release.id, scan },
  );

  return { published: review.approved };
});

await queue.sendSignal(taskId, "security-scan", scanResult, {
  idempotencyKey: scanResult.deliveryId,
  requestedBy: "security-scanner",
});`,

  externalWaitsPython: `from workhorse import HandlerContext, Json, Queue, Worker


def configure_release(worker: Worker) -> None:
    def publish(release: object, context: HandlerContext) -> dict[str, Json]:
        assert isinstance(release, dict)
        scan = context.wait_for_signal("security-scan")
        review = context.wait_for_human(
            "release-approval",
            {"releaseId": release["id"], "scan": scan},
        )
        assert isinstance(review, dict)
        return {"published": review["approved"]}

    worker.handle("release.publish", publish)


def deliver_scan(queue: Queue, task_id: str, result: Json, delivery_id: str) -> None:
    queue.send_signal(
        task_id,
        "security-scan",
        result,
        idempotency_key=delivery_id,
        requested_by="security-scanner",
    )`,

  externalWaitsGo: `package example

import (
	"context"
	"fmt"

	workhorse "github.com/stablemates/workhorse/go"
)

func configureRelease(worker *workhorse.Worker) {
	worker.Handle("release.publish", func(
		_ context.Context, release any, handler *workhorse.HandlerContext,
	) (any, error) {
		scan, err := handler.WaitForSignal("security-scan")
		if err != nil {
			return nil, err
		}
		review, err := handler.WaitForHuman("release-approval", map[string]any{
			"release": release, "scan": scan,
		})
		if err != nil {
			return nil, err
		}
		decision, ok := review.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("review must be an object")
		}
		approved, ok := decision["approved"].(bool)
		if !ok {
			return nil, fmt.Errorf("review needs a boolean approved field")
		}
		return map[string]any{"published": approved}, nil
	})
}

func deliverScan(ctx context.Context, queue *workhorse.Queue, taskID string, result any, deliveryID string) error {
	_, err := queue.SendSignal(ctx, taskID, "security-scan", result, workhorse.ExternalWaitDelivery{
		IdempotencyKey: deliveryID, RequestedBy: "security-scanner",
	})
	return err
}`,

  externalWaitsRust: `use serde_json::{json, Value};
use uuid::Uuid;
use workhorse::deadpool_postgres::Pool;
use workhorse::{DeliveryOptions, Error, Queue, Worker};

pub fn register_release(worker: &Worker) {
    worker.handle("release.publish", |release: Value, context| async move {
        let scan: Value = context.wait_for_signal("security-scan", None).await?.payload;

        let request = json!({ "releaseId": release["id"], "scan": scan });
        let review: Value =
            context.wait_for_human("release-approval", &request, None).await?.result;

        Ok(json!({ "published": review["approved"] }))
    });
}

pub async fn deliver_scan(
    queue: &Queue<Pool>,
    task_id: Uuid,
    result: &Value,
    delivery_id: &str,
) -> Result<(), Error> {
    let delivery = DeliveryOptions {
        idempotency_key: delivery_id.into(),
        requested_by: "security-scanner".into(),
    };
    queue.send_signal(task_id, "security-scan", result, delivery).await?;
    Ok(())
}`,

  batchHandlers: `worker.handleBatch(
  "email.send",
  { maxSize: batchSize, lingerMs: batchLingerMs },
  async (items) => {
    const sent = await provider.sendMany(
      items.map(({ payload }) => payload),
    );

    return sent.map((delivery) =>
      delivery.error
        ? { status: "failed", error: delivery.error }
        : { status: "succeeded", result: delivery.id },
    );
  },
);`,

  batchHandlersPython: `from collections.abc import Sequence

from workhorse import BatchHandlerItem, BatchHandlerOutcome, Worker


def register_email_batch(worker: Worker, batch_size: int, linger_ms: int) -> None:
    def send(items: Sequence[BatchHandlerItem]) -> Sequence[BatchHandlerOutcome]:
        return tuple({"status": "succeeded", "result": item.payload} for item in items)

    worker.handle_batch(
        "email.send",
        send,
        max_size=batch_size,
        linger_ms=linger_ms,
    )`,

  batchHandlersGo: `package example

import (
	"time"

	workhorse "github.com/stablemates/workhorse/go"
)

func registerEmailBatch(worker *workhorse.Worker, batchSize int, linger time.Duration) {
	worker.HandleBatch("email.send", workhorse.BatchHandlerOptions{
		MaxSize: batchSize, Linger: linger,
	}, func(items []workhorse.BatchHandlerItem) []workhorse.BatchHandlerOutcome {
		outcomes := make([]workhorse.BatchHandlerOutcome, len(items))
		for index, item := range items {
			outcomes[index] = workhorse.BatchSucceeded{Result: item.Payload}
		}
		return outcomes
	})
}`,

  batchHandlersRust: `use std::time::Duration;

use serde_json::Value;
use workhorse::{BatchItem, BatchOptions, BatchResult, Worker};

pub fn register_email_batch(worker: &Worker, batch_size: usize, linger: Duration) {
    worker.handle_batch(
        "email.send",
        BatchOptions { max_size: batch_size, linger },
        |items: Vec<BatchItem<Value>>| async move {
            items.into_iter().map(|item| BatchResult::Succeeded(item.payload)).collect()
        },
    );
}`,

  cancellation: `worker.handle("rows.export", async (payload, ctx) => {
  for (const row of payload.rows) {
    // Stop between items…
    if (ctx.signal.aborted) return { stopped: true };

    // …and mid-request.
    await upload(row, { signal: ctx.signal });
  }
  return { stopped: false };
});

// From an API route, a CLI, an operator script:
await queue.cancel(taskId, {
  requestedBy: "operator@example.com",
  reason: "customer withdrew the request",
});`,

  cancellationPython: `from workhorse import HandlerContext, Json, Queue, Worker


def configure_export(queue: Queue, worker: Worker, task_id: str) -> None:
    def export(payload: object, context: HandlerContext) -> dict[str, Json]:
        assert isinstance(payload, dict) and isinstance(payload["rows"], list)
        for row in payload["rows"]:
            context.cancellation.raise_if_cancelled()
            print("upload", row)
        return {"stopped": False}

    worker.handle("rows.export", export)
    queue.cancel(
        task_id,
        requested_by="operator@example.com",
        reason="customer withdrew the request",
    )`,

  cancellationGo: `package example

import (
	"context"
	"fmt"

	workhorse "github.com/stablemates/workhorse/go"
)

func configureExport(ctx context.Context, queue *workhorse.Queue, worker *workhorse.Worker, taskID string) error {
	worker.Handle("rows.export", func(
		handlerContext context.Context, payload any, _ *workhorse.HandlerContext,
	) (any, error) {
		if err := context.Cause(handlerContext); err != nil {
			return nil, err
		}
		fmt.Println("upload", payload)
		return map[string]any{"stopped": false}, nil
	})
	requestedBy, reason := "operator@example.com", "customer withdrew the request"
	_, err := queue.Cancel(ctx, taskID, workhorse.CancellationRequest{
		RequestedBy: &requestedBy, Reason: &reason,
	})
	return err
}`,

  cancellationRust: `use serde_json::{json, Value};
use uuid::Uuid;
use workhorse::deadpool_postgres::Pool;
use workhorse::{Error, Queue, Worker};

pub async fn configure_export(
    queue: &Queue<Pool>,
    worker: &Worker,
    task_id: Uuid,
) -> Result<(), Error> {
    worker.handle("rows.export", |rows: Vec<Value>, context| async move {
        for row in rows {
            if let Some(reason) = context.cancellation().reason() {
                return Err(Error::Cancelled(reason).into());
            }
            println!("upload {row}");
        }
        Ok(json!({ "stopped": false }))
    });

    let reason = Some("customer withdrew the request");
    queue.cancel(task_id, Some("operator@example.com"), reason).await?;
    Ok(())
}`,

  deadLetters: `const admin = new Admin(pool);
const page = await admin.listDeadLetters({
  queue: "billing",
  errorName: "CardDeclined",
});

for (const failure of page.items) {
  await admin.redrive(failure.taskId, {
    actor: "operator@example.com",
    reason: "provider incident resolved",
    requestId: \`incident-2026-08-03:\${failure.taskId}\`,
  });
}`,

  deadLettersPython: `from workhorse import Admin, AdminAudit, DeadLetterQuery


def redrive_billing(admin: Admin) -> None:
    page = admin.list_dead_letters(
        DeadLetterQuery(
            queue="billing",
            error_name="CardDeclined",
        )
    )
    for failure in page.items:
        admin.redrive(
            failure.task_id,
            AdminAudit(
                actor="operator@example.com",
                reason="provider incident resolved",
                request_id=f"incident-2026-08-03:{failure.task_id}",
            ),
        )`,

  deadLettersGo: `package example

import (
	"context"

	workhorse "github.com/stablemates/workhorse/go"
)

func redriveBilling(ctx context.Context, admin *workhorse.Admin) error {
	page, err := admin.ListDeadLetters(ctx, workhorse.DeadLetterQuery{
		DeadLetterFilter: workhorse.DeadLetterFilter{
			Queue: "billing", ErrorName: "CardDeclined",
		},
	})
	if err != nil {
		return err
	}
	for _, failure := range page.Items {
		if _, err := admin.Redrive(ctx, failure.TaskID, workhorse.AdminAudit{
			Actor:     "operator@example.com",
			Reason:    "provider incident resolved",
			RequestID: "incident-2026-08-03:" + failure.TaskID,
		}); err != nil {
			return err
		}
	}
	return nil
}`,

  deadLettersRust: `use workhorse::deadpool_postgres::Pool;
use workhorse::{Admin, AdminAudit, DeadLetterFilter, DeadLetterQuery, Error};

pub async fn redrive_billing(admin: &Admin<Pool>) -> Result<(), Error> {
    let filter = DeadLetterFilter {
        queue: Some("billing".into()),
        error_name: Some("CardDeclined".into()),
        ..Default::default()
    };
    let page =
        admin.list_dead_letters(DeadLetterQuery { filter, limit: 100, cursor: None }).await?;

    for failure in page.items {
        let audit = AdminAudit {
            actor: "operator@example.com".into(),
            reason: "provider incident resolved".into(),
            request_id: format!("incident-2026-08-03:{}", failure.task_id),
        };
        admin.redrive(failure.task_id, &audit).await?;
    }
    Ok(())
}`,

  operateDashboard: `import { createDashboardHost } from "@stablemates/workhorse-dashboard/server";

const host = createDashboardHost({
  path: "/workhorse",
  database: pool,
  authorize: (request) => isAdmin(request),
});

export async function GET(request: Request) {
  return (
    (await host.handle(request)) ??
    new Response("Not found", { status: 404 })
  );
}`,

  operateDashboardPython: `import os

import psycopg
from workhorse.dashboard import DashboardHost, DashboardPrincipal

connection = psycopg.connect(os.environ["DATABASE_URL"], autocommit=True)

dashboard = DashboardHost(
    connection,
    path="/workhorse",
    authorize=lambda environ: (
        DashboardPrincipal(actor=str(environ["REMOTE_USER"]))
        if environ.get("REMOTE_USER")
        else False
    ),
)`,

  operateDashboardGo: `package example

import (
	"net/http"

	workhorse "github.com/stablemates/workhorse/go"
	"github.com/stablemates/workhorse/go/dashboard"
)

type operatorContextKey struct{}

func mountDashboard(mux *http.ServeMux, executor workhorse.Executor) error {
	handler, err := dashboard.NewHandler(dashboard.HandlerOptions{
		Executor: executor,
		Path:     "/workhorse",
		Authorize: func(request *http.Request) dashboard.Authorization {
			actor, ok := request.Context().Value(operatorContextKey{}).(string)
			if !ok || actor == "" {
				return dashboard.Authorization{}
			}
			return dashboard.Authorization{
				Principal: &dashboard.Principal{Actor: actor},
			}
		},
	})
	if err != nil {
		return err
	}
	mux.Handle("/workhorse/", handler)
	return nil
}`,

  operateDashboardRust: `use workhorse::dashboard::{self, Authorization, DashboardOptions, Principal};
use workhorse::deadpool_postgres::Pool;

fn is_admin(request: &http::request::Parts) -> Option<String> {
    request.headers.get("x-admin").and_then(|value| value.to_str().ok()).map(str::to_owned)
}

pub fn mount(pool: Pool) -> Result<axum::Router, workhorse::Error> {
    let authorize = dashboard::authorize(|request| {
        let session = is_admin(request);
        async move {
            match session {
                Some(actor) => Authorization::Principal(Principal { actor }),
                None => Authorization::Unauthenticated,
            }
        }
    });
    let mut options = DashboardOptions::new(pool, authorize);
    options.path = "/workhorse".into();
    let host = dashboard::handler(options)?;
    Ok(axum::Router::new().nest_service("/workhorse", host))
}`,

  operateHealth: `const admin = new Admin(pool);
const health = await admin.health();

if (health.status.level !== "healthy") {
  for (const reason of health.status.reasons) {
    console.warn(reason.code, reason.observed);
  }
}

// Cross-state listing on a dedicated projection: reading it
// never slows dispatch down.
const live = await admin.listTasks({
  states: ["active", "scheduled"],
  limit: 100,
});`,

  operateHealthPython: `import psycopg

from workhorse import Admin, TaskListQuery, Queue


def inspect(database_url: str) -> None:
    with psycopg.connect(database_url) as connection:
        health = Queue(connection).health()
        print(health["status"])

        live = Admin(connection).list_tasks(
            TaskListQuery(
                states=("active", "scheduled"),
                limit=100,
            )
        )
        print(len(live.items))`,

  operateHealthGo: `package example

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

func inspect(ctx context.Context, pool *pgxpool.Pool) error {
	admin := workhorse.NewAdmin(workhorse.NewPGXExecutor(pool))
	health, err := admin.Health(ctx)
	if err != nil {
		return err
	}
	fmt.Println(health["status"])

	live, err := admin.ListTasks(ctx, workhorse.TaskListQuery{
		States: []workhorse.TaskState{"active", "scheduled"}, Limit: 100,
	})
	if err != nil {
		return err
	}
	fmt.Println(len(live.Items))
	return nil
}`,

  operateHealthRust: `use workhorse::deadpool_postgres::Pool;
use workhorse::{Admin, Error, Queue, TaskListQuery, TaskState};

pub async fn inspect(pool: &Pool) -> Result<(), Error> {
    let health = Queue::new(pool, "default").health().await?;
    if health["status"]["level"] != "healthy" {
        println!("{}", health["status"]["reasons"]);
    }

    // Cross-state listing on a dedicated projection: reading it never slows dispatch down.
    let live = Admin::new(pool)
        .list_tasks(TaskListQuery {
            states: vec![TaskState::Active, TaskState::Scheduled],
            limit: 100,
            ..Default::default()
        })
        .await?;
    println!("{}", live.items.len());
    Ok(())
}`,

  operateFleet: `const admin = new Admin(pool);
for (const entry of await admin.listWorkers()) {
  if (entry.queue !== "billing") continue;

  await admin.setWorkerPaused(entry.workerId, true, {
    actor: "operator@example.com",
    reason: "rolling deploy",
    requestId: \`deploy-2026-08-23:\${entry.workerId}\`,
  });
}`,

  operateFleetPython: `import psycopg

from workhorse import Admin, AdminAudit


def pause_billing(database_url: str) -> None:
    with psycopg.connect(database_url) as connection:
        admin = Admin(connection)
        for entry in admin.list_workers():
            if entry.queue != "billing":
                continue
            admin.set_worker_paused(
                entry.worker_id,
                True,
                AdminAudit(
                    actor="operator@example.com",
                    reason="rolling deploy",
                    request_id=f"deploy-2026-08-23:{entry.worker_id}",
                ),
            )`,

  operateFleetGo: `package example

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

func pauseBilling(ctx context.Context, pool *pgxpool.Pool) error {
	admin := workhorse.NewAdmin(workhorse.NewPGXExecutor(pool))
	workers, err := admin.ListWorkers(ctx)
	if err != nil {
		return err
	}
	for _, entry := range workers {
		if entry.Queue != "billing" {
			continue
		}
		if _, err := admin.SetWorkerPaused(ctx, entry.WorkerID, true, workhorse.AdminAudit{
			Actor:     "operator@example.com",
			Reason:    "rolling deploy",
			RequestID: "deploy-2026-08-23:" + entry.WorkerID,
		}); err != nil {
			return err
		}
	}
	return nil
}`,

  operateFleetRust: `use workhorse::deadpool_postgres::Pool;
use workhorse::{Admin, AdminAudit, Error};

pub async fn pause_billing(pool: &Pool) -> Result<(), Error> {
    let admin = Admin::new(pool);
    for entry in admin.list_workers().await? {
        if entry.queue != "billing" {
            continue;
        }
        let audit = AdminAudit {
            actor: "operator@example.com".into(),
            reason: "rolling deploy".into(),
            request_id: format!("deploy-2026-08-23:{}", entry.worker_id),
        };
        admin.set_worker_paused(&entry.worker_id, true, &audit).await?;
    }
    Ok(())
}`,

  ormDrizzle: `import { createDrizzleAdapter } from "@stablemates/workhorse-drizzle";
import { drizzle } from "drizzle-orm/node-postgres";

const db = drizzle({ client: pool });
const workhorse = createDrizzleAdapter(db);

await db.transaction(async (tx) => {
  await tx.insert(account).values({ id: accountId, email });
  await workhorse.forTransaction(tx).enqueue("account.created", {
    accountId,
  });
});`,

  ormPrisma: `import { PrismaClient } from "@prisma/client";
import { createPrismaAdapter } from "@stablemates/workhorse-prisma";

const prisma = new PrismaClient();
const workhorse = createPrismaAdapter(prisma);

await prisma.$transaction(async (tx) => {
  const account = await tx.account.create({ data: { email } });
  await workhorse.forTransaction(tx).enqueue("account.created", {
    accountId: account.id,
  });
});`,

  ormTypeorm: `import { createTypeOrmAdapter } from "@stablemates/workhorse-typeorm";

const workhorse = createTypeOrmAdapter(dataSource);

await dataSource.transaction(async (manager) => {
  const account = await manager.save(Account, { email });
  await workhorse.forTransaction(manager).enqueue("account.created", {
    accountId: account.id,
  });
});`,

  ormKysely: `import { createKyselyAdapter } from "@stablemates/workhorse-kysely";

const workhorse = createKyselyAdapter(database);

await database.transaction().execute(async (tx) => {
  const account = await tx
    .insertInto("account")
    .values({ email })
    .returning("id")
    .executeTakeFirstOrThrow();

  await workhorse.forTransaction(tx).enqueue("account.created", {
    accountId: account.id,
  });
});`,

  deploy: `// workhorse.worker.ts. Run with: workhorse worker --config ./dist/worker.js
import { createWorkhorseAdapter, defineWorkerProcess, Pool } from "@stablemates/workhorse";
import { generateReport, sendEmail } from "./tasks.js";

export default defineWorkerProcess({
  adapter() {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
    return createWorkhorseAdapter({
      database: pool,
      adaptTransaction: (tx) => tx,
      close: () => pool.end(),
    });
  },
  workers: [
    {
      options: { concurrency: 8 },
      configure: (worker) =>
        worker.handle("email.send", sendEmail).handle("report.generate", generateReport),
    },
  ],
  shutdownTimeoutMs: 25_000, // bounded graceful drain on SIGTERM
});`,

  deployPython: `import os

import psycopg
from psycopg_pool import ConnectionPool

from workhorse import HandlerContext, Json, Worker, run_worker_process


def send_email(payload: object, _context: HandlerContext) -> dict[str, Json]:
    assert isinstance(payload, dict)
    return {"deliveredTo": payload["to"]}


database_url = os.environ["DATABASE_URL"]
with ConnectionPool(
    database_url, min_size=3, max_size=3, kwargs={"autocommit": True}
) as pool:
    worker = Worker(
        pool,
        queues=("email",),
        concurrency=8,
    )
    worker.handle("email.send", send_email)
    run_worker_process(worker, shutdown_timeout_ms=25_000)`,

  deployGo: `package example

import (
	"context"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

func runWorker(ctx context.Context, pool *pgxpool.Pool) error {
	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{
		Queue:               "email",
		Concurrency:         8,
		ShutdownGracePeriod: 25 * time.Second,
	})
	if err != nil {
		return err
	}
	worker.Handle("email.send", func(
		_ context.Context,
		payload any,
		_ *workhorse.HandlerContext,
	) (any, error) {
		return payload, nil
	})

	runContext, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	return worker.Run(runContext)
}`,

  deployRust: `use std::time::Duration;

use serde_json::{json, Value};
use workhorse::deadpool_postgres::tokio_postgres::NoTls;
use workhorse::deadpool_postgres::{Manager, Pool};
use workhorse::{run_worker_process, Worker, WorkerOptions};

pub async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let url = std::env::var("DATABASE_URL")?;
    let pool = Pool::builder(Manager::new(url.parse()?, NoTls)).max_size(10).build()?;

    let worker = Worker::new(
        pool,
        WorkerOptions {
            queues: vec!["email".into()],
            concurrency: 8,
            // Bounded graceful drain on SIGTERM.
            shutdown_grace_period: Duration::from_secs(25),
            ..Default::default()
        },
    )?;
    worker.handle("email.send", |email: Value, _context| async move {
        Ok(json!({ "sent": email["to"] }))
    });
    run_worker_process(&worker).await?;
    Ok(())
}`,
} as const;

export type LandingSnippetId = keyof typeof landingSnippets;

/** One verified snippet per supported language for every numbered landing feature. */
export const landingFeatureSnippets = {
  enqueue: { typescript: "enqueue", python: "enqueuePython", go: "enqueueGo", rust: "enqueueRust" },
  checkpoints: {
    typescript: "checkpoints",
    python: "checkpointsPython",
    go: "checkpointsGo",
    rust: "checkpointsRust",
  },
  sleep: { typescript: "sleep", python: "sleepPython", go: "sleepGo", rust: "sleepRust" },
  retries: { typescript: "retries", python: "retriesPython", go: "retriesGo", rust: "retriesRust" },
  idempotency: {
    typescript: "idempotency",
    python: "idempotencyPython",
    go: "idempotencyGo",
    rust: "idempotencyRust",
  },
  schedules: {
    typescript: "schedules",
    python: "schedulesPython",
    go: "schedulesGo",
    rust: "schedulesRust",
  },
  flowControl: {
    typescript: "flowControl",
    python: "flowControlPython",
    go: "flowControlGo",
    rust: "flowControlRust",
  },
  dependencies: {
    typescript: "dependencies",
    python: "dependenciesPython",
    go: "dependenciesGo",
    rust: "dependenciesRust",
  },
  coalescing: {
    typescript: "coalescing",
    python: "coalescingPython",
    go: "coalescingGo",
    rust: "coalescingRust",
  },
  externalWaits: {
    typescript: "externalWaits",
    python: "externalWaitsPython",
    go: "externalWaitsGo",
    rust: "externalWaitsRust",
  },
  batchHandlers: {
    typescript: "batchHandlers",
    python: "batchHandlersPython",
    go: "batchHandlersGo",
    rust: "batchHandlersRust",
  },
  cancellation: {
    typescript: "cancellation",
    python: "cancellationPython",
    go: "cancellationGo",
    rust: "cancellationRust",
  },
  deadLetters: {
    typescript: "deadLetters",
    python: "deadLettersPython",
    go: "deadLettersGo",
    rust: "deadLettersRust",
  },
} as const satisfies Record<
  string,
  | { typescript: LandingSnippetId }
  | {
      typescript: LandingSnippetId;
      python: LandingSnippetId;
      go: LandingSnippetId;
      rust: LandingSnippetId;
    }
>;

export type LandingFeatureSnippetId = keyof typeof landingFeatureSnippets;

/** Other landing examples whose SDK behavior is supported in every language. */
export const landingSupplementalSnippets = {
  hero: { typescript: "hero", python: "heroPython", go: "heroGo", rust: "heroRust" },
  operateDashboard: {
    typescript: "operateDashboard",
    python: "operateDashboardPython",
    go: "operateDashboardGo",
    rust: "operateDashboardRust",
  },
  operateHealth: {
    typescript: "operateHealth",
    python: "operateHealthPython",
    go: "operateHealthGo",
    rust: "operateHealthRust",
  },
  operateFleet: {
    typescript: "operateFleet",
    python: "operateFleetPython",
    go: "operateFleetGo",
    rust: "operateFleetRust",
  },
  deploy: { typescript: "deploy", python: "deployPython", go: "deployGo", rust: "deployRust" },
} as const satisfies Record<
  string,
  {
    typescript: LandingSnippetId;
    python: LandingSnippetId;
    go: LandingSnippetId;
    rust: LandingSnippetId;
  }
>;

/** Shiki language overrides for snippets that are not TypeScript. */
export const landingSnippetLanguages: Partial<
  Record<LandingSnippetId, "python" | "go" | "rust" | "ts">
> = {
  heroPython: "python",
  heroGo: "go",
  heroRust: "rust",
  languagePython: "python",
  languageGo: "go",
  enqueuePython: "python",
  enqueueGo: "go",
  enqueueRust: "rust",
  checkpointsPython: "python",
  checkpointsGo: "go",
  checkpointsRust: "rust",
  sleepPython: "python",
  sleepGo: "go",
  sleepRust: "rust",
  retriesPython: "python",
  retriesGo: "go",
  retriesRust: "rust",
  idempotencyPython: "python",
  idempotencyGo: "go",
  idempotencyRust: "rust",
  schedulesPython: "python",
  schedulesGo: "go",
  schedulesRust: "rust",
  flowControlPython: "python",
  flowControlGo: "go",
  flowControlRust: "rust",
  dependenciesPython: "python",
  dependenciesGo: "go",
  dependenciesRust: "rust",
  coalescingPython: "python",
  coalescingGo: "go",
  coalescingRust: "rust",
  externalWaitsPython: "python",
  externalWaitsGo: "go",
  externalWaitsRust: "rust",
  batchHandlersPython: "python",
  batchHandlersGo: "go",
  batchHandlersRust: "rust",
  cancellationPython: "python",
  cancellationGo: "go",
  cancellationRust: "rust",
  deadLettersPython: "python",
  deadLettersGo: "go",
  deadLettersRust: "rust",
  operateDashboardPython: "python",
  operateDashboardGo: "go",
  operateDashboardRust: "rust",
  operateHealthPython: "python",
  operateHealthGo: "go",
  operateHealthRust: "rust",
  operateFleetPython: "python",
  operateFleetGo: "go",
  operateFleetRust: "rust",
  deployPython: "python",
  deployGo: "go",
  deployRust: "rust",
};
