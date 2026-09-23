//! The Rust snippets the documentation shows, compiled so that none of them can drift.
//!
//! Each `docs:start <name>` region is one snippet. `site/scripts/check-language-examples.ts`
//! requires every ` ```rust ` fence in the site pages and guides to equal a dedented region, and
//! every region to appear in at least one fence. Code outside the regions only supplies the names a
//! snippet uses.
#![allow(dead_code, unused_variables)]

use std::collections::BTreeMap;
use std::future::Future;
use std::time::Duration;

use chrono::{DateTime, TimeZone, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_postgres::Client;
use uuid::Uuid;
use workhorse::contracts::{TaskContractVersion, TaskTypeContracts};
use workhorse::deadpool_postgres::Pool;
use workhorse::policies::{
    BudgetDefinition, ConcurrencyPolicyDefinition, RateLimit, RateLimitPolicyDefinition,
};
use workhorse::{
    run_worker_process, Admin, AdminAudit, BatchItem, BatchOptions, BatchResult,
    BulkRedriveOptions, DeadLetterFilter, DeadLetterQuery, Debounce, DebounceSchedule,
    Dependencies, DependencyTerminalPolicy, EnqueueOptions, EnqueueRequest, HandlerContext,
    HandlerError, Idempotency, Queue, ScheduleDefinition, ScheduledTask, Throttle, Worker,
    WorkerOptions,
};

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;

fn main() {}

struct Actor {
    email: String,
}

struct Recipient {
    email: String,
}

mod mailer {
    use serde_json::{json, Value};
    use workhorse::HandlerError;

    pub async fn send(payload: Value) -> Result<Value, HandlerError> {
        Ok(json!({ "sent": payload }))
    }
}

async fn send_email(
    payload: Value,
    _context: workhorse::HandlerContext,
) -> std::result::Result<Value, HandlerError> {
    mailer::send(payload).await
}

async fn upload_part(part: &str) -> std::result::Result<(), HandlerError> {
    Ok(())
}

#[derive(Deserialize)]
struct ExportPayload {
    parts: Vec<String>,
}

async fn enqueue_basics(
    queue: &Queue<Client>,
    invoice_id: &str,
    reminder_date: DateTime<Utc>,
) -> Result {
    // docs:start enqueue-basic
    queue
        .enqueue("email.send", &json!({ "to": "person@example.com" }), EnqueueOptions::default())
        .await?;
    queue
        .enqueue(
            "invoice.remind",
            &json!({ "invoiceId": invoice_id }),
            EnqueueOptions {
                queue: Some("billing".into()),
                run_at: Some(reminder_date),
                ..Default::default()
            },
        )
        .await?;
    // docs:end
    Ok(())
}

async fn enqueue_options(queue: &Queue<Client>, end_of_month: DateTime<Utc>) -> Result {
    // docs:start enqueue-options
    queue
        .enqueue(
            "report.generate",
            &json!({ "month": "2026-08" }),
            EnqueueOptions {
                queue: Some("reports".into()),
                tags: vec!["tenant:acme".into()],
                concurrency_key: Some("acme".into()),
                priority: 10,
                max_attempts: 5,
                deadline: Some(end_of_month),
                execution_timeout_ms: Some(120_000),
                ..Default::default()
            },
        )
        .await?;
    // docs:end
    Ok(())
}

async fn enqueue_transaction(client: &mut Client, id: Uuid, email: &str) -> Result {
    // docs:start enqueue-transaction
    let transaction = client.transaction().await?;
    transaction.execute("INSERT INTO account (id, email) VALUES ($1, $2)", &[&id, &email]).await?;
    Queue::new(&transaction, "default")
        .enqueue("account.created", &json!({ "accountId": id }), EnqueueOptions::default())
        .await?;
    transaction.commit().await?;
    // docs:end
    Ok(())
}

async fn enqueue_batch(queue: &Queue<Client>, recipients: &[Recipient]) -> Result {
    // docs:start enqueue-many
    let requests = recipients
        .iter()
        .map(|recipient| EnqueueRequest {
            task_type: "email.digest".into(),
            payload: json!({ "to": recipient.email }),
            options: EnqueueOptions { queue: Some("mail".into()), ..Default::default() },
        })
        .collect();
    let results = queue.enqueue_many(requests).await?;
    // docs:end
    Ok(())
}

async fn pause_and_resume(
    admin: &Admin<Client>,
    actor: &str,
    reason: &str,
    request_id: &str,
    resume_request_id: &str,
) -> Result {
    // docs:start enqueue-pause
    let audit =
        AdminAudit { actor: actor.into(), reason: reason.into(), request_id: request_id.into() };
    admin.pause_queue("billing", &audit).await?;
    let audit = AdminAudit { request_id: resume_request_id.into(), ..audit };
    admin.resume_queue("billing", &audit).await?;
    // docs:end
    Ok(())
}

async fn priority(queue: &Queue<Client>, invoice_id: &str) -> Result {
    // docs:start priority
    queue
        .enqueue(
            "invoice.remind",
            &json!({ "invoiceId": invoice_id }),
            EnqueueOptions { queue: Some("billing".into()), priority: 10, ..Default::default() },
        )
        .await?;
    // docs:end
    Ok(())
}

async fn retries(queue: &Queue<Client>, account_id: &str) -> Result {
    // docs:start retries-attempts
    queue
        .enqueue(
            "provider.sync",
            &json!({ "accountId": account_id }),
            EnqueueOptions { max_attempts: 5, ..Default::default() },
        )
        .await?;
    // docs:end
    // docs:start retries-policy
    let jitter =
        json!({ "type": "decorrelated-jitter", "baseDelayMs": 1_000, "maxDelayMs": 60_000 });
    queue
        .enqueue(
            "provider.sync",
            &json!({ "accountId": account_id }),
            EnqueueOptions {
                retry_policy: jitter.as_object().cloned(),
                max_attempts: 5,
                ..Default::default()
            },
        )
        .await?;
    // docs:end
    Ok(())
}

async fn deadlines(
    queue: &Queue<Client>,
    quote_id: &str,
    quote_expires_at: DateTime<Utc>,
    report_id: &str,
    attempt_timeout_ms: i64,
    attempt_budget: i32,
) -> Result {
    // docs:start deadlines-deadline
    queue
        .enqueue(
            "price.quote",
            &json!({ "quoteId": quote_id }),
            EnqueueOptions { deadline: Some(quote_expires_at), ..Default::default() },
        )
        .await?;
    // docs:end
    // docs:start deadlines-timeout
    queue
        .enqueue(
            "report.build",
            &json!({ "reportId": report_id }),
            EnqueueOptions {
                execution_timeout_ms: Some(attempt_timeout_ms),
                max_attempts: attempt_budget,
                ..Default::default()
            },
        )
        .await?;
    // docs:end
    Ok(())
}

async fn idempotency(queue: &Queue<Client>, invoice_id: &str, key: String) -> Result {
    // docs:start idempotency-key
    let result = queue
        .enqueue(
            "invoice.capture",
            &json!({ "invoiceId": invoice_id }),
            EnqueueOptions {
                queue: Some("billing".into()),
                idempotency: Some(Idempotency {
                    scope: "invoice-capture".into(),
                    ..Idempotency::new(format!("capture:{invoice_id}"))
                }),
                ..Default::default()
            },
        )
        .await?;
    // docs:end
    // docs:start idempotency-result
    let result = queue
        .enqueue(
            "invoice.capture",
            &json!({ "invoiceId": invoice_id }),
            EnqueueOptions {
                idempotency: Some(Idempotency {
                    scope: "invoice-capture".into(),
                    ..Idempotency::new(key)
                }),
                ..Default::default()
            },
        )
        .await?;
    println!("{:?} {}", result.outcome, result.task_id);
    // docs:end
    Ok(())
}

async fn debounce(
    queue: &Queue<Client>,
    document_id: &str,
    revision: i64,
    quiet_period_ms: i64,
) -> Result {
    // docs:start debounce
    let result = queue
        .enqueue(
            "search.reindex",
            &json!({ "documentId": document_id, "revision": revision }),
            EnqueueOptions {
                debounce: Some(Debounce {
                    scope: "search-index".into(),
                    ..Debounce::new(document_id, quiet_period_ms, DebounceSchedule::Reset)
                }),
                ..Default::default()
            },
        )
        .await?;
    // docs:end
    Ok(())
}

async fn throttle(queue: &Queue<Client>, account_id: &str, digest_window_ms: i64) -> Result {
    // docs:start throttle
    let result = queue
        .enqueue(
            "email.digest",
            &json!({ "accountId": account_id }),
            EnqueueOptions {
                throttle: Some(Throttle {
                    scope: "digest".into(),
                    ..Throttle::new(account_id, digest_window_ms)
                }),
                ..Default::default()
            },
        )
        .await?;
    // docs:end
    Ok(())
}

async fn task_dependencies(queue: &Queue<Client>) -> Result {
    // docs:start task-dependencies
    let import = queue
        .enqueue("contacts.import", &json!({ "source": "upload" }), EnqueueOptions::default())
        .await?;
    queue
        .enqueue(
            "contacts.notify",
            &json!({ "importId": import.task_id }),
            EnqueueOptions {
                dependencies: Some(Dependencies {
                    prerequisite_task_ids: vec![import.task_id],
                    on_success: DependencyTerminalPolicy::Release,
                    on_failure: DependencyTerminalPolicy::Fail,
                    on_cancellation: DependencyTerminalPolicy::Cancel,
                }),
                ..Default::default()
            },
        )
        .await?;
    // docs:end
    Ok(())
}

async fn concurrency_policies(queue: &Queue<Client>, message_id: &str, tenant_id: &str) -> Result {
    // docs:start concurrency-policy
    let policies = queue
        .sync_concurrency_policies(
            "workers",
            &[ConcurrencyPolicyDefinition {
                queue: "mail".into(),
                max_active: 20,
                max_active_per_key: Some(3),
            }],
            false,
        )
        .await?;
    // docs:end
    // docs:start concurrency-key
    queue
        .enqueue(
            "mail.send",
            &json!({ "messageId": message_id }),
            EnqueueOptions {
                queue: Some("mail".into()),
                concurrency_key: Some(tenant_id.into()),
                ..Default::default()
            },
        )
        .await?;
    // docs:end
    // docs:start concurrency-budget
    let budgets = queue
        .sync_budgets(
            "workers",
            &[BudgetDefinition { name: "vendor-api".into(), max_active: Some(4), rate: None }],
            false,
        )
        .await?;
    queue
        .enqueue(
            "invoice.sync",
            &json!({ "id": 1 }),
            EnqueueOptions {
                queue: Some("billing".into()),
                budget: Some("vendor-api".into()),
                ..Default::default()
            },
        )
        .await?;
    // docs:end
    Ok(())
}

async fn rate_limits(queue: &Queue<Client>) -> Result {
    // docs:start rate-limits
    let policies = queue
        .sync_rate_limit_policies(
            "workers",
            &[RateLimitPolicyDefinition {
                queue: "provider-api".into(),
                rate: RateLimit { limit: 60, interval_ms: 60_000, burst: 10 },
                per_key: Some(RateLimit { limit: 5, interval_ms: 60_000, burst: 2 }),
            }],
            false,
        )
        .await?;
    // docs:end
    Ok(())
}

async fn multi_tenancy(queue: &Queue<Client>) -> Result {
    // docs:start multi-tenancy
    let tenant = "acme";
    queue
        .sync_concurrency_policies(
            "workers",
            &[ConcurrencyPolicyDefinition {
                queue: "reports".into(),
                max_active: 40,
                max_active_per_key: Some(4),
            }],
            false,
        )
        .await?;
    queue
        .sync_budgets(
            "workers",
            &[BudgetDefinition { name: tenant.into(), max_active: Some(8), rate: None }],
            false,
        )
        .await?;
    queue
        .enqueue(
            "report.generate",
            &json!({ "month": "2026-08" }),
            EnqueueOptions {
                queue: Some("reports".into()),
                concurrency_key: Some(tenant.into()),
                budget: Some(tenant.into()),
                tags: vec![format!("tenant:{tenant}")],
                ..Default::default()
            },
        )
        .await?;
    // docs:end
    Ok(())
}

async fn contracts(queue: &Queue<Client>) -> Result {
    // docs:start contracts
    let contracts = BTreeMap::from([(
        "mail.send".to_string(),
        TaskTypeContracts {
            current_version: "mail-current".into(),
            versions: BTreeMap::from([(
                "mail-current".to_string(),
                TaskContractVersion {
                    payload_schema: json!({ "type": "object", "required": ["recipient"] }),
                    result_schema: json!({ "type": "object" }),
                    sensitive_payload_keys: vec!["accessToken".into()],
                    ..Default::default()
                },
            )]),
        },
    )]);
    queue.sync_contracts(&contracts).await?;
    // docs:end
    Ok(())
}

async fn schedules(queue: &Queue<Client>, pool: Pool, nightly_cron: &str) -> Result {
    // docs:start schedules-sync
    let mut task = ScheduledTask::new("invoice.generate", json!({ "scope": "due" }));
    task.queue = Some("billing".into());
    let mut schedule = ScheduleDefinition::new("invoice-run", nightly_cron, task);
    schedule.timezone = "America/New_York".into();
    queue.sync_schedules("billing-production", vec![schedule], true).await?;
    // docs:end
    // docs:start schedules-worker
    let worker = Worker::new(
        pool,
        WorkerOptions {
            schedule_namespaces: vec!["billing-production".into()],
            ..Default::default()
        },
    )?;
    // docs:end
    Ok(())
}

async fn cancel(queue: &Queue<Client>, task_id: Uuid, actor: &Actor) -> Result {
    // docs:start cancellation-request
    let result =
        queue.cancel(task_id, Some(&actor.email), Some("customer withdrew the order")).await?;
    // docs:end
    Ok(())
}

async fn export(
    payload: ExportPayload,
    ctx: HandlerContext,
) -> std::result::Result<Value, HandlerError> {
    // docs:start cancellation-handler
    for part in &payload.parts {
        if let Some(reason) = ctx.cancellation().reason() {
            return Err(workhorse::Error::Cancelled(reason).into());
        }
        upload_part(part).await?;
    }
    // docs:end
    Ok(json!({ "exported": true }))
}

async fn queue_health(queue: &Queue<Client>) -> Result {
    // docs:start queue-health
    let health = queue.health().await?;
    let status = &health["status"];
    if status["level"] != "healthy" {
        eprintln!("{}", status["reasons"]);
    }
    // docs:end
    Ok(())
}

async fn dead_letters(
    admin: &Admin<Client>,
    source_task_id: Uuid,
    actor: &Actor,
    incident_id: &str,
    page_size: u32,
) -> Result {
    // docs:start dead-letters-list
    let finished_after = Utc.with_ymd_and_hms(2026, 8, 12, 9, 0, 0).unwrap();
    let page = admin
        .list_dead_letters(DeadLetterQuery {
            filter: DeadLetterFilter {
                queue: Some("billing".into()),
                error_name: Some("ProviderTimeout".into()),
                finished_after: Some(finished_after),
                ..Default::default()
            },
            ..Default::default()
        })
        .await?;
    // docs:end
    // docs:start dead-letters-redrive
    let audit = AdminAudit {
        actor: actor.email.clone(),
        reason: "provider incident resolved".into(),
        request_id: incident_id.into(),
    };
    let result = admin.redrive(source_task_id, &audit).await?;
    // docs:end
    // docs:start dead-letters-redrive-many
    let filter = DeadLetterFilter {
        queue: Some("billing".into()),
        error_name: Some("ProviderTimeout".into()),
        ..Default::default()
    };
    let audit = AdminAudit {
        actor: actor.email.clone(),
        reason: "provider incident resolved".into(),
        request_id: incident_id.into(),
    };
    let preview = admin
        .redrive_many(
            filter.clone(),
            &audit,
            BulkRedriveOptions { dry_run: true, limit: page_size, ..Default::default() },
        )
        .await?;
    let page = admin
        .redrive_many(filter, &audit, BulkRedriveOptions { limit: page_size, ..Default::default() })
        .await?;
    // docs:end
    Ok(())
}

async fn operations(url: &str, actor: &Actor, incident_id: &str) -> Result {
    // docs:start operations
    let admin = Admin::connect(url).await?;
    let workers = admin.list_workers().await?;
    let audit = AdminAudit {
        actor: actor.email.clone(),
        reason: "investigating slow provider".into(),
        request_id: incident_id.into(),
    };
    let result = admin.set_worker_paused("billing-worker-1", true, &audit).await?;
    // docs:end
    Ok(())
}

async fn installation(url: &str) -> Result {
    // docs:start installation-compatibility
    let queue = Queue::connect(url, "default").await?;
    queue.assert_compatible().await?;
    // docs:end
    Ok(())
}

async fn workers_run(
    pool: Pool,
    worker_concurrency: usize,
    shutdown: impl Future<Output = ()> + Send,
) -> Result {
    // docs:start workers-run
    let worker = Worker::new(
        pool,
        WorkerOptions {
            queues: vec!["email".into(), "billing".into()],
            concurrency: worker_concurrency,
            ..Default::default()
        },
    )?;
    worker.handle("email.send", |payload: Value, _context| mailer::send(payload));
    worker.run(shutdown).await?;
    // docs:end
    Ok(())
}

async fn workers_options(
    pool: Pool,
    worker_concurrency: usize,
    worker_lease_duration: Duration,
) -> Result {
    // docs:start workers-options
    let worker = Worker::new(
        pool,
        WorkerOptions {
            queues: vec!["email".into(), "billing".into()],
            concurrency: worker_concurrency,
            lease_duration: worker_lease_duration,
            worker_id: Some("email-worker-1".into()),
            ..Default::default()
        },
    )?;
    // docs:end
    Ok(())
}

async fn workers_process(pool: Pool, worker_concurrency: usize) -> Result {
    // docs:start workers-process
    let worker = Worker::new(
        pool,
        WorkerOptions {
            queues: vec!["email".into(), "billing".into()],
            concurrency: worker_concurrency,
            ..Default::default()
        },
    )?;
    worker.handle("email.send", send_email);
    run_worker_process(&worker).await?;
    // docs:end
    Ok(())
}

fn batch_handlers(worker: &Worker) {
    // docs:start batch-handlers
    worker.handle_batch(
        "email.send",
        BatchOptions { max_size: 20, linger: Duration::from_millis(50) },
        |items: Vec<BatchItem<Value>>| async move {
            items.iter().map(|_| BatchResult::Succeeded(json!({ "sent": true }))).collect()
        },
    );
    // docs:end
}

mod example_transaction {
    // docs:start examples-transaction
    use serde_json::json;
    use workhorse::deadpool_postgres::Pool;
    use workhorse::{EnqueueOptions, Queue};

    pub async fn create_order(
        pool: &Pool,
        order_id: &str,
        items: &[String],
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut client = pool.get().await?;
        let transaction = client.transaction().await?;
        transaction
            .execute("INSERT INTO orders (id, items) VALUES ($1, $2)", &[&order_id, &items])
            .await?;
        Queue::new(&transaction, "orders")
            .enqueue("order.fulfill", &json!({ "orderId": order_id }), EnqueueOptions::default())
            .await?;
        transaction.commit().await?;
        Ok(())
    }
    // docs:end
}

mod example_schedule {
    // docs:start examples-schedule
    use serde_json::{json, Value};
    use workhorse::deadpool_postgres::Pool;
    use workhorse::{
        run_worker_process, Queue, ScheduleDefinition, ScheduledTask, Worker, WorkerOptions,
    };

    pub async fn run_billing_worker(pool: Pool) -> Result<(), Box<dyn std::error::Error>> {
        let queue = Queue::new(pool.clone(), "billing");
        let mut task = ScheduledTask::new("invoice.generate", json!({ "scope": "due" }));
        task.queue = Some("billing".into());
        let schedule = ScheduleDefinition::new("nightly-invoice-run", "0 3 * * *", task);
        queue.sync_schedules("billing-production", vec![schedule], false).await?;

        let worker = Worker::new(
            pool,
            WorkerOptions {
                queues: vec!["billing".into()],
                schedule_namespaces: vec!["billing-production".into()],
                ..Default::default()
            },
        )?;
        worker.handle("invoice.generate", |payload: Value, _context| async move {
            Ok(json!({ "generated": true, "payload": payload }))
        });
        run_worker_process(&worker).await?;
        Ok(())
    }
    // docs:end
}

mod example_webhook {
    // docs:start examples-webhook
    use serde_json::{json, Value};
    use workhorse::deadpool_postgres::Pool;
    use workhorse::{EnqueueOptions, Idempotency, Queue};

    pub struct StripeEvent {
        pub id: String,
        pub event_type: String,
        pub data: Value,
    }

    pub async fn handle_stripe_webhook(
        queue: &Queue<Pool>,
        event: &StripeEvent,
    ) -> Result<Value, workhorse::Error> {
        let result = queue
            .enqueue(
                "stripe.event",
                &json!({ "eventId": event.id, "eventType": event.event_type }),
                EnqueueOptions {
                    queue: Some("webhooks".into()),
                    idempotency: Some(Idempotency {
                        scope: "stripe-webhooks".into(),
                        ..Idempotency::new(format!("stripe:{}", event.id))
                    }),
                    ..Default::default()
                },
            )
            .await?;
        Ok(json!({ "accepted": result.task_id }))
    }
    // docs:end
}

mod example_incident {
    // docs:start examples-incident
    use workhorse::deadpool_postgres::Pool;
    use workhorse::{Admin, AdminAudit, BulkRedriveOptions, DeadLetterFilter};

    pub async fn redrive_incident(admin: &Admin<Pool>) -> Result<(), workhorse::Error> {
        let filter = DeadLetterFilter {
            queue: Some("billing".into()),
            error_name: Some("ProviderTimeout".into()),
            ..Default::default()
        };
        let audit = AdminAudit {
            actor: "reviewer@example.com".into(),
            reason: "provider incident INC-2041 resolved".into(),
            request_id: "INC-2041".into(),
        };
        let preview = admin
            .redrive_many(
                filter.clone(),
                &audit,
                BulkRedriveOptions { dry_run: true, limit: 100, cursor: None },
            )
            .await?;
        println!("{} tasks eligible", preview.results.len());

        let mut cursor = None;
        loop {
            let page = admin
                .redrive_many(
                    filter.clone(),
                    &audit,
                    BulkRedriveOptions { dry_run: false, limit: 100, cursor },
                )
                .await?;
            for result in &page.results {
                println!(
                    "{:?} {} -> {:?}",
                    result.status, result.source_task_id, result.target_task_id
                );
            }
            cursor = page.next_cursor;
            if cursor.is_none() {
                return Ok(());
            }
        }
    }
    // docs:end
}

mod example_export {
    // docs:start examples-export
    use serde::Deserialize;
    use serde_json::json;
    use tokio_postgres::Client;
    use uuid::Uuid;
    use workhorse::{HandlerError, Queue, Worker};

    #[derive(Deserialize)]
    struct Export {
        parts: Vec<String>,
    }

    async fn upload_part(part: &str) -> Result<(), HandlerError> {
        println!("uploading {part}");
        Ok(())
    }

    pub async fn configure_export(
        queue: &Queue<Client>,
        worker: &Worker,
        task_id: Uuid,
    ) -> Result<(), workhorse::Error> {
        queue
            .cancel(task_id, Some("support@example.com"), Some("customer withdrew the order"))
            .await?;

        worker.handle("export.build", |export: Export, context| async move {
            for part in &export.parts {
                if let Some(reason) = context.cancellation().reason() {
                    return Err(workhorse::Error::Cancelled(reason).into());
                }
                upload_part(part).await?;
            }
            Ok(json!({ "exported": true }))
        });
        Ok(())
    }
    // docs:end
}

mod quickstart_order {
    // docs:start quickstart-transaction
    use serde_json::json;
    use workhorse::deadpool_postgres::Pool;
    use workhorse::{EnqueueOptions, Queue};

    pub async fn create_order(
        pool: &Pool,
        order_id: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut client = pool.get().await?;
        let transaction = client.transaction().await?;
        transaction.execute("INSERT INTO orders (id) VALUES ($1)", &[&order_id]).await?;
        Queue::new(&transaction, "default")
            .enqueue("order.fulfill", &json!({ "orderId": order_id }), EnqueueOptions::default())
            .await?;
        transaction.commit().await?;
        Ok(())
    }
    // docs:end
}
