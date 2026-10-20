//! Runs the Rust landing page snippets that `examples/landing.rs` holds against PostgreSQL.
//!
//! `cargo clippy --all-targets` only compiles the example, so a snippet that sends a value the
//! database refuses compiles and still fails for the reader who copies it. This file includes the
//! example as a module and calls every region on a scratch database.
//!
//! The `landing-hero`, `landing-schedules`, and `landing-deploy` regions end in
//! `run_worker_process`, which waits for SIGINT or SIGTERM. A test runs such a region in a spawned
//! task, waits for the result the region causes, and then aborts the task, because a signal sent
//! to the test process would reach every test in it.
mod support;

#[path = "../examples/landing.rs"]
mod landing;

use std::future::Future;
use std::time::Duration;

use chrono::{Duration as ChronoDuration, Utc};
use serde_json::{json, Value};
use support::{scratch_database, ScratchDatabase};
use tokio::task::JoinHandle;
use tokio_postgres::NoTls;
use uuid::Uuid;
use workhorse::deadpool_postgres::{Manager, Pool};
use workhorse::{
    Admin, DeliveryOptions, EnqueueOptions, EnqueueOutcome, HandlerError, Queue, TaskState, Worker,
    WorkerOptions,
};

/// How long a test waits for a task to reach a state.
const WAIT: Duration = Duration::from_secs(20);

struct Landing {
    database: ScratchDatabase,
    pool: Pool,
    queue: Queue<Pool>,
    admin: Admin<Pool>,
}

async fn landing(name: &str) -> Option<Landing> {
    let database = scratch_database(name).await?;
    let pool = Pool::builder(Manager::new(database.url().parse().unwrap(), NoTls))
        .max_size(8)
        .build()
        .unwrap();
    let queue = Queue::new(pool.clone(), "default");
    let admin = Admin::new(pool.clone());
    Some(Landing { database, pool, queue, admin })
}

impl Landing {
    /// A polling worker on `queues` that claims at once.
    fn worker(&self, queues: &[&str], concurrency: usize) -> Worker {
        Worker::new(
            self.pool.clone(),
            WorkerOptions {
                queues: queues.iter().map(|queue| (*queue).into()).collect(),
                concurrency,
                polling_only: true,
                poll_interval: Some(Duration::from_millis(20)),
                disable_registry: true,
                ..WorkerOptions::default()
            },
        )
        .unwrap()
    }

    async fn task(&self, task: Uuid) -> workhorse::TaskSnapshot {
        self.admin.get_task(task).await.unwrap().expect("task exists")
    }

