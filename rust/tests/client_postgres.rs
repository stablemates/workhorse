//! Cancellation, deliveries, health and deployment sync against a real PostgreSQL schema.
mod support;

use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::{json, Value};
use support::{scratch_database, worker};
use tokio_postgres::Client;
use uuid::Uuid;
use workhorse::contracts::{TaskContractVersion, TaskTypeContracts};
use workhorse::policies::{
    BudgetDefinition, ConcurrencyPolicyDefinition, RateLimit, RateLimitPolicyDefinition,
};
use workhorse::{
    CancelStatus, DeliveryOptions, EnqueueOptions, Error, HandlerContext, HumanOutcome,
    HumanWaitCompletionStatus, Queue, ScheduleCatchupPolicy, ScheduleDefinition, ScheduledTask,
    SignalDeliveryStatus, SignalOutcome, TaskState,
};

const WORKER: &str = "rust-client-test";

/// Claims the next task on `queue` and returns its identity and fence.
async fn claim(client: &Client, queue: &str) -> (Uuid, i64) {
    let row = client
        .query_one(
            "SELECT task_id, fence_token FROM workhorse.claim_v1($1, $2, 30000)",
            &[&queue, &WORKER],
        )
        .await
        .expect("a claimable task");
    (row.get(0), row.get(1))
}

async fn outcome_state(client: &Client, task_id: Uuid) -> String {
    client
        .query_one("SELECT state FROM workhorse.task_outcome WHERE task_id = $1", &[&task_id])
        .await
        .unwrap()
        .get(0)
}

#[tokio::test]
async fn cancel_reports_each_postgres_disposition() {
    let Some(database) = scratch_database("client_cancel").await else { return };
    let queue = Queue::connect(database.url(), "rust-cancel").await.unwrap();
    let observer = database.connect().await;

    let ready = queue.enqueue("t", &json!({}), EnqueueOptions::default()).await.unwrap();
    let result = queue.cancel(ready.task_id, Some("operator"), Some("not needed")).await.unwrap();
    assert_eq!(result.status, CancelStatus::Canceled);
    assert_eq!(result.task_id, ready.task_id);
    assert_eq!(result.state, Some(TaskState::Canceled));
    assert_eq!(result.requested_by.as_deref(), Some("operator"));
    assert_eq!(result.reason.as_deref(), Some("not needed"));
    assert!(result.finished_at.is_some());
    assert_eq!(outcome_state(&observer, ready.task_id).await, "canceled");

    let again = queue.cancel(ready.task_id, None, None).await.unwrap();
    assert_eq!(again.status, CancelStatus::Canceled, "a repeat cancel is idempotent");
    assert_eq!(again.requested_by.as_deref(), Some("operator"));

    let active = queue.enqueue("t", &json!({}), EnqueueOptions::default()).await.unwrap();
    claim(&observer, "rust-cancel").await;
    let requested = queue.cancel(active.task_id, None, None).await.unwrap();
    assert_eq!(requested.status, CancelStatus::CancelRequested);
    assert_eq!(requested.state, Some(TaskState::Active));
    assert_eq!(requested.current_attempt, Some(1));
    assert!(requested.requested_at.is_some());

    let missing = queue.cancel(Uuid::nil(), None, None).await.unwrap();
    assert_eq!(missing.status, CancelStatus::NotFound);
    assert_eq!(missing.state, None);
}

#[tokio::test]
async fn health_returns_the_queue_health_snapshot() {
    let Some(database) = scratch_database("client_health").await else { return };
    let queue = Queue::connect(database.url(), "rust-health").await.unwrap();
    queue.enqueue("t", &json!({}), EnqueueOptions::default()).await.unwrap();

    let health = queue.health().await.unwrap();
    assert!(health["status"]["level"].is_string(), "{health:?}");
    assert!(health.contains_key("budgets"), "{health:?}");
}

