//! The Rust snippets the documentation shows, compiled so that none of them can drift.
//!
//! Each `docs:start <name>` region is one snippet. `site/scripts/check-language-examples.ts`
//! requires every ` ```rust ` fence in the site pages and guides to equal a dedented region, and
//! every region to appear in at least one fence. Code outside the regions only supplies the names a
//! snippet uses.
//!
//! Documentation: https://workhorse.run/docs
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
    BulkRedriveOptions, ChildOutcome, ChildTaskRequest, DeadLetterFilter, DeadLetterQuery,
    Debounce, DebounceSchedule, Dependencies, DependencyTerminalPolicy, EnqueueOptions,
    EnqueueRequest, HandlerContext, HandlerError, Idempotency, Queue, ScheduleDefinition,
    ScheduledTask, TaskGroupCallbacks, TaskState, Throttle, Worker, WorkerOptions,
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

    pub async fn welcome(to: &str) -> Result<Value, HandlerError> {
        Ok(json!({ "deliveredTo": to, "kind": "welcome" }))
    }

    pub async fn follow_up(to: &str) -> Result<Value, HandlerError> {
        Ok(json!({ "deliveredTo": to, "kind": "follow-up" }))
    }

    pub async fn receipt(
        to: &str,
        charge: &Value,
        tracking_number: &str,
    ) -> Result<Value, HandlerError> {
        Ok(json!({ "deliveredTo": to, "charge": charge, "trackingNumber": tracking_number }))
    }
}

mod payments {
    use serde_json::{json, Value};
    use workhorse::HandlerError;

    pub async fn charge(order_id: &str, idempotency_key: String) -> Result<Value, HandlerError> {
        Ok(json!({ "orderId": order_id, "idempotencyKey": idempotency_key }))
    }
}

mod logistics {
    use serde_json::{json, Value};
    use workhorse::HandlerError;

