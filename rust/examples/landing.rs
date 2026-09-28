//! The Rust snippets the site's landing page shows, compiled so that none of them can drift.
//!
//! Each `docs:start landing-<name>` region is one snippet, wrapped in a module so that it carries
//! its own `use` lines. `site/scripts/check-language-examples.ts` requires every Rust string in
//! `site/lib/landing-snippets.ts` to equal a dedented region, and every region to appear there.
#![allow(dead_code, unused_variables)]

mod landing_hero {
    // docs:start landing-hero
    use serde_json::{json, Value};
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
    }
    // docs:end
}

mod landing_enqueue {
    // docs:start landing-enqueue
    use serde_json::json;
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
    }
    // docs:end
}

mod landing_checkpoints {
    // docs:start landing-checkpoints
    use serde::Deserialize;
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
    }
    // docs:end
}

mod landing_sleep {
    // docs:start landing-sleep
    use std::time::Duration;

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
    }
    // docs:end
}

mod landing_retries {
    // docs:start landing-retries
    use chrono::{DateTime, Utc};
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
    }
    // docs:end
}

mod landing_idempotency {
    // docs:start landing-idempotency
    use serde_json::json;
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
    }
    // docs:end
}

mod landing_schedules {
    // docs:start landing-schedules
    use serde_json::json;
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
    }
    // docs:end
}

mod landing_flow_control {
    // docs:start landing-flow-control
    use serde_json::json;
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
    }
    // docs:end
}

mod landing_dependencies {
    // docs:start landing-dependencies
    use serde_json::{json, Value};
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
    }
    // docs:end
}

mod landing_coalescing {
    // docs:start landing-coalescing
    use serde_json::json;
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
    }
    // docs:end
}

mod landing_external_waits {
    // docs:start landing-external-waits
    use serde_json::{json, Value};
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
    }
    // docs:end
}

mod landing_batch_handlers {
    // docs:start landing-batch-handlers
    use std::time::Duration;

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
    }
    // docs:end
}

mod landing_cancellation {
    // docs:start landing-cancellation
    use serde_json::{json, Value};
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
    }
    // docs:end
}

mod landing_dead_letters {
    // docs:start landing-dead-letters
    use workhorse::deadpool_postgres::Pool;
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
    }
    // docs:end
}

#[cfg(feature = "dashboard")]
mod landing_operate_dashboard {
    // docs:start landing-operate-dashboard
    use workhorse::dashboard::{self, Authorization, DashboardOptions, Principal};
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
    }
    // docs:end
}

mod landing_operate_health {
    // docs:start landing-operate-health
    use workhorse::deadpool_postgres::Pool;
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
    }
    // docs:end
}

mod landing_operate_fleet {
    // docs:start landing-operate-fleet
    use workhorse::deadpool_postgres::Pool;
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
    }
    // docs:end
}

mod landing_deploy {
    // docs:start landing-deploy
    use std::time::Duration;

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
    }
    // docs:end
}

fn main() {}