#[tokio::test]
async fn send_signal_delivers_once_and_reports_each_status() {
    let Some(database) = scratch_database("client_signal").await else { return };
    let queue = Queue::connect(database.url(), "rust-signal").await.unwrap();

    let task = queue.enqueue("wait", &json!({}), EnqueueOptions::default()).await.unwrap();
    let not_waiting = queue
        .send_signal(task.task_id, "approved", &json!({}), DeliveryOptions::new("k0", "ops"))
        .await
        .unwrap();
    assert_eq!(not_waiting.status, SignalDeliveryStatus::NotWaiting);

    let task_id = task.task_id;
    let worker = worker(&database, "rust-signal");
    worker.handle("wait", |_: Value, context: HandlerContext| async move {
        let signal: SignalOutcome<Value> =
            context.wait_for_signal("approved", Some(Duration::from_secs(60))).await?;
        Ok(signal.payload)
    });
    assert!(worker.run_once().await.unwrap());

    let options = DeliveryOptions::new("k1", "ops");
    let payload = json!({"ok": true});
    let delivered =
        queue.send_signal(task_id, "approved", &payload, options.clone()).await.unwrap();
    assert_eq!(delivered.status, SignalDeliveryStatus::Delivered);
    assert_eq!(delivered.task_id, task_id);
    assert_eq!(delivered.name, "approved");
    assert_eq!(delivered.payload, Some(payload.clone()));
    assert_eq!(delivered.delivered_by.as_deref(), Some("ops"));
    assert!(delivered.delivered_at.is_some());

    let duplicate = queue.send_signal(task_id, "approved", &payload, options.clone()).await;
    assert_eq!(duplicate.unwrap().status, SignalDeliveryStatus::Duplicate);

    let conflict = queue.send_signal(task_id, "approved", &json!({"ok": false}), options).await;
    assert!(
        matches!(&conflict, Err(Error::SignalIdempotencyConflict { name, .. }) if name == "approved"),
        "got {conflict:?}"
    );

    let missing = queue
        .send_signal(Uuid::nil(), "approved", &payload, DeliveryOptions::new("k2", "ops"))
        .await
        .unwrap();
    assert_eq!(missing.status, SignalDeliveryStatus::NotFound);
}

#[tokio::test]
async fn complete_human_wait_completes_once_and_reports_each_status() {
    let Some(database) = scratch_database("client_human_wait").await else { return };
    let queue = Queue::connect(database.url(), "rust-human").await.unwrap();

    let task = queue.enqueue("wait", &json!({}), EnqueueOptions::default()).await.unwrap();
    let not_waiting = queue
        .complete_human_wait(task.task_id, "review", &json!({}), DeliveryOptions::new("k0", "ann"))
        .await
        .unwrap();
    assert_eq!(not_waiting.status, HumanWaitCompletionStatus::NotWaiting);

    let task_id = task.task_id;
    let worker = worker(&database, "rust-human");
    worker.handle("wait", |_: Value, context: HandlerContext| async move {
        let prompt = json!({"question": "ship it?"});
        let human: HumanOutcome<Value> =
            context.wait_for_human("review", &prompt, Some(Duration::from_secs(60))).await?;
        Ok(human.result)
    });
    assert!(worker.run_once().await.unwrap());

    let options = DeliveryOptions::new("k1", "ann");
    let answer = json!({"approved": true});
    let completed =
        queue.complete_human_wait(task_id, "review", &answer, options.clone()).await.unwrap();
    assert_eq!(completed.status, HumanWaitCompletionStatus::Completed);
    assert_eq!(completed.name, "review");
    assert_eq!(completed.payload, Some(answer.clone()));
    assert_eq!(completed.completed_by.as_deref(), Some("ann"));
    assert!(completed.completed_at.is_some());

    let duplicate = queue.complete_human_wait(task_id, "review", &answer, options.clone()).await;
    assert_eq!(duplicate.unwrap().status, HumanWaitCompletionStatus::Duplicate);

    let conflict =
        queue.complete_human_wait(task_id, "review", &json!({"approved": false}), options).await;
    assert!(
        matches!(&conflict, Err(Error::HumanWaitIdempotencyConflict { name, .. }) if name == "review"),
        "got {conflict:?}"
    );

    let missing = queue
        .complete_human_wait(Uuid::nil(), "review", &answer, DeliveryOptions::new("k2", "ann"))
        .await
        .unwrap();
    assert_eq!(missing.status, HumanWaitCompletionStatus::NotFound);
}