    /// Runs `worker` once at a time until `task` reaches `state`.
    async fn drain(&self, worker: &Worker, task: Uuid, state: TaskState) {
        tokio::time::timeout(WAIT, async {
            while self.task(task).await.state != state {
                if !worker.run_once().await.unwrap() {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("task {task} never reached {state:?}"));
    }

    /// Waits until a task of `task_type` reaches `state`, and returns it.
    async fn wait_for_type(&self, task_type: &str, state: TaskState) -> workhorse::TaskSnapshot {
        let client = self.database.connect().await;
        tokio::time::timeout(WAIT, async {
            loop {
                let row = client
                    .query_opt("SELECT id FROM workhorse.task WHERE task_type = $1", &[&task_type])
                    .await
                    .unwrap();
                if let Some(row) = row {
                    let task = self.task(row.get(0)).await;
                    if task.state == state {
                        return task;
                    }
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("no {task_type} task reached {state:?}"))
    }
}

/// Starts a region that ends in `run_worker_process`. The caller aborts the returned task.
fn spawn_process<F>(region: F) -> JoinHandle<Result<(), String>>
where
    F: Future<Output = Result<(), Box<dyn std::error::Error>>> + Send + 'static,
{
    tokio::spawn(async move { region.await.map_err(|error| error.to_string()) })
}

/// Aborts a region that `spawn_process` started, after it failed if it already stopped.
async fn stop_process(running: JoinHandle<Result<(), String>>) {
    assert!(!running.is_finished(), "the region stopped early: {:?}", running.await);
    running.abort();
    assert!(running.await.unwrap_err().is_cancelled());
}

fn delivery(key: &str) -> DeliveryOptions {
    DeliveryOptions { idempotency_key: key.into(), requested_by: "landing-test".into() }
}

#[tokio::test]
async fn the_hero_snippet_enqueues_and_completes_a_welcome_email() {
    let Some(landing) = landing("landing_hero").await else { return };

    let running = spawn_process(landing::landing_hero::run(landing.pool.clone()));
    let task = landing.wait_for_type("email.welcome", TaskState::Succeeded).await;

    stop_process(running).await;
    assert_eq!(task.queue, "default");
    assert_eq!(task.result, Some(json!({ "deliveredTo": "ada@example.com" })));
}

#[tokio::test]
async fn the_enqueue_snippet_commits_the_order_and_its_task_together() {
    let Some(landing) = landing("landing_enqueue").await else { return };
    let client = landing.database.connect().await;
    client
        .batch_execute("CREATE TABLE public.orders (id text PRIMARY KEY, total bigint)")
        .await
        .unwrap();

    landing::landing_enqueue::create_order(&landing.pool, "order-1", 42).await.unwrap();

    let total: i64 = client
        .query_one("SELECT total FROM public.orders WHERE id = 'order-1'", &[])
        .await
        .unwrap()
        .get(0);
    assert_eq!(total, 42);
    let task = landing.wait_for_type("order.confirm", TaskState::Ready).await;
    assert_eq!(task.payload, json!({ "orderId": "order-1" }));
}

#[tokio::test]
async fn the_checkpoints_snippet_completes_an_invoice() {
    let Some(landing) = landing("landing_checkpoints").await else { return };
    let worker = landing.worker(&["default"], 1);
    landing::landing_checkpoints::register_invoice(&worker);
    let payload = json!({ "amount": 5, "email": "ada@example.com" });
    let task = landing.queue.enqueue("invoice.issue", &payload, EnqueueOptions::default()).await;
    let task = task.unwrap().task_id;

    landing.drain(&worker, task, TaskState::Succeeded).await;

    assert_eq!(landing.task(task).await.result, Some(json!({ "chargeId": "ch_5" })));
}

#[tokio::test]
async fn the_sleep_snippet_suspends_the_settlement() {
    let Some(landing) = landing("landing_sleep").await else { return };
    let worker = landing.worker(&["default"], 1);
    landing::landing_sleep::register_settlement(&worker);
    let payload = json!({ "orderId": "order-1" });
    let task = landing.queue.enqueue("order.settle", &payload, EnqueueOptions::default()).await;
    let task = task.unwrap().task_id;

    landing.drain(&worker, task, TaskState::Scheduled).await;

    let run_at = landing.task(task).await.run_at;
    assert!(run_at > Utc::now() + ChronoDuration::minutes(59), "sleeps until {run_at}");
}

#[tokio::test]
async fn the_retries_snippet_stores_its_retry_policy() {
    let Some(landing) = landing("landing_retries").await else { return };
    let kickoff = Utc::now() + ChronoDuration::hours(2);

    let result =
        landing::landing_retries::remind(&landing.queue, "match-1", kickoff).await.unwrap();

    assert_eq!(result.outcome, EnqueueOutcome::Accepted);
    let client = landing.database.connect().await;
    let row = client
        .query_one(
            "SELECT retry_policy, max_attempts, execution_timeout_ms FROM workhorse.task \
             WHERE id = $1",
            &[&result.task_id],
        )
        .await
        .unwrap();
    let retry_policy: Value = row.get(0);
    assert_eq!(
        retry_policy,
        json!({
            "type": "exponential",
            "initialDelayMs": 1_000,
            "multiplier": 2,
            "maxDelayMs": 60_000,
        })
    );
    assert_eq!(row.get::<_, i32>(1), 5);
    assert_eq!(row.get::<_, Option<i64>>(2), Some(30_000));
}

#[tokio::test]
async fn the_idempotency_snippet_returns_the_same_task_twice() {
    let Some(landing) = landing("landing_idempotency").await else { return };

    let first = landing::landing_idempotency::capture(&landing.queue).await.unwrap();
    let second = landing::landing_idempotency::capture(&landing.queue).await.unwrap();

    assert_eq!(first.outcome, EnqueueOutcome::Accepted);
    assert_ne!(second.outcome, EnqueueOutcome::Accepted);
    assert_eq!(second.task_id, first.task_id);
    assert_eq!(landing.task(first.task_id).await.queue, "billing");
}

#[tokio::test]
async fn the_schedules_snippet_syncs_its_schedule_and_runs_a_worker() {
    let Some(landing) = landing("landing_schedules").await else { return };
    let client = landing.database.connect().await;

    let running = spawn_process(landing::landing_schedules::run(landing.pool.clone()));
    let row = tokio::time::timeout(WAIT, async {
        loop {
            let row = client
                .query_opt(
                    "SELECT cron_expression, task_type FROM workhorse.schedule_definition \
                     WHERE namespace = 'billing' AND schedule_name = 'nightly-invoice-run'",
                    &[],
                )
                .await
                .unwrap();
            if let Some(row) = row {
                return row;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the schedule is synchronized");
    // The worker runs a maintenance pass before it waits for a signal.
    tokio::time::sleep(Duration::from_millis(500)).await;

    stop_process(running).await;
    assert_eq!(row.get::<_, String>(0), "0 2 * * *");
    assert_eq!(row.get::<_, String>(1), "invoices.generate");
}

#[tokio::test]
async fn the_flow_control_snippet_stores_its_policies_and_enqueues_mail() {
    let Some(landing) = landing("landing_flow_control").await else { return };

    landing::landing_flow_control::configure(&landing.queue, "msg-1", "acme").await.unwrap();

    let client = landing.database.connect().await;
    let concurrency = client
        .query_one(
            "SELECT max_active, max_active_per_key FROM workhorse.concurrency_policy \
             WHERE queue_name = 'mail'",
            &[],
        )
        .await
        .unwrap();
    assert_eq!((concurrency.get::<_, i32>(0), concurrency.get::<_, Option<i32>>(1)), (20, Some(2)));
    let rate = client
        .query_one(
            "SELECT rate_limit, rate_interval_ms, rate_burst FROM workhorse.rate_limit_policy \
             WHERE queue_name = 'provider-api'",
            &[],
        )
        .await
        .unwrap();
    assert_eq!(
        (rate.get::<_, i32>(0), rate.get::<_, i32>(1), rate.get::<_, i32>(2)),
        (100, 1_000, 200)
    );
    let task = landing.wait_for_type("mail.send", TaskState::Ready).await;
    assert_eq!(task.queue, "mail");
    assert_eq!(task.concurrency_key.as_deref(), Some("tenant:acme"));
}

#[tokio::test]
async fn the_dependencies_snippet_blocks_the_confirmation_and_joins_a_child() {
    let Some(landing) = landing("landing_dependencies").await else { return };

    landing::landing_dependencies::confirm(&landing.queue, "order-1").await.unwrap();
    let inventory = landing.wait_for_type("inventory.reserve", TaskState::Ready).await;
    let confirmation = landing.wait_for_type("order.confirm", TaskState::Blocked).await;
    assert_eq!(confirmation.prerequisite_task_ids, vec![inventory.id]);

    let worker = landing.worker(&["default", "payments"], 2);
    landing::landing_dependencies::register_fulfillment(&worker);
    worker.handle("payment.capture", |capture: Value, _context| async move {
        Ok(json!({ "captured": capture["orderId"] }))
    });
    let order = json!({ "id": "order-1" });
    let task = landing.queue.enqueue("order.fulfill", &order, EnqueueOptions::default()).await;
    let task = task.unwrap().task_id;
    landing.drain(&worker, task, TaskState::Succeeded).await;

    let receipt = json!({ "receipt": { "captured": "order-1" } });
    assert_eq!(landing.task(task).await.result, Some(receipt));
}

#[tokio::test]
async fn the_coalescing_snippet_keeps_the_latest_revision() {
    let Some(landing) = landing("landing_coalescing").await else { return };

    landing::landing_coalescing::reindex(&landing.queue, "doc-1", 60_000).await.unwrap();

    let task = landing.wait_for_type("search.reindex", TaskState::Scheduled).await;
    assert_eq!(task.payload, json!({ "documentId": "doc-1", "revision": 2 }));
}

#[tokio::test]
async fn the_external_waits_snippet_resumes_with_the_scan_and_the_review() {
    let Some(landing) = landing("landing_external_waits").await else { return };
    let worker = landing.worker(&["default"], 1);
    landing::landing_external_waits::register_release(&worker);
    let release = json!({ "id": "v1" });
    let task = landing.queue.enqueue("release.publish", &release, EnqueueOptions::default()).await;
    let task = task.unwrap().task_id;
    landing.drain(&worker, task, TaskState::Scheduled).await;

    let scan = json!({ "clean": true });
    landing::landing_external_waits::deliver_scan(&landing.queue, task, &scan, "scan-1")
        .await
        .unwrap();
    landing.drain(&worker, task, TaskState::Scheduled).await;
    let review = json!({ "approved": true });
    landing
        .queue
        .complete_human_wait(task, "release-approval", &review, delivery("review-1"))
        .await
        .unwrap();
    landing.drain(&worker, task, TaskState::Succeeded).await;

    assert_eq!(landing.task(task).await.result, Some(json!({ "published": true })));
}

#[tokio::test]
async fn the_batch_handlers_snippet_completes_each_task_with_its_payload() {
    let Some(landing) = landing("landing_batch_handlers").await else { return };
    let worker = landing.worker(&["default"], 3);
    landing::landing_batch_handlers::register_email_batch(&worker, 3, Duration::from_millis(50));
    let mut tasks = Vec::new();
    for name in ["ada", "grace", "edsger"] {
        let payload = json!({ "to": format!("{name}@example.com") });
        let task = landing.queue.enqueue("email.send", &payload, EnqueueOptions::default()).await;
        tasks.push((task.unwrap().task_id, payload));
    }

    for (task, payload) in tasks {
        landing.drain(&worker, task, TaskState::Succeeded).await;
        assert_eq!(landing.task(task).await.result, Some(payload));
    }
}

#[tokio::test]
async fn the_cancellation_snippet_cancels_the_export_and_runs_the_next_one() {
    let Some(landing) = landing("landing_cancellation").await else { return };
    let worker = landing.worker(&["default"], 1);
    let rows = json!([{ "id": 1 }, { "id": 2 }]);
    let canceled = landing.queue.enqueue("rows.export", &rows, EnqueueOptions::default()).await;
    let canceled = canceled.unwrap().task_id;

    landing::landing_cancellation::configure_export(&landing.queue, &worker, canceled)
        .await
        .unwrap();

    let task = landing.task(canceled).await;
    assert_eq!(task.state, TaskState::Canceled);
    let error = task.error.expect("a cancellation error");
    assert_eq!(error["requested_by"], "operator@example.com");
    assert_eq!(error["reason"], "customer withdrew the request");
    let task = landing.queue.enqueue("rows.export", &rows, EnqueueOptions::default()).await;
    let task = task.unwrap().task_id;
    landing.drain(&worker, task, TaskState::Succeeded).await;
    assert_eq!(landing.task(task).await.result, Some(json!({ "stopped": false })));
}

#[tokio::test]
async fn the_dead_letters_snippet_redrives_the_declined_billing_task() {
    let Some(landing) = landing("landing_dead_letters").await else { return };
    let worker = landing.worker(&["billing"], 1);
    worker.handle("invoice.capture", |_payload: Value, _context| async move {
        Err::<Value, _>(HandlerError::named("CardDeclined", "the card was declined"))
    });
    let options =
        EnqueueOptions { queue: Some("billing".into()), max_attempts: 1, ..Default::default() };
    let task = landing.queue.enqueue("invoice.capture", &json!({}), options).await;
    let task = task.unwrap().task_id;
    landing.drain(&worker, task, TaskState::Failed).await;

    landing::landing_dead_letters::redrive_billing(&landing.admin).await.unwrap();

    // A redrive leaves the failed task as it is and enqueues a copy of it.
    assert_eq!(landing.task(task).await.state, TaskState::Failed);
    let client = landing.database.connect().await;
    let copy: Uuid = client
        .query_one(
            "SELECT id FROM workhorse.task WHERE task_type = 'invoice.capture' AND id <> $1",
            &[&task],
        )
        .await
        .unwrap()
        .get(0);
    let copy = landing.task(copy).await;
    assert_eq!((copy.queue.as_str(), copy.state), ("billing", TaskState::Ready));
}

#[cfg(feature = "dashboard")]
#[tokio::test]
async fn the_operate_dashboard_snippet_serves_an_admin_and_refuses_a_stranger() {
    use tower::ServiceExt;
    use workhorse::dashboard::http::{Request, StatusCode};

    let Some(landing) = landing("landing_operate_dashboard").await else { return };
    let router = landing::landing_operate_dashboard::mount(landing.pool.clone()).unwrap();
    let request = |admin: Option<&str>| {
        let mut request = Request::builder().uri("/workhorse");
        if let Some(admin) = admin {
            request = request.header("x-admin", admin);
        }
        request.body(axum::body::Body::empty()).unwrap()
    };

    let admin = router.clone().oneshot(request(Some("ada"))).await.unwrap();
    let stranger = router.oneshot(request(None)).await.unwrap();

    assert_eq!(admin.status(), StatusCode::FOUND);
    assert_eq!(admin.headers()["location"], "/workhorse/tasks");
    assert_eq!(stranger.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn the_operate_health_snippet_reads_health_and_live_tasks() {
    let Some(landing) = landing("landing_operate_health").await else { return };
    landing.queue.enqueue("email.send", &json!({}), EnqueueOptions::default()).await.unwrap();

    landing::landing_operate_health::inspect(&landing.pool).await.unwrap();
}

#[tokio::test]
async fn the_operate_fleet_snippet_pauses_only_billing_workers() {
    let Some(landing) = landing("landing_operate_fleet").await else { return };
    let mut running = Vec::new();
    for queue in ["billing", "email"] {
        let worker = Worker::new(
            landing.pool.clone(),
            WorkerOptions {
                queues: vec![queue.into()],
                worker_id: Some(format!("{queue}-worker")),
                polling_only: true,
                ..WorkerOptions::default()
            },
        )
        .unwrap();
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let handle = tokio::spawn(async move {
            worker
                .run(async move {
                    let _ = stopped.await;
                })
                .await
        });
        running.push((stop, handle));
    }
    tokio::time::timeout(WAIT, async {
        while landing.admin.list_workers().await.unwrap().len() < 2 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("both workers register");

    landing::landing_operate_fleet::pause_billing(&landing.pool).await.unwrap();

    let mut paused: Vec<(String, bool)> = landing
        .admin
        .list_workers()
        .await
        .unwrap()
        .into_iter()
        .map(|entry| (entry.worker_id, entry.paused))
        .collect();
    paused.sort();
    assert_eq!(paused, vec![("billing-worker".into(), true), ("email-worker".into(), false)]);
    for (stop, handle) in running {
        stop.send(()).unwrap();
        handle.await.unwrap().unwrap();
    }
}

#[tokio::test]
async fn the_deploy_snippet_runs_an_email_worker_from_database_url() {
    let Some(landing) = landing("landing_deploy").await else { return };
    // The region reads DATABASE_URL. No other test in this binary reads it.
    std::env::set_var("DATABASE_URL", landing.database.url());
    let email = json!({ "to": "ada@example.com" });
    let options = EnqueueOptions { queue: Some("email".into()), ..Default::default() };
    landing.queue.enqueue("email.send", &email, options).await.unwrap();

    let running = spawn_process(landing::landing_deploy::run());
    let task = landing.wait_for_type("email.send", TaskState::Succeeded).await;

    stop_process(running).await;
    assert_eq!(task.result, Some(json!({ "sent": "ada@example.com" })));
}

#[test]
fn every_landing_region_has_a_test() {
    let example = include_str!("../examples/landing.rs");
    let tests = include_str!("landing_postgres.rs");
    let regions: Vec<&str> = example
        .lines()
        .filter_map(|line| line.trim().strip_prefix("// docs:start landing-"))
        .collect();
    assert!(!regions.is_empty());
    for region in regions {
        let call = format!("landing::landing_{}::", region.replace('-', "_"));
        assert!(tests.contains(&call), "no test calls the landing-{region} region");
    }
}