    pub async fn create_shipment(order_id: &str, charge: &Value) -> Result<Value, HandlerError> {
        Ok(json!({ "orderId": order_id, "charge": charge }))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlacedOrder {
    order_id: String,
    email: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Shipped {
    tracking_number: String,
}

struct Order {
    id: String,
}

struct Trial {
    to: String,
    follow_up_at: DateTime<Utc>,
}

struct Import {
    source: String,
}

struct ImportFile {
    rows: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportReport {
    import_id: String,
}

#[derive(Deserialize)]
struct ProviderEvent {
    id: String,
}

async fn publish_order() -> std::result::Result<(), HandlerError> {
    Ok(())
}

async fn activate_account(account_id: &str) -> std::result::Result<(), HandlerError> {
    Ok(())
}

async fn read_batches(source: &str) -> std::result::Result<Vec<Vec<Value>>, HandlerError> {
    Ok(Vec::new())
}

async fn import_batch(batch: &[Value]) -> std::result::Result<(), HandlerError> {
    Ok(())
}

async fn call_model(prompt: &str) -> std::result::Result<Value, HandlerError> {
    Ok(json!({ "prompt": prompt }))
}

async fn send_email(
    payload: Value,
    _context: workhorse::HandlerContext,
) -> std::result::Result<Value, HandlerError> {
    mailer::send(payload).await
}

async fn send_report(
    import_id: &str,
    succeeded: u32,
    failed: u32,
) -> std::result::Result<(), HandlerError> {
    Ok(())
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
    let mut options = EnqueueOptions::default();
    options.queue = Some("billing".into());
    options.run_at = Some(reminder_date);
    queue.enqueue("invoice.remind", &json!({ "invoiceId": invoice_id }), options).await?;
    // docs:end
    Ok(())
}

async fn enqueue_options(queue: &Queue<Client>, end_of_month: DateTime<Utc>) -> Result {
    // docs:start enqueue-options
    let mut options = EnqueueOptions::default();
    options.queue = Some("reports".into());
    options.tags = vec!["tenant:acme".into()];
    options.concurrency_key = Some("acme".into());
    options.priority = 10;
    options.max_attempts = 5;
    options.deadline = Some(end_of_month);
    options.execution_timeout_ms = Some(120_000);
    queue.enqueue("report.generate", &json!({ "month": "2026-08" }), options).await?;
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
        .map(|recipient| {
            let mut request = EnqueueRequest::new("email.digest", json!({ "to": recipient.email }));
            request.options.queue = Some("mail".into());
            request
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
    let mut options = EnqueueOptions::default();
    options.queue = Some("billing".into());
    options.priority = 10;
    queue.enqueue("invoice.remind", &json!({ "invoiceId": invoice_id }), options).await?;
    // docs:end
    Ok(())
}

async fn retries(queue: &Queue<Client>, account_id: &str) -> Result {
    // docs:start retries-attempts
    let mut options = EnqueueOptions::default();
    options.max_attempts = 5;
    queue.enqueue("provider.sync", &json!({ "accountId": account_id }), options).await?;
    // docs:end
    // docs:start retries-policy
    let jitter =
        json!({ "type": "decorrelated-jitter", "baseDelayMs": 1_000, "maxDelayMs": 60_000 });
    let mut options = EnqueueOptions::default();
    options.retry_policy = jitter.as_object().cloned();
    options.max_attempts = 5;
    queue.enqueue("provider.sync", &json!({ "accountId": account_id }), options).await?;
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
    let mut options = EnqueueOptions::default();
    options.deadline = Some(quote_expires_at);
    queue.enqueue("price.quote", &json!({ "quoteId": quote_id }), options).await?;
    // docs:end
    // docs:start deadlines-timeout
    let mut options = EnqueueOptions::default();
    options.execution_timeout_ms = Some(attempt_timeout_ms);
    options.max_attempts = attempt_budget;
    queue.enqueue("report.build", &json!({ "reportId": report_id }), options).await?;
    // docs:end
    Ok(())
}

async fn idempotency(queue: &Queue<Client>, invoice_id: &str, key: String) -> Result {
    // docs:start idempotency-key
    let mut options = EnqueueOptions::default();
    options.queue = Some("billing".into());
    let mut idempotency = Idempotency::new(format!("capture:{invoice_id}"));
    idempotency.scope = "invoice-capture".into();
    options.idempotency = Some(idempotency);
    let result =
        queue.enqueue("invoice.capture", &json!({ "invoiceId": invoice_id }), options).await?;
    // docs:end
    // docs:start idempotency-result
    let mut options = EnqueueOptions::default();
    let mut idempotency = Idempotency::new(key);
    idempotency.scope = "invoice-capture".into();
    options.idempotency = Some(idempotency);
    let result =
        queue.enqueue("invoice.capture", &json!({ "invoiceId": invoice_id }), options).await?;
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
    let mut options = EnqueueOptions::default();
    let mut debounce = Debounce::new(document_id, quiet_period_ms, DebounceSchedule::Reset);
    debounce.scope = "search-index".into();
    options.debounce = Some(debounce);
    let result = queue
        .enqueue(
            "search.reindex",
            &json!({ "documentId": document_id, "revision": revision }),
            options,
        )
        .await?;
    // docs:end
    Ok(())
}

async fn throttle(queue: &Queue<Client>, account_id: &str, digest_window_ms: i64) -> Result {
    // docs:start throttle
    let mut options = EnqueueOptions::default();
    let mut throttle = Throttle::new(account_id, digest_window_ms);
    throttle.scope = "digest".into();
    options.throttle = Some(throttle);
    let result =
        queue.enqueue("email.digest", &json!({ "accountId": account_id }), options).await?;
    // docs:end
    Ok(())
}

async fn task_dependencies(queue: &Queue<Client>) -> Result {
    // docs:start task-dependencies
    let import = queue
        .enqueue("contacts.import", &json!({ "source": "upload" }), EnqueueOptions::default())
        .await?;
    let mut options = EnqueueOptions::default();
    options.dependencies = Some(Dependencies::new(
        vec![import.task_id],
        DependencyTerminalPolicy::Release,
        DependencyTerminalPolicy::Fail,
        DependencyTerminalPolicy::Cancel,
    ));
    queue.enqueue("contacts.notify", &json!({ "importId": import.task_id }), options).await?;
    // docs:end
    Ok(())
}

async fn concurrency_policies(queue: &Queue<Client>, message_id: &str, tenant_id: &str) -> Result {
    // docs:start concurrency-policy
    let mut policy = ConcurrencyPolicyDefinition::new("mail", 20);
    policy.max_active_per_key = Some(3);
    let policies = queue.sync_concurrency_policies("workers", &[policy], false).await?;
    // docs:end
    // docs:start concurrency-key
    let mut options = EnqueueOptions::default();
    options.queue = Some("mail".into());
    options.concurrency_key = Some(tenant_id.into());
    queue.enqueue("mail.send", &json!({ "messageId": message_id }), options).await?;
    // docs:end
    // docs:start concurrency-budget
    let mut budget = BudgetDefinition::new("vendor-api");
    budget.max_active = Some(4);
    let budgets = queue.sync_budgets("workers", &[budget], false).await?;
    let mut options = EnqueueOptions::default();
    options.queue = Some("billing".into());
    options.budget = Some("vendor-api".into());
    queue.enqueue("invoice.sync", &json!({ "id": 1 }), options).await?;
    // docs:end
    Ok(())
}

async fn rate_limits(queue: &Queue<Client>) -> Result {
    // docs:start rate-limits
    let rate = RateLimit { limit: 60, interval_ms: 60_000, burst: 10 };
    let mut policy = RateLimitPolicyDefinition::new("provider-api", rate);
    policy.per_key = Some(RateLimit { limit: 5, interval_ms: 60_000, burst: 2 });
    let policies = queue.sync_rate_limit_policies("workers", &[policy], false).await?;
    // docs:end
    Ok(())
}

async fn multi_tenancy(queue: &Queue<Client>) -> Result {
    // docs:start multi-tenancy
    let tenant = "acme";
    let mut policy = ConcurrencyPolicyDefinition::new("reports", 40);
    policy.max_active_per_key = Some(4);
    queue.sync_concurrency_policies("workers", &[policy], false).await?;
    let mut budget = BudgetDefinition::new(tenant);
    budget.max_active = Some(8);
    queue.sync_budgets("workers", &[budget], false).await?;
    let mut options = EnqueueOptions::default();
    options.queue = Some("reports".into());
    options.concurrency_key = Some(tenant.into());
    options.budget = Some(tenant.into());
    options.tags = vec![format!("tenant:{tenant}")];
    queue.enqueue("report.generate", &json!({ "month": "2026-08" }), options).await?;
    // docs:end
    Ok(())
}

async fn contracts(queue: &Queue<Client>) -> Result {
    // docs:start contracts
    let mut task_type_contracts = TaskTypeContracts::default();
    task_type_contracts.current_version = "mail-current".into();
    let mut version = TaskContractVersion::default();
    version.payload_schema = json!({ "type": "object", "required": ["recipient"] });
    version.result_schema = json!({ "type": "object" });
    version.sensitive_payload_keys = vec!["accessToken".into()];
    task_type_contracts.versions = BTreeMap::from([("mail-current".to_string(), version)]);
    let contracts = BTreeMap::from([("mail.send".to_string(), task_type_contracts)]);
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
    let mut options = WorkerOptions::default();
    options.schedule_namespaces = vec!["billing-production".into()];
    let worker = Worker::new(pool, options)?;
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

/// The fallback arm that `docs/upgrading.md` shows. That page is outside the region check, so this
/// copy only proves that the code compiles.
async fn upgrading_match(admin: &Admin<Client>, task_id: Uuid) -> Result {
    let Some(task) = admin.get_task(task_id).await? else { return Ok(()) };
    let summary = match task.state {
        TaskState::Succeeded => "done",
        TaskState::Failed | TaskState::Canceled => "stopped",
        // A later release can add a state, so the match needs a fallback arm.
        _ => "open",
    };
    println!("{task_id}: {summary}");
    Ok(())
}

async fn dead_letters(admin: &Admin<Client>, source_task_id: Uuid) -> Result {
    // docs:start dead-letters-list
    let finished_after = Utc.with_ymd_and_hms(2026, 3, 14, 9, 0, 0).unwrap();
    let mut query = DeadLetterQuery::default();
    let mut dead_letter_filter = DeadLetterFilter::default();
    dead_letter_filter.queue = Some("payments".into());
    dead_letter_filter.error_name = Some("ProviderTimeout".into());
    dead_letter_filter.finished_after = Some(finished_after);
    query.filter = dead_letter_filter;
    let page = admin.list_dead_letters(query).await?;
    // docs:end
    // docs:start dead-letters-redrive
    let audit = AdminAudit {
        actor: "ops@example.com".into(),
        reason: "Provider outage ended".into(),
        request_id: "r-77".into(),
    };
    let result = admin.redrive(source_task_id, &audit).await?;
    // docs:end
    // docs:start dead-letters-redrive-many
    let mut filter = DeadLetterFilter::default();
    filter.queue = Some("payments".into());
    filter.error_name = Some("ProviderTimeout".into());
    let audit = AdminAudit {
        actor: "ops@example.com".into(),
        reason: "Provider outage ended".into(),
        request_id: "outage-0314".into(),
    };
    let mut redrive = BulkRedriveOptions::default();
    redrive.dry_run = true;
    redrive.limit = 100;
    let preview = admin.redrive_many(filter.clone(), &audit, redrive).await?;
    let mut redrive = BulkRedriveOptions::default();
    redrive.limit = 100;
    let mut page = admin.redrive_many(filter.clone(), &audit, redrive).await?;
    while let Some(cursor) = page.next_cursor {
        let mut redrive = BulkRedriveOptions::default();
        redrive.limit = 100;
        redrive.cursor = Some(cursor);
        page = admin.redrive_many(filter.clone(), &audit, redrive).await?;
    }
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
    let mut options = WorkerOptions::default();
    options.queues = vec!["email".into(), "billing".into()];
    options.concurrency = worker_concurrency;
    let worker = Worker::new(pool, options)?;
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
    let mut options = WorkerOptions::default();
    options.queues = vec!["email".into(), "billing".into()];
    options.concurrency = worker_concurrency;
    options.lease_duration = worker_lease_duration;
    options.worker_id = Some("email-worker-1".into());
    let worker = Worker::new(pool, options)?;
    // docs:end
    Ok(())
}

async fn workers_process(pool: Pool, worker_concurrency: usize) -> Result {
    // docs:start workers-process
    let mut options = WorkerOptions::default();
    options.queues = vec!["email".into(), "billing".into()];
    options.concurrency = worker_concurrency;
    let worker = Worker::new(pool, options)?;
    worker.handle("email.send", send_email);
    run_worker_process(&worker).await?;
    // docs:end
    Ok(())
}

fn batch_handlers(worker: &Worker) {
    // docs:start batch-handlers
    worker.handle_batch(
        "email.send",
        BatchOptions::new(20, Duration::from_millis(50)),
        |items: Vec<BatchItem<Value>>| async move {
            items.iter().map(|_| BatchResult::Succeeded(json!({ "sent": true }))).collect()
        },
    );
    // docs:end
}

async fn batch_handlers_enqueue(queue: &Queue<Client>) -> Result {
    // docs:start batch-handlers-enqueue
    let mut options = EnqueueOptions::default();
    options.queue = Some("email".into());
    queue.enqueue("email.send", &json!({ "to": "person@example.com" }), options).await?;
    // docs:end
    Ok(())
}

async fn task_groups(queue: &Queue<Client>, file: &ImportFile) -> Result {
    // docs:start task-groups
    let mut options = EnqueueOptions::default();
    options.queue = Some("imports".into());
    let imports = options;
    let rows = file
        .rows
        .iter()
        .map(|row| {
            EnqueueRequest::new("imports.row", json!({ "importId": "imp-7", "row": row }))
                .with_options(imports.clone())
        })
        .collect();
    let report =
        EnqueueRequest::new("imports.report", json!({ "importId": "imp-7" })).with_options(imports);

    let mut callbacks = TaskGroupCallbacks::default();
    callbacks.on_finish = Some(report);
    let group = queue.task_group(callbacks, rows).await?.group;
    // docs:end
    Ok(())
}

fn task_groups_report(worker: &Worker) {
    // docs:start task-groups-report
    worker.handle("imports.report", |report: ImportReport, context| async move {
        let link = context.task_group().get().await?;
        let counts = link.ok_or_else(|| HandlerError::new("no task group"))?.group.counts;
        send_report(&report.import_id, counts.succeeded, counts.failed).await?;
        Ok(json!({ "sent": true }))
    });
    // docs:end
}

async fn durable_checkpoints(
    context: HandlerContext,
    order: Order,
) -> std::result::Result<Value, HandlerError> {
    // docs:start durable-checkpoint
    let charge: Value = context
        .checkpoint("charge", || payments::charge(&order.id, format!("charge:{}", order.id)))
        .await?;
    let shipment: Value =
        context.checkpoint("shipment", || logistics::create_shipment(&order.id, &charge)).await?;
    // docs:end
    Ok(shipment)
}

async fn overview_fulfill(
    queue: &Queue<Client>,
    worker: &Worker,
    order_id: &str,
    email: &str,
    merchant_id: &str,
) -> Result {
    // docs:start overview-fulfill
    // Step 1: allow three active fulfillments per merchant, across all workers.
    // PostgreSQL applies this limit when a worker claims a task.
    let mut policy = ConcurrencyPolicyDefinition::new("fulfillment", 20);
    policy.max_active_per_key = Some(3);
    queue.sync_concurrency_policies("shop", &[policy], false).await?;

    // Enqueue the task. The merchant is the concurrency key.
    let mut options = EnqueueOptions::default();
    options.queue = Some("fulfillment".into());
    options.concurrency_key = Some(merchant_id.into());
    queue
        .enqueue("order.fulfill", &json!({ "orderId": order_id, "email": email }), options)
        .await?;

    worker.handle("order.fulfill", |order: PlacedOrder, context| async move {
        // Step 2: charge the card. The checkpoint stores the charge.
        // On a later run, it returns the stored charge, and the handler
        // does not charge the card a second time.
        let key = format!("charge:{}", order.order_id);
        let charge: Value =
            context.checkpoint("charge", || payments::charge(&order.order_id, key)).await?;

        // Step 3: wait until the carrier ships the parcel. The task releases
        // its worker, and it does not count against the merchant limit.
        let shipped: Shipped = context.wait_for_signal("order-shipped", None).await?.payload;

        // Step 4: the signal arrived. The handler ran again from its first line,
        // and the "charge" checkpoint gave back the stored charge.

        // Step 5: send the receipt with the tracking number.
        let tracking = shipped.tracking_number;
        let _: Value = context
            .checkpoint("receipt", || mailer::receipt(&order.email, &charge, &tracking))
            .await?;
        Ok(json!({ "charge": charge, "trackingNumber": tracking }))
    });
    // docs:end
    Ok(())
}

async fn durable_sleep(
    context: HandlerContext,
    trial: Trial,
) -> std::result::Result<Value, HandlerError> {
    // docs:start durable-sleep
    let welcome: Value = context.checkpoint("welcome", || mailer::welcome(&trial.to)).await?;
    context.sleep_until("follow-up-window", trial.follow_up_at).await?;
    let follow_up: Value = context.checkpoint("follow-up", || mailer::follow_up(&trial.to)).await?;
    // docs:end
    Ok(follow_up)
}

async fn durable_external(context: HandlerContext) -> std::result::Result<Value, HandlerError> {
    // docs:start durable-external
    let event: ProviderEvent = context.wait_for_signal("provider-event", None).await?.payload;
    let review: Value = context
        .wait_for_human("operator-review", &json!({ "eventId": event.id }), None)
        .await?
        .result;
    // docs:end
    Ok(review)
}

async fn signals(context: HandlerContext) -> std::result::Result<Value, HandlerError> {
    // docs:start signals-wait
    let approval: Value = context.wait_for_signal("approval", None).await?.payload;
    if approval["approved"] == true {
        publish_order().await?;
    }
    // docs:end
    Ok(approval)
}

async fn human_waits(
    context: HandlerContext,
    account_id: &str,
) -> std::result::Result<Value, HandlerError> {
    // docs:start human-waits
    let review: Value = context
        .wait_for_human(
            "account-review",
            &json!({ "accountId": account_id, "prompt": "Approve this account?" }),
            None,
        )
        .await?
        .result;
    if review["approved"] == true {
        activate_account(account_id).await?;
    }
    // docs:end
    Ok(review)
}

async fn child_tasks(
    context: HandlerContext,
    order: Order,
) -> std::result::Result<Value, HandlerError> {
    // docs:start child-tasks
    let mut options = EnqueueOptions::default();
    options.queue = Some("payments".into());
    let charge: Value = context
        .run_child("charge", "payments.charge", &json!({ "orderId": order.id }), options)
        .await?;
    // docs:end
    Ok(charge)
}

async fn child_task_set(
    context: HandlerContext,
    order: Value,
) -> std::result::Result<Value, HandlerError> {
    // docs:start child-tasks-set
    let results = context
        .run_children(vec![
            ChildTaskRequest::new("fraud", "orders.check-fraud", &order)?,
            ChildTaskRequest::new("inventory", "orders.reserve", &order)?,
        ])
        .await?;

    if let Some(ChildOutcome::Failed(error)) = results.get("fraud") {
        return Ok(json!({ "accepted": false, "reason": error.message }));
    }
    // docs:end
    Ok(json!({ "accepted": true }))
}

async fn progress(
    context: HandlerContext,
    payload: Import,
) -> std::result::Result<Value, HandlerError> {
    let mut processed = 0;
    // docs:start progress-set
    context.set_progress(&json!({ "phase": "reading", "processed": 0 })).await?;
    for batch in read_batches(&payload.source).await? {
        import_batch(&batch).await?;
        processed += batch.len();
        context.set_progress(&json!({ "phase": "importing", "processed": processed })).await?;
    }
    // docs:end
    Ok(json!({ "processed": processed }))
}

async fn agentic_flow(
    context: HandlerContext,
    prompt: String,
    tool_requests: Vec<ChildTaskRequest>,
    cooldown: Duration,
) -> std::result::Result<Value, HandlerError> {
    // docs:start agentic-flow
    let plan: Value = context.checkpoint("plan", || call_model(&prompt)).await?;
    context.set_progress(&json!({ "stage": "planned" })).await?;
    let tools = context.run_children_all(tool_requests).await?;
    context.sleep("model-cooldown", cooldown).await?;
    let approval: Value = context.wait_for_signal("approval", None).await?.payload;
    // docs:end
    Ok(json!({ "plan": plan, "tools": tools, "approval": approval }))
}

mod example_trial {
    // docs:start examples-trial
    use chrono::{DateTime, Utc};
    use serde::Deserialize;
    use serde_json::{json, Value};
    use workhorse::{HandlerError, Worker};

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Trial {
        to: String,
        follow_up_at: DateTime<Utc>,
    }

    // Stand-ins for a mail provider. A real send passes the key to the provider's
    // idempotency option, and the provider drops a repeated send with the same key.
    async fn send_welcome(to: &str, idempotency_key: &str) -> Result<Value, HandlerError> {
        Ok(json!({ "deliveredTo": to, "kind": "welcome", "idempotencyKey": idempotency_key }))
    }

    async fn send_follow_up(to: &str, idempotency_key: &str) -> Result<Value, HandlerError> {
        Ok(json!({ "deliveredTo": to, "kind": "follow-up", "idempotencyKey": idempotency_key }))
    }

    pub fn register_trial_handler(worker: &Worker) {
        worker.handle("trial.lifecycle", |trial: Trial, context| async move {
            let welcome_key = format!("welcome:{}", context.task().id);
            let _: Value =
                context.checkpoint("welcome", || send_welcome(&trial.to, &welcome_key)).await?;
            context.sleep_until("follow-up-window", trial.follow_up_at).await?;
            let follow_up_key = format!("follow-up:{}", context.task().id);
            let _: Value = context
                .checkpoint("follow-up", || send_follow_up(&trial.to, &follow_up_key))
                .await?;
            Ok(json!({ "deliveredTo": trial.to }))
        });
    }
    // docs:end
}

mod example_agent {
    // docs:start examples-agent
    use std::future::Future;
    use std::sync::Arc;
    use std::time::Duration;

    use serde::Deserialize;
    use serde_json::{json, Value};
    use workhorse::{ChildTaskRequest, EnqueueOptions, HandlerError, Worker};

    pub trait Model: Send + Sync + 'static {
        fn plan(
            &self,
            prompt: &str,
            idempotency_key: String,
        ) -> impl Future<Output = Result<Plan, HandlerError>> + Send;
    }

    #[derive(serde::Serialize, Deserialize)]
    pub struct Plan {
        tools: Vec<Tool>,
    }

    #[derive(serde::Serialize, Deserialize)]
    struct Tool {
        id: String,
        #[serde(flatten)]
        arguments: Value,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct AgentRun {
        prompt: String,
        conversation_id: String,
    }

    #[derive(Deserialize)]
    struct Approval {
        approved: bool,
    }

    pub fn register_agent<M: Model>(worker: &Worker, model: Arc<M>, cooldown: Duration) {
        worker.handle("agent.run", move |run: AgentRun, context| {
            let model = Arc::clone(&model);
            async move {
                let key = format!("plan:{}", context.task().id);
                let plan: Plan =
                    context.checkpoint("plan", || model.plan(&run.prompt, key)).await?;

                let mut children = Vec::with_capacity(plan.tools.len());
                for tool in &plan.tools {
                    let mut child = ChildTaskRequest::new(&tool.id, "agent.tool", tool)?;
                    let mut options = EnqueueOptions::default();
                    options.queue = Some("tools".into());
                    options.concurrency_key = Some(run.conversation_id.clone());
                    child.options = options;
                    children.push(child);
                }

                let tools = context.run_children_all(children).await?;
                context.sleep("model-cooldown", cooldown).await?;
                let approval: Approval = context.wait_for_signal("approval", None).await?.payload;
                Ok(json!({ "plan": plan, "tools": tools, "approved": approval.approved }))
            }
        });
    }
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

        let mut options = WorkerOptions::default();
        options.queues = vec!["billing".into()];
        options.schedule_namespaces = vec!["billing-production".into()];
        let worker = Worker::new(pool, options)?;
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
        let mut options = EnqueueOptions::default();
        options.queue = Some("webhooks".into());
        let mut idempotency = Idempotency::new(format!("stripe:{}", event.id));
        idempotency.scope = "stripe-webhooks".into();
        options.idempotency = Some(idempotency);
        let result = queue
            .enqueue(
                "stripe.event",
                &json!({ "eventId": event.id, "eventType": event.event_type }),
                options,
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
        let mut filter = DeadLetterFilter::default();
        filter.queue = Some("billing".into());
        filter.error_name = Some("ProviderTimeout".into());
        let audit = AdminAudit {
            actor: "reviewer@example.com".into(),
            reason: "provider incident INC-2041 resolved".into(),
            request_id: "INC-2041".into(),
        };
        let mut redrive = BulkRedriveOptions::default();
        redrive.dry_run = true;
        redrive.limit = 100;
        let preview = admin.redrive_many(filter.clone(), &audit, redrive).await?;
        println!("{} tasks eligible", preview.results.len());

        let mut cursor = None;
        loop {
            let mut redrive = BulkRedriveOptions::default();
            redrive.dry_run = false;
            redrive.limit = 100;
            redrive.cursor = cursor;
            let page = admin.redrive_many(filter.clone(), &audit, redrive).await?;
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

#[cfg(feature = "dashboard")]
mod dashboard_mount {
    use workhorse::dashboard::http::request::Parts;
    use workhorse::deadpool_postgres::Pool;

    fn application_admin_session(request: &Parts) -> Option<String> {
        request.headers.get("x-admin").and_then(|value| value.to_str().ok()).map(str::to_owned)
    }

    fn mount(pool: Pool) -> super::Result<axum::Router> {
        // docs:start dashboard-mount
        use workhorse::dashboard::{self, Authorization, DashboardOptions, Principal};

        let authorize = dashboard::authorize(|request| {
            let session = application_admin_session(request);
            async move {
                match session {
                    Some(username) => Authorization::Principal(Principal { actor: username }),
                    None => Authorization::Unauthenticated,
                }
            }
        });
        let mut options = DashboardOptions::new(pool, authorize);
        options.path = "/workhorse".into();
        options.environment = "production".into();
        let operator = dashboard::handler(options)?;
        let app = axum::Router::new().nest_service("/workhorse", operator);
        // docs:end
        Ok(app)
    }
}