#[tokio::test]
async fn sync_schedules_stores_and_prunes_definitions() {
    let Some(database) = scratch_database("client_schedules").await else { return };
    let queue = Queue::connect(database.url(), "rust-schedules").await.unwrap();
    let observer = database.connect().await;

    let mut nightly = ScheduleDefinition::new(
        "nightly",
        "0 3 * * *",
        ScheduledTask {
            priority: 5,
            concurrency_key: Some("reports".into()),
            max_attempts: 4,
            retry_policy: json!({"type": "fixed", "delayMs": 1000}).as_object().cloned(),
            ..ScheduledTask::new("report.build", json!({"kind": "daily"}))
        },
    );
    nightly.timezone = "Europe/Berlin".into();
    nightly.catchup_policy = ScheduleCatchupPolicy::Latest;
    let hourly =
        ScheduleDefinition::new("hourly", "0 * * * *", ScheduledTask::new("ping", json!({})));
    queue.sync_schedules("app", vec![nightly, hourly.clone()], true).await.unwrap();

    let row = observer
        .query_one(
            "SELECT cron_expression, timezone, queue_name, task_type, payload, priority,
                    concurrency_key, max_attempts, retry_policy, catchup_policy, configured_enabled
               FROM workhorse.schedule_definition
              WHERE namespace = 'app' AND schedule_name = 'nightly'",
            &[],
        )
        .await
        .unwrap();
    assert_eq!(row.get::<_, String>(0), "0 3 * * *");
    assert_eq!(row.get::<_, String>(1), "Europe/Berlin");
    assert_eq!(row.get::<_, String>(2), "rust-schedules");
    assert_eq!(row.get::<_, String>(3), "report.build");
    assert_eq!(row.get::<_, Value>(4), json!({"kind": "daily"}));
    assert_eq!(row.get::<_, i32>(5), 5);
    assert_eq!(row.get::<_, Option<String>>(6).as_deref(), Some("reports"));
    assert_eq!(row.get::<_, i32>(7), 4);
    assert_eq!(row.get::<_, Option<Value>>(8), Some(json!({"type": "fixed", "delayMs": 1000})));
    assert_eq!(row.get::<_, String>(9), "latest");
    assert!(row.get::<_, bool>(10));

    queue.sync_schedules("app", vec![hourly], true).await.unwrap();
    let names: Vec<String> = observer
        .query(
            "SELECT schedule_name FROM workhorse.schedule_definition WHERE namespace = 'app' AND configured_enabled",
            &[],
        )
        .await
        .unwrap()
        .iter()
        .map(|row| row.get(0))
        .collect();
    assert_eq!(names, ["hourly"], "prune disables a schedule missing from the sync");

    let mut invalid = ScheduledTask::new("ping", json!({}));
    invalid.priority = 101;
    let refusal = queue
        .sync_schedules("app", vec![ScheduleDefinition::new("bad", "* * * * *", invalid)], false)
        .await;
    assert!(matches!(refusal, Err(Error::InvalidArgument(_))), "got {refusal:?}");
}

#[tokio::test]
async fn sync_schedules_applies_the_current_contract() {
    let Some(database) = scratch_database("client_schedule_contracts").await else { return };
    let contracts = BTreeMap::from([(
        "payment.capture".to_string(),
        TaskTypeContracts {
            current_version: "v2".into(),
            versions: BTreeMap::from([(
                "v2".to_string(),
                TaskContractVersion {
                    payload_schema: json!({
                        "type": "object",
                        "properties": {"account": {"type": "string"}},
                        "required": ["account"],
                    }),
                    max_payload_bytes: 4096,
                    max_result_bytes: 8192,
                    sensitive_payload_keys: vec!["card".into()],
                    sensitive_result_keys: vec!["receipt".into()],
                    ..TaskContractVersion::default()
                },
            )]),
        },
    )]);
    Queue::connect(database.url(), "rust-schedules")
        .await
        .unwrap()
        .sync_contracts(&contracts)
        .await
        .unwrap();
    // A second Queue has synced no contract, so only PostgreSQL can name the current version.
    let queue = Queue::connect(database.url(), "rust-schedules").await.unwrap();
    let observer = database.connect().await;
    let schedules = |payload: Value| {
        vec![
            ScheduleDefinition::new(
                "nightly-capture",
                "0 2 * * *",
                ScheduledTask::new("payment.capture", payload),
            ),
            ScheduleDefinition::new(
                "nightly-report",
                "0 3 * * *",
                ScheduledTask::new("payment.report", json!({})),
            ),
        ]
    };

    let refusal = queue.sync_schedules("billing", schedules(json!({"card": "4242"})), true).await;
    assert!(
        matches!(&refusal, Err(Error::ContractValidation { task_type, version })
            if task_type == "payment.capture" && version == "v2"),
        "got {refusal:?}"
    );
    let written: i64 = observer
        .query_one("SELECT count(*) FROM workhorse.schedule_definition", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(written, 0, "a rejected payload writes no definition");

    queue.sync_schedules("billing", schedules(json!({"account": "acct_1"})), true).await.unwrap();
    let rows = observer
        .query(
            "SELECT contract_version, payload_max_bytes, result_max_bytes,
                    payload_redact_keys, result_redact_keys
               FROM workhorse.schedule_definition
              WHERE namespace = 'billing' ORDER BY schedule_name",
            &[],
        )
        .await
        .unwrap();
    type StoredContract = (Option<String>, i32, i32, Vec<String>, Vec<String>);
    let stored: Vec<StoredContract> = rows
        .iter()
        .map(|row| (row.get(0), row.get(1), row.get(2), row.get(3), row.get(4)))
        .collect();
    assert_eq!(
        stored,
        [
            (Some("v2".into()), 4096, 8192, vec!["card".into()], vec!["receipt".into()]),
            (None, 1_048_576, 1_048_576, vec![], vec![]),
        ]
    );
}

#[tokio::test]
async fn sync_concurrency_policies_stores_lists_and_prunes() {
    let Some(database) = scratch_database("client_concurrency_policies").await else { return };
    let queue = Queue::connect(database.url(), "rust-policies").await.unwrap();

    let definitions = [
        ConcurrencyPolicyDefinition {
            queue: "emails".into(),
            max_active: 4,
            max_active_per_key: Some(1),
        },
        ConcurrencyPolicyDefinition {
            queue: "reports".into(),
            max_active: 2,
            max_active_per_key: None,
        },
    ];
    let stored = queue.sync_concurrency_policies("app", &definitions, true).await.unwrap();
    assert_eq!(stored.len(), 2);
    let listed = queue.list_concurrency_policies(&["emails"]).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].namespace, "app");
    assert_eq!(listed[0].max_active, 4);
    assert_eq!(listed[0].max_active_per_key, Some(1));

    queue.sync_concurrency_policies("app", &definitions[1..], true).await.unwrap();
    let all = queue.list_concurrency_policies(&[]).await.unwrap();
    let queues: Vec<&str> = all.iter().map(|policy| policy.queue.as_str()).collect();
    assert_eq!(queues, ["reports"]);
}

/// Makes the first `forced` syncs fail with `code` at their first write to `concurrency_policy`.
/// The sequence counts each sync transaction that reached the table once, and a rollback does not
/// undo it.
async fn force_sync_failures(client: &Client, code: &str, forced: i64) {
    client
        .batch_execute(&format!(
            "CREATE SEQUENCE forced_sync_attempts;
             CREATE FUNCTION force_sync_failure() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN
               IF current_setting('forced_sync.counted', true) IS DISTINCT FROM 'yes' THEN
                 PERFORM set_config('forced_sync.counted', 'yes', true);
                 IF nextval('forced_sync_attempts') <= {forced} THEN
                   RAISE EXCEPTION 'forced sync failure' USING ERRCODE = '{code}';
                 END IF;
               END IF;
               RETURN NULL;
             END $$;
             CREATE TRIGGER force_sync_failure BEFORE INSERT OR UPDATE OR DELETE
               ON workhorse.concurrency_policy
               FOR EACH STATEMENT EXECUTE FUNCTION force_sync_failure();"
        ))
        .await
        .unwrap();
}

async fn sync_attempts(client: &Client) -> i64 {
    client.query_one("SELECT last_value FROM forced_sync_attempts", &[]).await.unwrap().get(0)
}

fn mail_policy() -> [ConcurrencyPolicyDefinition; 1] {
    [ConcurrencyPolicyDefinition { queue: "mail".into(), max_active: 2, max_active_per_key: None }]
}

#[tokio::test]
async fn sync_concurrency_policies_resends_a_deadlock_victim() {
    let Some(database) = scratch_database("client_policy_sync_deadlock").await else { return };
    let observer = database.connect().await;
    force_sync_failures(&observer, "40P01", 1).await;
    let queue = Queue::connect(database.url(), "rust-policies").await.unwrap();

    let stored = queue.sync_concurrency_policies("app", &mail_policy(), true).await.unwrap();
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].max_active, 2);
    assert_eq!(sync_attempts(&observer).await, 2, "one deadlock, then the resend succeeds");
}

#[tokio::test]
async fn sync_concurrency_policies_raises_the_last_deadlock_after_three_attempts() {
    let Some(database) = scratch_database("client_policy_sync_deadlocks").await else { return };
    let observer = database.connect().await;
    force_sync_failures(&observer, "40P01", 3).await;
    let queue = Queue::connect(database.url(), "rust-policies").await.unwrap();

    let error = queue.sync_concurrency_policies("app", &mail_policy(), true).await.unwrap_err();
    assert_eq!(error.sqlstate(), Some("40P01"));
    assert_eq!(sync_attempts(&observer).await, 3);
}

#[tokio::test]
async fn sync_concurrency_policies_sends_once_on_another_error() {
    let Some(database) = scratch_database("client_policy_sync_conflict").await else { return };
    let observer = database.connect().await;
    force_sync_failures(&observer, "40001", 1).await;
    let queue = Queue::connect(database.url(), "rust-policies").await.unwrap();

    let error = queue.sync_concurrency_policies("app", &mail_policy(), true).await.unwrap_err();
    assert_eq!(error.sqlstate(), Some("40001"));
    assert_eq!(sync_attempts(&observer).await, 1);
}

#[tokio::test]
async fn sync_concurrency_policies_reports_the_deadlock_that_aborted_a_caller_transaction() {
    let Some(database) = scratch_database("client_policy_sync_transaction").await else { return };
    let observer = database.connect().await;
    force_sync_failures(&observer, "40P01", 1).await;
    let mut caller = database.connect().await;
    let transaction = caller.transaction().await.unwrap();
    let queue = Queue::new(&transaction, "rust-policies");

    let error = queue.sync_concurrency_policies("app", &mail_policy(), true).await.unwrap_err();
    assert_eq!(error.sqlstate(), Some("40P01"), "the original deadlock, not 25P02: {error:?}");
    // The resend failed with 25P02 before it reached the table, so only the deadlock counted.
    assert_eq!(sync_attempts(&observer).await, 1);
    drop(queue);
    transaction.rollback().await.unwrap();
}

#[tokio::test]
async fn sync_rate_limit_policies_stores_lists_and_prunes() {
    let Some(database) = scratch_database("client_rate_limit_policies").await else { return };
    let queue = Queue::connect(database.url(), "rust-policies").await.unwrap();

    let rate = RateLimit { limit: 10, interval_ms: 1000, burst: 20 };
    let per_key = RateLimit { limit: 1, interval_ms: 1000, burst: 1 };
    let definitions = [
        RateLimitPolicyDefinition { queue: "emails".into(), rate, per_key: Some(per_key) },
        RateLimitPolicyDefinition { queue: "reports".into(), rate, per_key: None },
    ];
    queue.sync_rate_limit_policies("app", &definitions, true).await.unwrap();
    let listed = queue.list_rate_limit_policies(&["emails", "reports"]).await.unwrap();
    assert_eq!(listed.len(), 2);
    let emails = listed.iter().find(|policy| policy.queue == "emails").unwrap();
    assert_eq!(emails.rate, rate);
    assert_eq!(emails.per_key, Some(per_key));
    let reports = listed.iter().find(|policy| policy.queue == "reports").unwrap();
    assert_eq!(reports.per_key, None);

    queue.sync_rate_limit_policies("app", &[], true).await.unwrap();
    assert!(queue.list_rate_limit_policies(&[]).await.unwrap().is_empty());
}

#[tokio::test]
async fn sync_budgets_stores_lists_and_prunes() {
    let Some(database) = scratch_database("client_budgets").await else { return };
    let queue = Queue::connect(database.url(), "rust-policies").await.unwrap();

    let rate = RateLimit { limit: 60, interval_ms: 60_000, burst: 60 };
    let definitions = [
        BudgetDefinition { name: "openai".into(), max_active: Some(8), rate: Some(rate) },
        BudgetDefinition { name: "smtp".into(), max_active: Some(2), rate: None },
    ];
    queue.sync_budgets("app", &definitions, true).await.unwrap();
    let listed = queue.list_budgets(&["openai"]).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].max_active, Some(8));
    assert_eq!(listed[0].rate, Some(rate));

    queue.sync_budgets("app", &definitions[1..], true).await.unwrap();
    let names: Vec<String> =
        queue.list_budgets(&[]).await.unwrap().into_iter().map(|budget| budget.name).collect();
    assert_eq!(names, ["smtp"]);
}

#[tokio::test]
async fn sync_contracts_validates_payloads_and_stamps_contract_fields() {
    let Some(database) = scratch_database("client_contracts").await else { return };
    let queue = Queue::connect(database.url(), "rust-contracts").await.unwrap();
    let observer = database.connect().await;

    let version = TaskContractVersion {
        payload_schema: json!({
            "type": "object",
            "properties": {"to": {"type": "string"}, "token": {"type": "string"}},
            "required": ["to"],
        }),
        max_payload_bytes: 4096,
        sensitive_payload_keys: vec!["token".into()],
        ..TaskContractVersion::default()
    };
    let contracts = BTreeMap::from([(
        "email.send".to_string(),
        TaskTypeContracts {
            current_version: "v2".into(),
            versions: BTreeMap::from([("v2".to_string(), version)]),
        },
    )]);
    queue.sync_contracts(&contracts).await.unwrap();

    let refusal =
        queue.enqueue("email.send", &json!({"token": "x"}), EnqueueOptions::default()).await;
    assert!(
        matches!(&refusal, Err(Error::ContractValidation { task_type, version })
            if task_type == "email.send" && version == "v2"),
        "got {refusal:?}"
    );

    let accepted = queue
        .enqueue("email.send", &json!({"to": "a@b.c", "token": "x"}), EnqueueOptions::default())
        .await
        .unwrap();
    let row = observer
        .query_one(
            "SELECT contract_version, payload_max_bytes, payload_redact_keys
               FROM workhorse.task WHERE id = $1",
            &[&accepted.task_id],
        )
        .await
        .unwrap();
    assert_eq!(row.get::<_, Option<String>>(0).as_deref(), Some("v2"));
    assert_eq!(row.get::<_, i32>(1), 4096);
    assert_eq!(row.get::<_, Vec<String>>(2), ["token"]);

    // A second Queue has not synced, so it learns the contract from PostgreSQL's mismatch.
    let other = Queue::connect(database.url(), "rust-contracts").await.unwrap();
    let learned = other
        .enqueue("email.send", &json!({"to": "b@c.d"}), EnqueueOptions::default())
        .await
        .unwrap();
    let version: Option<String> = observer
        .query_one("SELECT contract_version FROM workhorse.task WHERE id = $1", &[&learned.task_id])
        .await
        .unwrap()
        .get(0);
    assert_eq!(version.as_deref(), Some("v2"));
    let refused = other.enqueue("email.send", &json!({}), EnqueueOptions::default()).await;
    assert!(matches!(refused, Err(Error::ContractValidation { .. })), "got {refused:?}");

    let outside_profile = BTreeMap::from([(
        "bad".to_string(),
        TaskTypeContracts {
            current_version: "v1".into(),
            versions: BTreeMap::from([(
                "v1".to_string(),
                TaskContractVersion {
                    payload_schema: json!({"$ref": "https://example.com/schema"}),
                    ..TaskContractVersion::default()
                },
            )]),
        },
    )]);
    let refusal = queue.sync_contracts(&outside_profile).await;
    assert!(matches!(refusal, Err(Error::InvalidArgument(_))), "got {refusal:?}");
}
