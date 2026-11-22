//! The log events of the Rust worker against a real PostgreSQL schema.
//!
//! Each test installs its own `tracing` subscriber. The first tests write the plain text format
//! into a buffer and read the fields of the records from that text. The other tests keep the level
//! and the fields of each event, without the fields of its spans. The test runtime has one thread,
//! so the tasks of the worker see that subscriber.
//!
//! The TypeScript union `WorkhorseLogEvent` is the contract for the name, the severity, and the
//! attributes of each event (docs/architecture/telemetry.md, "Structured logs").

mod support;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use support::scratch_database;
use tokio_postgres::NoTls;
use tracing::field::{Field, Visit};
use tracing::Level;
use tracing_subscriber::layer::{Context, SubscriberExt};
use tracing_subscriber::Layer;
use workhorse::{
    Admin, AdminAudit, BatchOptions, BatchResult, BulkRedriveOptions, DeadLetterFilter, Debounce,
    DebounceSchedule, DeliveryOptions, EnqueueOptions, EnqueueOutcome, EnqueueRequest,
    HandlerContext, HandlerError, Idempotency, Queue, QueueTier, ScheduleCatchupPolicy,
    ScheduleDefinition, ScheduledTask, TaskGroupCallbacks, Throttle, Worker, WorkerOptions,
};

#[derive(Clone, Default)]
struct CapturedLog(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for CapturedLog {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl CapturedLog {
    fn install(&self) -> tracing::subscriber::DefaultGuard {
        let log = self.clone();
        let subscriber = tracing_subscriber::fmt()
            // Warning level only: the handler span is an info span, so a record must carry the task
            // identity itself (SM-2013).
            .with_max_level(tracing::Level::WARN)
            .with_ansi(false)
            .with_writer(move || log.clone())
            .finish();
        tracing::subscriber::set_default(subscriber)
    }

    /// Each line that names `event`.
    fn records(&self, event: &str) -> Vec<String> {
        let marker = format!("event.name=\"{event}\"");
        String::from_utf8_lossy(&self.0.lock().unwrap())
            .lines()
            .filter(|line| line.contains(&marker))
            .map(str::to_owned)
            .collect()
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
    }
}

fn worker_on(url: &str, queue: &str) -> Worker {
    let manager = deadpool_postgres::Manager::new(url.parse().unwrap(), NoTls);
    let pool = deadpool_postgres::Pool::builder(manager).max_size(4).build().unwrap();
    Worker::new(pool, {
        let mut options = WorkerOptions::default();
        options.queues = vec![queue.into()];
        options.worker_id = Some(queue.into());
        options.polling_only = true;
        options.disable_registry = true;
        options.lease_duration = Duration::from_secs(15);
        options.maintenance_interval = Duration::from_secs(3600);
        options
    })
    .unwrap()
}

/// SM-2013: the Rust worker logged a failed expiry request without `event.name` and
/// `error.type`, so an alert on `workhorse.worker.expiration_request_failed` did not see it. The
/// first `expire_owned` request fails with `lock_not_available`, as in the shared fixture
/// `deadline-settles-after-a-failed-expiry-request`.
#[tokio::test]
async fn a_failed_expiry_request_logs_its_event() {
    let Some(database) = scratch_database("worker_expiry_request_log").await else { return };
    let (client, connection) = tokio_postgres::connect(database.url(), NoTls).await.unwrap();
    tokio::spawn(connection);
    client
        .batch_execute(
            r"
            CREATE SEQUENCE workhorse.test_expiry_calls;
            DO $copy$ BEGIN EXECUTE replace(
              pg_get_functiondef('workhorse.expire_owned_telemetry_v1(uuid,text,bigint)'::regprocedure),
              'FUNCTION workhorse.expire_owned_telemetry_v1(',
              'FUNCTION workhorse.test_original_expire_owned_telemetry_v1('); END $copy$;
            CREATE OR REPLACE FUNCTION workhorse.expire_owned_telemetry_v1(
              p_task_id uuid, p_worker_id text, p_fence_token bigint)
              RETURNS TABLE (status text, retry_state text) LANGUAGE plpgsql AS $body$
              BEGIN
                IF nextval('workhorse.test_expiry_calls') = 1 THEN
                  RAISE EXCEPTION 'injected expiry request failure' USING ERRCODE = '55P03';
                END IF;
                RETURN QUERY SELECT * FROM workhorse.test_original_expire_owned_telemetry_v1(
                  p_task_id, p_worker_id, p_fence_token);
              END $body$;
            ",
        )
        .await
        .unwrap();
    let queue_name = "rust-expiry-request-log";
    let queue = Queue::connect(database.url(), queue_name).await.unwrap();
    let mut options = EnqueueOptions::default();
    options.max_attempts = 1;
    options.deadline = Some(chrono::Utc::now() + chrono::Duration::milliseconds(300));
    let task_id = queue.enqueue("deadline", &json!({}), options).await.unwrap().task_id;
    let worker = worker_on(database.url(), queue_name);
    worker.handle("deadline", |_: Value, context: HandlerContext| async move {
        context.cancellation().cancelled().await;
        Err::<Value, _>(HandlerError::new("the deadline cancelled the handler"))
    });
    let log = CapturedLog::default();
    let _subscriber = log.install();

    let worked = tokio::time::timeout(Duration::from_secs(30), worker.run_once()).await;
    assert!(worked.unwrap().unwrap(), "the worker claimed no task");

    let row = client
        .query_one(
            "SELECT state, coalesce(error->>'name', '') FROM workhorse.task_outcome WHERE task_id = $1",
            &[&task_id],
        )
        .await
        .unwrap();
    assert_eq!(
        (row.get::<_, String>(0), row.get::<_, String>(1)),
        ("failed".to_owned(), "DeadlineExceeded".to_owned())
    );
    let records = log.records("workhorse.worker.expiration_request_failed");
    assert_eq!(records.len(), 1, "{}", log.text());
    let record = &records[0];
    for field in [
        " WARN ".to_owned(),
        format!("workhorse.task.id={task_id}"),
        format!("workhorse.queue.name={queue_name}"),
        format!("workhorse.worker.id={queue_name}"),
        "error.type=Postgres".to_owned(),
    ] {
        assert!(record.contains(&field), "{field} in {record}");
    }
    // docs/architecture/telemetry.md, "Log content limits": a record never holds the error message.
    assert!(!record.contains(" error="), "{record}");
}

/// SM-2016: a handler can catch the suspension of a durable call and return. The task still
/// suspends. The other five SDKs then emit `workhorse.handler.signal_swallowed`, and the Rust worker
/// emitted nothing. A handler that returns the suspension error does not swallow it.
#[tokio::test]
async fn a_swallowed_suspension_logs_one_warning() {
    let Some(database) = scratch_database("worker_signal_swallowed").await else { return };
    let (client, connection) = tokio_postgres::connect(database.url(), NoTls).await.unwrap();
    tokio::spawn(connection);
    for swallows in [true, false] {
        let queue_name = if swallows { "rust-signal-swallowed" } else { "rust-signal-returned" };
        let queue = Queue::connect(database.url(), queue_name).await.unwrap();
        let task_id =
            queue.enqueue("sleeping", &json!({}), EnqueueOptions::default()).await.unwrap().task_id;
        let worker = worker_on(database.url(), queue_name);
        worker.handle("sleeping", move |_: Value, context: HandlerContext| async move {
            let slept = context.sleep("pause", Duration::from_secs(3600)).await;
            if swallows {
                return Ok::<Value, HandlerError>(json!("caught"));
            }
            slept?;
            Ok(json!("woke"))
        });
        let log = CapturedLog::default();
        let subscriber = log.install();

        let worked = tokio::time::timeout(Duration::from_secs(30), worker.run_once()).await;
        assert!(worked.unwrap().unwrap(), "{queue_name}: the worker claimed no task");
        drop(subscriber);

        let state: String = client
            .query_one("SELECT state FROM workhorse.task_runtime WHERE task_id = $1", &[&task_id])
            .await
            .unwrap()
            .get(0);
        assert_eq!(state, "scheduled", "{queue_name}");
        let records = log.records("workhorse.handler.signal_swallowed");
        if !swallows {
            assert!(records.is_empty(), "{queue_name}: {records:?}");
            continue;
        }
        assert_eq!(records.len(), 1, "{}", log.text());
        let record = &records[0];
        for field in [
            " WARN ".to_owned(),
            "Task handler swallowed its abort signal".to_owned(),
            "workhorse.handler.outcome=\"suspended\"".to_owned(),
            format!("workhorse.task.id={task_id}"),
            format!("workhorse.queue.name={queue_name}"),
            format!("workhorse.worker.id={queue_name}"),
        ] {
            assert!(record.contains(&field), "{field} in {record}");
        }
    }
}

/// One event: its level and its own fields, without the fields of its spans.
#[derive(Clone, Debug)]
struct Event {
    level: Level,
    fields: BTreeMap<String, String>,
}

impl Event {
    fn field(&self, key: &str) -> &str {
        self.fields.get(key).map_or("<missing>", String::as_str)
    }

    /// Checks the level and each of `fields`. A field that `fields` does not name can be present.
    fn expect(&self, level: Level, fields: &[(&str, String)]) {
        assert_eq!(self.level, level, "{self:?}");
        for (key, value) in fields {
            assert_eq!(self.field(key), value, "{key} in {self:?}");
        }
    }
}

struct FieldVisitor<'a>(&'a mut BTreeMap<String, String>);

impl Visit for FieldVisitor<'_> {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.0.insert(field.name().to_owned(), value.to_owned());
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.0.insert(field.name().to_owned(), format!("{value:?}"));
    }
}

/// Keeps every event of the thread while its guard lives.
#[derive(Clone, Default)]
struct Events(Arc<Mutex<Vec<Event>>>);

impl<S: tracing::Subscriber> Layer<S> for Events {
    fn on_event(&self, event: &tracing::Event<'_>, _: Context<'_, S>) {
        let mut fields = BTreeMap::new();
        event.record(&mut FieldVisitor(&mut fields));
        self.0.lock().unwrap().push(Event { level: *event.metadata().level(), fields });
    }
}

impl Events {
    fn install(&self) -> tracing::subscriber::DefaultGuard {
        tracing::subscriber::set_default(tracing_subscriber::registry().with(self.clone()))
    }

    /// Each event named `name`, in the order the code wrote them.
    fn named(&self, name: &str) -> Vec<Event> {
        let events = self.0.lock().unwrap();
        events.iter().filter(|event| event.field("event.name") == name).cloned().collect()
    }

    /// The one event named `name`.
    fn one(&self, name: &str) -> Event {
        let events = self.named(name);
        assert_eq!(events.len(), 1, "{name}: {events:?}");
        events.into_iter().next().unwrap()
    }

    /// The one event named `name` whose `key` field is `value`.
    fn one_with(&self, name: &str, key: &str, value: &str) -> Event {
        let events: Vec<_> =
            self.named(name).into_iter().filter(|event| event.field(key) == value).collect();
        assert_eq!(events.len(), 1, "{name} with {key}={value}: {:?}", self.named(name));
        events.into_iter().next().unwrap()
    }

    /// Waits up to 30 s for an event named `name` whose message is `message`.
    async fn wait_for(&self, name: &str, message: &str) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        while !self.named(name).iter().any(|event| event.field("message") == message) {
            assert!(tokio::time::Instant::now() < deadline, "no {name} with {message:?}");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

fn audit(request_id: &str) -> AdminAudit {
    AdminAudit { actor: "ops".into(), reason: "log test".into(), request_id: request_id.into() }
}

fn pool_on(url: &str) -> deadpool_postgres::Pool {
    let manager = deadpool_postgres::Manager::new(url.parse().unwrap(), NoTls);
    deadpool_postgres::Pool::builder(manager).max_size(4).build().unwrap()
}

fn text(value: impl ToString) -> String {
    value.to_string()
}

/// SM-2068: the Rust queue and admin clients wrote none of the enqueue, delivery, cancellation,
/// schedule, queue administration, and redrive events of the TypeScript clients.
#[tokio::test]
async fn queue_and_admin_calls_log_their_events() {
    let Some(database) = scratch_database("queue_admin_log_events").await else { return };
    let queue_name = "rust-log-queue";
    let queue = Queue::connect(database.url(), queue_name).await.unwrap();
    let admin = Admin::connect(database.url()).await.unwrap();
    let events = Events::default();
    let _subscriber = events.install();

    let mut idempotent = EnqueueOptions::default();
    idempotent.idempotency = Some(Idempotency::new("order-1"));
    let accepted = queue.enqueue("mail.send", &json!({}), idempotent.clone()).await.unwrap();
    let replayed = queue.enqueue("mail.send", &json!({}), idempotent).await.unwrap();
    assert_eq!(replayed.outcome, EnqueueOutcome::Replayed);
    let mut debounced = EnqueueOptions::default();
    debounced.debounce = Some(Debounce::new("index", 60_000, DebounceSchedule::Reset));
    let first_debounce = queue.enqueue("index.build", &json!({}), debounced.clone()).await.unwrap();
    let replaced = queue.enqueue("index.build", &json!({}), debounced).await.unwrap();
    assert_eq!(replaced.outcome, EnqueueOutcome::Replaced);
    let mut throttled = EnqueueOptions::default();
    throttled.throttle = Some(Throttle::new("digest", 60_000));
    let first_throttle = queue.enqueue("digest.send", &json!({}), throttled.clone()).await.unwrap();
    let coalesced = queue.enqueue("digest.send", &json!({}), throttled).await.unwrap();
    assert_eq!(coalesced.outcome, EnqueueOutcome::Coalesced);
    // A debounce on the key of a throttle cannot replace the throttled task.
    let mut other_mode = EnqueueOptions::default();
    other_mode.debounce = Some(Debounce::new("digest", 60_000, DebounceSchedule::Reset));
    let rejected = queue.enqueue("digest.send", &json!({}), other_mode).await.unwrap();
    assert_eq!(rejected.outcome, EnqueueOutcome::NonReplaceable);

    let task = |id: uuid::Uuid, task_type: &str| {
        vec![
            ("workhorse.task.id", text(id)),
            ("workhorse.task.type", text(task_type)),
            ("workhorse.queue.name", text(queue_name)),
        ]
    };
    assert_eq!(events.named("workhorse.task.enqueued").len(), 3);
    for (id, task_type) in [
        (accepted.task_id, "mail.send"),
        (first_debounce.task_id, "index.build"),
        (first_throttle.task_id, "digest.send"),
    ] {
        events
            .one_with("workhorse.task.enqueued", "workhorse.task.id", &id.to_string())
            .expect(Level::DEBUG, &task(id, task_type));
    }
    for (name, id, task_type) in [
        ("workhorse.task.enqueue_replayed", replayed.task_id, "mail.send"),
        ("workhorse.task.debounced", replaced.task_id, "index.build"),
        ("workhorse.task.throttled", coalesced.task_id, "digest.send"),
        ("workhorse.task.debounce_rejected", rejected.task_id, "digest.send"),
    ] {
        events.one(name).expect(Level::DEBUG, &task(id, task_type));
    }

    let canceled = queue.cancel(accepted.task_id, Some("ops"), Some("not needed")).await.unwrap();
    events.one("workhorse.task.cancellation_processed").expect(
        Level::INFO,
        &[
            ("workhorse.task.id", text(accepted.task_id)),
            ("workhorse.task.state", text(canceled.state.map_or("not_found", |s| s.as_str()))),
            ("workhorse.operation.status", text(canceled.status.as_str())),
        ],
    );
    let cancellation = events.one("workhorse.task.cancellation_processed");
    assert!(!cancellation.fields.values().any(|value| value.contains("not needed")));

    let options = DeliveryOptions::new("delivery-1", "ops");
    let signal = queue
        .send_signal(first_debounce.task_id, "approval", &json!({}), options.clone())
        .await
        .unwrap();
    events.one("workhorse.task.signal_processed").expect(
        Level::INFO,
        &[
            ("workhorse.task.id", text(first_debounce.task_id)),
            ("workhorse.signal.name", text("approval")),
            ("workhorse.signal.status", text(signal.status.as_str())),
        ],
    );
    let human = queue
        .complete_human_wait(first_debounce.task_id, "review", &json!({}), options)
        .await
        .unwrap();
    events.one("workhorse.task.human_wait_processed").expect(
        Level::INFO,
        &[
            ("workhorse.task.id", text(first_debounce.task_id)),
            ("workhorse.human_wait.name", text("review")),
            ("workhorse.human_wait.status", text(human.status.as_str())),
        ],
    );
    for event in ["workhorse.task.signal_processed", "workhorse.task.human_wait_processed"] {
        assert!(!events.one(event).fields.values().any(|value| value.contains("delivery-1")));
    }

    let definition = ScheduleDefinition::new(
        "nightly",
        "0 3 * * *",
        ScheduledTask::new("report.build", json!({})),
    );
    queue.sync_schedules("rust-log-schedules", vec![definition], true).await.unwrap();
    events.one("workhorse.schedules.synchronized").expect(
        Level::INFO,
        &[
            ("workhorse.schedule.namespace", text("rust-log-schedules")),
            ("workhorse.schedule.count", text(1)),
        ],
    );

    admin.pause_queue(queue_name, &audit("pause-1")).await.unwrap();
    events
        .one("workhorse.queue.paused")
        .expect(Level::INFO, &[("workhorse.queue.name", text(queue_name))]);
    admin.resume_queue(queue_name, &audit("resume-1")).await.unwrap();
    events
        .one("workhorse.queue.resumed")
        .expect(Level::INFO, &[("workhorse.queue.name", text(queue_name))]);
    let tier = admin.set_queue_tier("rust-log-fast", QueueTier::Fast, &audit("tier-1")).await;
    events.one("workhorse.queue.tier_set").expect(
        Level::INFO,
        &[
            ("workhorse.queue.name", text("rust-log-fast")),
            ("workhorse.queue.tier", text(tier.unwrap().as_str())),
        ],
    );

    let redriven = admin.redrive(first_throttle.task_id, &audit("redrive-1")).await.unwrap();
    events.one("workhorse.task.redrive_processed").expect(
        Level::INFO,
        &[
            ("workhorse.task.id", text(first_throttle.task_id)),
            (
                "workhorse.redrive.target_task_id",
                redriven.target_task_id.map_or_else(|| text("none"), text),
            ),
            ("workhorse.operation.status", text(redriven.status.as_str())),
        ],
    );
    let mut bulk = BulkRedriveOptions::default();
    bulk.dry_run = true;
    let page =
        admin.redrive_many(DeadLetterFilter::default(), &audit("redrive-2"), bulk).await.unwrap();
    events.one("workhorse.tasks.redrive_processed").expect(
        Level::INFO,
        &[
            ("workhorse.task.count", text(page.results.len())),
            ("workhorse.redrive.dry_run", text(true)),
        ],
    );

    let purged = admin.purge_queue(queue_name, &audit("purge-1")).await.unwrap();
    assert!(purged > 0);
    events.one("workhorse.queue.purged").expect(
        Level::INFO,
        &[("workhorse.queue.name", text(queue_name)), ("workhorse.task.count", text(purged))],
    );

    // No registration has this ID, so the pause changes nothing and writes no event.
    assert!(admin
        .set_worker_paused("no-such-worker", true, &audit("pause-2"))
        .await
        .unwrap()
        .is_none());
    assert!(events.named("workhorse.worker.paused").is_empty());
}

/// SM-2068: the Rust worker wrote no life-cycle, registration, handler registration, maintenance,
/// or schedule event. `workhorse.worker.registered` comes after the first registration and after
/// each change of the active slots, the draining state, or the pause state, as in
/// `Worker.refreshRegistration` of TypeScript.
#[tokio::test]
async fn a_worker_run_logs_its_life_cycle() {
    let Some(database) = scratch_database("worker_life_cycle_log").await else { return };
    let (client, connection) = tokio_postgres::connect(database.url(), NoTls).await.unwrap();
    tokio::spawn(connection);
    let (queue_name, worker_id, namespace) =
        ("rust-log-life-cycle", "rust-log-life-cycle-worker", "rust-log-cron");
    // The worker does not claim from this queue, so its active slots stay at zero.
    let elsewhere = Queue::connect(database.url(), "rust-log-elsewhere").await.unwrap();
    let mut later = EnqueueOptions::default();
    later.run_at = Some(chrono::Utc::now() + chrono::Duration::milliseconds(200));
    elsewhere.enqueue("promoted", &json!({}), later).await.unwrap();
    let mut definition =
        ScheduleDefinition::new("every-minute", "* * * * *", ScheduledTask::new("cron", json!({})));
    definition.catchup_policy = ScheduleCatchupPolicy::Latest;
    elsewhere.sync_schedules(namespace, vec![definition], true).await.unwrap();
    client
        .execute(
            "UPDATE workhorse.schedule_definition
                SET last_evaluated_at = clock_timestamp() - interval '2 minutes'",
            &[],
        )
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(400)).await;
    let admin = Admin::connect(database.url()).await.unwrap();

    let events = Events::default();
    let _subscriber = events.install();
    let worker = Worker::new(pool_on(database.url()), {
        let mut options = WorkerOptions::default();
        options.queues = vec![queue_name.into()];
        options.worker_id = Some(worker_id.into());
        options.registry_interval = Duration::from_millis(100);
        options.maintenance_interval = Duration::from_secs(3600);
        options.schedule_namespaces = vec![namespace.into()];
        options.concurrency = 2;
        options
    })
    .unwrap();
    worker.handle("single", |_: Value, _| async { Ok::<_, HandlerError>(json!(null)) });
    worker.handle_batch(
        "batched",
        BatchOptions::new(2, Duration::from_millis(10)),
        |items: Vec<workhorse::BatchItem<Value>>| async move {
            items.iter().map(|_| BatchResult::Succeeded(json!(null))).collect::<Vec<_>>()
        },
    );
    let worker_fields = || vec![("workhorse.worker.id", text(worker_id))];
    events.one_with("workhorse.handler.registered", "workhorse.task.type", "single").expect(
        Level::DEBUG,
        &[("workhorse.task.type", text("single")), ("workhorse.worker.id", text(worker_id))],
    );
    events.one_with("workhorse.handler.registered", "workhorse.task.type", "batched").expect(
        Level::DEBUG,
        &[
            ("workhorse.task.type", text("batched")),
            ("workhorse.handler.batch.max_size", text(2)),
            ("workhorse.handler.batch.linger_ms", text(10)),
            ("workhorse.worker.id", text(worker_id)),
        ],
    );

    let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
    let running = tokio::spawn({
        let worker = worker.clone();
        async move {
            worker
                .run(async {
                    let _ = stopped.await;
                })
                .await
        }
    });
    events.wait_for("workhorse.worker.registered", "Worker registration changed").await;
    // Unchanged refreshes write no event.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(events.named("workhorse.worker.registered").len(), 1);
    admin.set_worker_paused(worker_id, true, &audit("pause-1")).await.unwrap().unwrap();
    events.wait_for("workhorse.worker.paused", "Worker paused remotely").await;
    admin.set_worker_paused(worker_id, false, &audit("resume-1")).await.unwrap().unwrap();
    events.wait_for("workhorse.worker.resumed", "Worker resumed remotely").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();

    // `tracing` records no list value, so the queues are the JSON text of the list.
    let queues = serde_json::to_string(&[queue_name]).unwrap();
    events.one("workhorse.worker.started").expect(
        Level::INFO,
        &[
            ("workhorse.worker.id", text(worker_id)),
            ("workhorse.worker.concurrency", text(2)),
            ("workhorse.worker.queues", queues.clone()),
        ],
    );
    events.one("workhorse.worker.polling_only").expect(
        Level::WARN,
        &[
            ("workhorse.worker.id", text(worker_id)),
            ("workhorse.worker.queues", queues.clone()),
            ("workhorse.worker.pool_max_size", text(4)),
        ],
    );
    let registered = events.named("workhorse.worker.registered");
    let states: Vec<_> = registered
        .iter()
        .map(|event| {
            event.expect(
                Level::DEBUG,
                &[
                    ("workhorse.worker.id", text(worker_id)),
                    ("workhorse.worker.queues", queues.clone()),
                    ("workhorse.worker.concurrency", text(2)),
                    ("workhorse.worker.active_slots", text(0)),
                ],
            );
            (event.field("workhorse.worker.draining"), event.field("workhorse.worker.paused"))
        })
        .collect();
    assert_eq!(
        states,
        [("false", "false"), ("false", "true"), ("false", "false"), ("true", "false")],
        "{registered:?}"
    );
    for (name, local, remote) in [
        ("workhorse.worker.paused", "Worker paused", "Worker paused remotely"),
        ("workhorse.worker.resumed", "Worker resumed", "Worker resumed remotely"),
    ] {
        let records = events.named(name);
        assert_eq!(records.len(), 2, "{records:?}");
        records[0].expect(Level::INFO, &worker_fields());
        assert_eq!(records[0].field("message"), local);
        records[1].expect(Level::INFO, &[("workhorse.worker.queues", queues.clone())]);
        assert_eq!(records[1].field("message"), remote);
        records[1].expect(Level::INFO, &worker_fields());
    }
    let maintenance = events.one_with(
        "workhorse.maintenance.completed",
        "workhorse.maintenance.phase",
        "promote",
    );
    maintenance.expect(
        Level::INFO,
        &[
            ("workhorse.maintenance.operation", text("tick")),
            ("workhorse.maintenance.skipped_lock", text(false)),
        ],
    );
    assert_ne!(maintenance.field("workhorse.maintenance.rows_affected"), "0");
    let fired = events.one("workhorse.schedule.fired");
    fired.expect(
        Level::INFO,
        &[
            ("workhorse.schedule.namespace", text(namespace)),
            ("workhorse.schedule.name", text("every-minute")),
        ],
    );
    assert_ne!(fired.field("workhorse.task.id"), "<missing>");
    for name in ["workhorse.worker.stop_requested", "workhorse.worker.stopped"] {
        events.one(name).expect(
            Level::INFO,
            &[
                ("workhorse.worker.id", text(worker_id)),
                ("workhorse.worker.queues", queues.clone()),
                ("workhorse.worker.active_slots", text(0)),
            ],
        );
    }
    events.one("workhorse.worker.deregistered").expect(
        Level::DEBUG,
        &[("workhorse.worker.id", text(worker_id)), ("workhorse.worker.deregistered", text(true))],
    );
}

/// SM-2068: the durable calls of a Rust handler wrote no checkpoint, progress, wait, or child
/// event, and an accepted heartbeat wrote no event.
#[tokio::test]
async fn a_handler_logs_its_durable_calls() {
    let Some(database) = scratch_database("handler_durable_log_events").await else { return };
    let queue_name = "rust-log-durable";
    let queue = Queue::connect(database.url(), queue_name).await.unwrap();
    let parent = queue.enqueue("parent", &json!({}), EnqueueOptions::default()).await.unwrap();
    let napper = queue.enqueue("napper", &json!({}), EnqueueOptions::default()).await.unwrap();
    let worker = Worker::new(pool_on(database.url()), {
        let mut options = WorkerOptions::default();
        options.queues = vec![queue_name.into()];
        options.worker_id = Some(queue_name.into());
        options.polling_only = true;
        options.disable_registry = true;
        options.lease_duration = Duration::from_secs(15);
        options.heartbeat_interval = Some(Duration::from_millis(100));
        options.maintenance_interval = Duration::from_secs(3600);
        options
    })
    .unwrap();
    worker.handle("parent", |_: Value, context: HandlerContext| async move {
        context.checkpoint("step", || async { Ok::<_, HandlerError>(json!(1)) }).await?;
        context.set_progress(&json!({"done": 1})).await?;
        // Long enough for several accepted heartbeats.
        tokio::time::sleep(Duration::from_millis(500)).await;
        let child: Value =
            context.run_child("kid", "child", &json!({}), EnqueueOptions::default()).await?;
        Ok::<_, HandlerError>(child)
    });
    worker.handle("napper", |_: Value, context: HandlerContext| async move {
        context.sleep("nap", Duration::from_secs(3600)).await?;
        Ok::<_, HandlerError>(json!(null))
    });
    worker.handle("child", |_: Value, _| async { Ok::<_, HandlerError>(json!(null)) });
    let events = Events::default();
    let _subscriber = events.install();
    for _ in 0..4 {
        let worked = tokio::time::timeout(Duration::from_secs(30), worker.run_once()).await;
        worked.unwrap().unwrap();
        if !events.named("workhorse.task.wait_processed").is_empty()
            && !events.named("workhorse.task.child_processed").is_empty()
        {
            break;
        }
    }

    let task = |id: uuid::Uuid, task_type: &str| {
        vec![
            ("workhorse.task.id", text(id)),
            ("workhorse.task.type", text(task_type)),
            ("workhorse.task.attempt", text(1)),
            ("workhorse.worker.id", text(queue_name)),
        ]
    };
    let with = |mut fields: Vec<(&'static str, String)>, more: &[(&'static str, &str)]| {
        fields.extend(more.iter().map(|(key, value)| (*key, text(value))));
        fields
    };
    events.one("workhorse.task.checkpoint_saved").expect(
        Level::DEBUG,
        &with(
            task(parent.task_id, "parent"),
            &[("workhorse.checkpoint.name", "step"), ("workhorse.checkpoint.status", "saved")],
        ),
    );
    events.one("workhorse.task.progress_updated").expect(
        Level::DEBUG,
        &with(task(parent.task_id, "parent"), &[("workhorse.progress.status", "updated")]),
    );
    let beats = events.named("workhorse.task.heartbeat_accepted");
    assert!(!beats.is_empty());
    beats[0].expect(Level::DEBUG, &task(parent.task_id, "parent"));
    events.one("workhorse.task.child_processed").expect(
        Level::INFO,
        &[
            ("workhorse.task.id", text(parent.task_id)),
            ("workhorse.child.name", text("kid")),
            ("workhorse.child.status", text("created")),
            ("workhorse.worker.id", text(queue_name)),
        ],
    );
    events.one("workhorse.task.wait_processed").expect(
        Level::INFO,
        &with(
            task(napper.task_id, "napper"),
            &[("workhorse.wait.name", "nap"), ("workhorse.wait.status", "scheduled")],
        ),
    );
    for event in ["workhorse.task.checkpoint_saved", "workhorse.task.progress_updated"] {
        assert!(!events.one(event).fields.values().any(|value| value.contains("done")));
    }
}

/// SM-2068: a Rust worker wrote no event when PostgreSQL refused a completion, when the worker
/// acknowledged a cancellation, or when it expired its own ownership at the deadline.
#[tokio::test]
async fn a_settlement_logs_its_ownership_events() {
    let Some(database) = scratch_database("settlement_log_events").await else { return };
    let queue_name = "rust-log-settlement";
    let queue = Arc::new(Queue::connect(database.url(), queue_name).await.unwrap());
    let canceled = queue.enqueue("cancels", &json!({}), EnqueueOptions::default()).await.unwrap();
    let mut options = EnqueueOptions::default();
    options.max_attempts = 1;
    options.deadline = Some(chrono::Utc::now() + chrono::Duration::milliseconds(300));
    let expired = queue.enqueue("deadline", &json!({}), options).await.unwrap();
    let worker = worker_on(database.url(), queue_name);
    // The handler asks to cancel its own task and returns, so complete_v1 refuses the result.
    worker.handle("cancels", {
        let queue = Arc::clone(&queue);
        move |_: Value, context: HandlerContext| {
            let queue = Arc::clone(&queue);
            async move {
                queue.cancel(context.task().id, Some("ops"), None).await.unwrap();
                Ok::<_, HandlerError>(json!(null))
            }
        }
    });
    worker.handle("deadline", |_: Value, context: HandlerContext| async move {
        context.cancellation().cancelled().await;
        Err::<Value, _>(HandlerError::new("the deadline cancelled the handler"))
    });
    let events = Events::default();
    let _subscriber = events.install();
    for _ in 0..2 {
        let worked = tokio::time::timeout(Duration::from_secs(30), worker.run_once()).await;
        assert!(worked.unwrap().unwrap(), "the worker claimed no task");
    }

    let task = |id: uuid::Uuid, task_type: &str, key: &'static str, value: &str| {
        vec![
            ("workhorse.task.id", text(id)),
            ("workhorse.task.type", text(task_type)),
            ("workhorse.task.attempt", text(1)),
            ("workhorse.worker.id", text(queue_name)),
            (key, text(value)),
        ]
    };
    events.one("workhorse.task.completion_rejected").expect(
        Level::INFO,
        &task(canceled.task_id, "cancels", "workhorse.complete.accepted", "false"),
    );
    events.one("workhorse.task.cancellation_acknowledged").expect(
        Level::INFO,
        &task(canceled.task_id, "cancels", "workhorse.cancel.accepted", "true"),
    );
    assert!(events.named("workhorse.task.completed").is_empty());
    events.one("workhorse.task.ownership_expired").expect(
        Level::INFO,
        &task(expired.task_id, "deadline", "workhorse.expiration.status", "deadline_exceeded"),
    );
}

/// SM-2068: a Rust worker wrote no event when it could not record batch evidence, when a
/// registration failed, or when a schedule occurrence was a replay.
#[tokio::test]
async fn failed_worker_statements_log_their_events() {
    let Some(database) = scratch_database("worker_failure_log_events").await else { return };
    let (client, connection) = tokio_postgres::connect(database.url(), NoTls).await.unwrap();
    tokio::spawn(connection);
    client
        .batch_execute(
            r"
            CREATE OR REPLACE FUNCTION workhorse.record_batch_dispatch_v1(
              p_batch_id uuid, p_task_ids uuid[], p_attempts integer[], p_fence_tokens bigint[],
              p_worker_id text) RETURNS integer LANGUAGE plpgsql AS $body$
              BEGIN RAISE EXCEPTION 'injected batch evidence failure'; END $body$;
            CREATE OR REPLACE FUNCTION workhorse.register_worker_v1(
              p_worker_id text, p_instance_id uuid, p_hostname text, p_pid integer,
              p_queue_names text[], p_schedule_namespaces text[], p_concurrency integer,
              p_lease_ms integer, p_heartbeat_ms integer, p_poll_ms integer,
              p_maintenance_interval_ms integer, p_maintenance_routine_poll_ms integer,
              p_registry_interval_ms integer, p_active_slots integer, p_draining boolean,
              p_client_protocol_version integer, p_sdk_language text, p_sdk_version text)
              RETURNS boolean LANGUAGE plpgsql AS $body$
              BEGIN RAISE EXCEPTION 'injected registration failure'; END $body$;
            CREATE OR REPLACE FUNCTION workhorse.tick_v1(
              p_promote_limit integer DEFAULT 1000, p_recover_limit integer DEFAULT 1000)
              RETURNS TABLE (phase text, rows_affected integer, duration_ms integer,
                             skipped_lock boolean, error jsonb, expired_leases integer,
                             retried integer, retry_dimensions jsonb)
              LANGUAGE sql AS $body$
              SELECT 'recover'::text, 3, 1, false, NULL::jsonb, 2, 1, '[]'::jsonb
              $body$;
            CREATE OR REPLACE FUNCTION workhorse.fire_due_schedules_v2(
              p_namespaces text[], p_now timestamptz, p_catchup_limit integer,
              p_evaluation_window_ms bigint)
              RETURNS TABLE(namespace text, schedule_name text, occurrence_at timestamptz,
                            task_id uuid)
              LANGUAGE sql AS $body$
              SELECT 'rust-log-replay'::text, 'nightly'::text, clock_timestamp(), NULL::uuid
              $body$;
            ",
        )
        .await
        .unwrap();
    let queue_name = "rust-log-failures";
    let queue = Queue::connect(database.url(), queue_name).await.unwrap();
    queue.enqueue("batched", &json!({}), EnqueueOptions::default()).await.unwrap();
    let worker = Worker::new(pool_on(database.url()), {
        let mut options = WorkerOptions::default();
        options.queues = vec![queue_name.into(), "rust-log-other".into()];
        options.worker_id = Some(queue_name.into());
        options.polling_only = true;
        options.maintenance_interval = Duration::from_secs(3600);
        options.schedule_namespaces = vec!["rust-log-replay".into()];
        options
    })
    .unwrap();
    worker.handle_batch(
        "batched",
        BatchOptions::new(1, Duration::ZERO),
        |items: Vec<workhorse::BatchItem<Value>>| async move {
            items.iter().map(|_| BatchResult::Succeeded(json!(null))).collect::<Vec<_>>()
        },
    );
    let events = Events::default();
    let _subscriber = events.install();
    let worked = tokio::time::timeout(Duration::from_secs(30), worker.run_once()).await;
    assert!(worked.unwrap().unwrap(), "the worker claimed no task");

    events.one("workhorse.handler.batch_evidence_failed").expect(
        Level::WARN,
        &[
            ("workhorse.queue.name", text(queue_name)),
            ("workhorse.task.type", text("batched")),
            ("workhorse.handler.batch.full", text(true)),
            ("workhorse.handler.batch.size", text(1)),
            ("workhorse.handler.batch.evidence_phase", text("dispatch")),
            ("workhorse.worker.id", text(queue_name)),
            ("error.type", text("Postgres")),
        ],
    );
    let registration = events.one("workhorse.worker.registration_failed");
    registration.expect(
        Level::INFO,
        &[
            ("workhorse.worker.id", text(queue_name)),
            ("workhorse.worker.queues", text(r#"["rust-log-failures","rust-log-other"]"#)),
            ("error.type", text("Postgres")),
        ],
    );
    let recovered = events.one("workhorse.leases.recovered");
    recovered.expect(
        Level::INFO,
        &[
            ("workhorse.recovery.rows_affected", text(3)),
            ("workhorse.recovery.expired_leases", text(2)),
            ("workhorse.recovery.retried", text(1)),
        ],
    );
    assert_eq!(recovered.field("workhorse.leases.recovered"), "<missing>", "{recovered:?}");
    assert!(!registration.fields.values().any(|value| value.contains("injected")));
    assert!(events.named("workhorse.worker.registered").is_empty());
    events.one("workhorse.schedule.fire_replayed").expect(
        Level::DEBUG,
        &[
            ("workhorse.schedule.namespace", text("rust-log-replay")),
            ("workhorse.schedule.name", text("nightly")),
        ],
    );
    assert!(events.named("workhorse.schedule.fired").is_empty());
}

/// SM-2068: when the completion after the shutdown cancellation failed, the Rust worker wrote no
/// `workhorse.worker.shutdown_settlement_failed`, as the TypeScript, Python, and Go workers do.
#[tokio::test]
async fn a_failed_settlement_after_shutdown_logs_its_event() {
    let Some(database) = scratch_database("shutdown_settlement_log").await else { return };
    let (client, connection) = tokio_postgres::connect(database.url(), NoTls).await.unwrap();
    tokio::spawn(connection);
    client
        .batch_execute(
            r"
            CREATE OR REPLACE FUNCTION workhorse.complete_v1(
              p_task_id uuid, p_worker_id text, p_fence_token bigint,
              p_result jsonb DEFAULT 'null'::jsonb)
              RETURNS boolean LANGUAGE plpgsql AS $body$
              BEGIN RAISE EXCEPTION 'injected completion failure'; END $body$;
            ",
        )
        .await
        .unwrap();
    let queue_name = "rust-log-shutdown";
    let queue = Queue::connect(database.url(), queue_name).await.unwrap();
    let task_id =
        queue.enqueue("drains", &json!({}), EnqueueOptions::default()).await.unwrap().task_id;
    let worker = Worker::new(pool_on(database.url()), {
        let mut options = WorkerOptions::default();
        options.queues = vec![queue_name.into()];
        options.worker_id = Some(queue_name.into());
        options.polling_only = true;
        options.disable_registry = true;
        options.maintenance_interval = Duration::from_secs(3600);
        options.shutdown_grace_period = Duration::from_millis(50);
        options
    })
    .unwrap();
    let (claimed, started) = tokio::sync::oneshot::channel::<()>();
    let claimed = Arc::new(Mutex::new(Some(claimed)));
    worker.handle("drains", move |_: Value, context: HandlerContext| {
        let claimed = Arc::clone(&claimed);
        async move {
            if let Some(claimed) = claimed.lock().unwrap().take() {
                let _ = claimed.send(());
            }
            context.cancellation().cancelled().await;
            Ok::<_, HandlerError>(json!("finished after the shutdown"))
        }
    });
    let events = Events::default();
    let _subscriber = events.install();
    let run = worker.run(async {
        let _ = started.await;
    });
    let ran = tokio::time::timeout(Duration::from_secs(30), run).await.unwrap();
    assert!(ran.is_err(), "the run ended without the completion error");

    events.one("workhorse.worker.shutdown_settlement_failed").expect(
        Level::WARN,
        &[
            ("workhorse.task.id", text(task_id)),
            ("workhorse.task.type", text("drains")),
            ("workhorse.task.attempt", text(1)),
            ("workhorse.queue.name", text(queue_name)),
            ("workhorse.worker.id", text(queue_name)),
            ("error.type", text("Postgres")),
        ],
    );
    assert!(events.named("workhorse.worker.stopped").is_empty());
    // A settlement that failed has no execution outcome, so the worker writes no execution record,
    // as the TypeScript worker does. The handler record still closes the attempt.
    let executions = events.named("workhorse.task.execution_finished");
    assert!(executions.is_empty(), "{executions:?}");
    events.one("workhorse.handler.finished").expect(
        Level::DEBUG,
        &[("workhorse.task.id", text(task_id)), ("workhorse.queue.name", text(queue_name))],
    );
}

/// A heartbeat delivers a cancellation, and `acknowledge_cancel_v1` refuses it. The attempt settled
/// nothing, so it has no outcome, and the worker writes no execution record, as TypeScript, Python,
/// Ruby, the JVM, and .NET do. Before, the Rust worker wrote the outcome `lease_lost`.
#[tokio::test]
async fn a_refused_cancellation_acknowledgement_logs_no_execution_record() {
    let Some(database) = scratch_database("refused_cancel_ack_log").await else { return };
    let (client, connection) = tokio_postgres::connect(database.url(), NoTls).await.unwrap();
    tokio::spawn(connection);
    client
        .batch_execute(
            r"
            CREATE OR REPLACE FUNCTION workhorse.acknowledge_cancel_v1(
              p_task_id uuid, p_worker_id text, p_fence_token bigint)
              RETURNS boolean LANGUAGE sql AS $body$ SELECT false $body$;
            ",
        )
        .await
        .unwrap();
    let queue_name = "rust-log-refused-cancel";
    let queue = Arc::new(Queue::connect(database.url(), queue_name).await.unwrap());
    let task_id =
        queue.enqueue("cancellable", &json!({}), EnqueueOptions::default()).await.unwrap().task_id;
    let worker = Worker::new(pool_on(database.url()), {
        let mut options = WorkerOptions::default();
        options.queues = vec![queue_name.into()];
        options.worker_id = Some(queue_name.into());
        options.polling_only = true;
        options.disable_registry = true;
        options.maintenance_interval = Duration::from_secs(3600);
        options.lease_duration = Duration::from_secs(3);
        options.heartbeat_interval = Some(Duration::from_millis(100));
        options
    })
    .unwrap();
    worker.handle("cancellable", {
        let queue = Arc::clone(&queue);
        move |_: Value, context: HandlerContext| {
            let queue = Arc::clone(&queue);
            async move {
                queue.cancel(context.task().id, None, None).await.unwrap();
                context.cancellation().cancelled().await;
                Err::<Value, _>(HandlerError::new("the cancellation stopped the handler"))
            }
        }
    });
    let events = Events::default();
    let _subscriber = events.install();
    let worked = tokio::time::timeout(Duration::from_secs(30), worker.run_once()).await;
    assert!(worked.unwrap().unwrap(), "the worker claimed no task");

    events.one("workhorse.task.cancellation_acknowledged").expect(
        Level::INFO,
        &[("workhorse.task.id", text(task_id)), ("workhorse.cancel.accepted", text(false))],
    );
    let executions = events.named("workhorse.task.execution_finished");
    assert!(executions.is_empty(), "{executions:?}");
    events.one("workhorse.handler.finished").expect(
        Level::DEBUG,
        &[("workhorse.task.id", text(task_id)), ("workhorse.queue.name", text(queue_name))],
    );
}

/// The records of one attempt carry the task identity themselves, as TypeScript writes them. The
/// handler span also carries it, but an exporter of log records does not copy span fields.
#[tokio::test]
async fn an_attempt_logs_its_execution_records_with_the_task_identity() {
    let Some(database) = scratch_database("attempt_execution_log_events").await else { return };
    let queue_name = "rust-log-execution";
    let queue = Queue::connect(database.url(), queue_name).await.unwrap();
    let mut once = EnqueueOptions::default();
    once.max_attempts = 1;
    let succeeds = queue.enqueue("succeeds", &json!({}), EnqueueOptions::default()).await.unwrap();
    let fails = queue.enqueue("fails", &json!({}), once).await.unwrap();
    let unknown = queue.enqueue("unknown", &json!({}), EnqueueOptions::default()).await.unwrap();
    queue.enqueue("batched", &json!({}), EnqueueOptions::default()).await.unwrap();
    let worker = worker_on(database.url(), queue_name);
    worker.handle("succeeds", |_: Value, _| async { Ok::<_, HandlerError>(json!(null)) });
    worker.handle("fails", |_: Value, _| async {
        Err::<Value, _>(HandlerError::new("never-log-this"))
    });
    worker.handle_batch(
        "batched",
        BatchOptions::new(1, Duration::ZERO),
        |items: Vec<workhorse::BatchItem<Value>>| async move {
            items.iter().map(|_| BatchResult::Succeeded(json!(null))).collect::<Vec<_>>()
        },
    );
    let events = Events::default();
    let _subscriber = events.install();
    for _ in 0..4 {
        let worked = tokio::time::timeout(Duration::from_secs(30), worker.run_once()).await;
        worked.unwrap().unwrap();
    }

    let task = |id: uuid::Uuid, task_type: &str| {
        vec![
            ("workhorse.task.id", text(id)),
            ("workhorse.task.type", text(task_type)),
            ("workhorse.task.attempt", text(1)),
            ("workhorse.worker.id", text(queue_name)),
        ]
    };
    let attempt = |id: uuid::Uuid, task_type: &str| {
        let mut fields = task(id, task_type);
        fields.push(("workhorse.queue.name", text(queue_name)));
        fields
    };
    let id = succeeds.task_id.to_string();
    let started = events.one_with("workhorse.handler.started", "workhorse.task.id", &id);
    started.expect(Level::DEBUG, &attempt(succeeds.task_id, "succeeds"));
    assert_eq!(started.field("message"), "Task handler started");
    // As in TypeScript, the claim record carries the attempt, so a query joins it to its execution.
    let claimed = events.one_with("workhorse.task.claimed", "workhorse.task.id", &id);
    assert_eq!(claimed.field("workhorse.task.attempt"), "1", "{claimed:?}");
    let finished = events.one_with("workhorse.handler.finished", "workhorse.task.id", &id);
    finished.expect(Level::DEBUG, &attempt(succeeds.task_id, "succeeds"));
    assert_eq!(finished.field("message"), "Task handler finished");
    assert_ne!(finished.field("workhorse.handler.duration_ms"), "<missing>", "{finished:?}");
    let execution = events.one_with("workhorse.task.execution_finished", "workhorse.task.id", &id);
    execution.expect(Level::INFO, &attempt(succeeds.task_id, "succeeds"));
    assert_eq!(execution.field("workhorse.handler.outcome"), "succeeded");
    assert_eq!(execution.field("workhorse.handler.duration_ms"), "<missing>", "{execution:?}");
    let mut completed = task(succeeds.task_id, "succeeds");
    completed.push(("workhorse.complete.accepted", text(true)));
    events
        .one_with("workhorse.task.completed", "workhorse.task.id", &id)
        .expect(Level::INFO, &completed);

    let failure = events.one("workhorse.task.failure_processed");
    let mut failed = task(fails.task_id, "fails");
    failed.push(("workhorse.attempt.outcome", text("failed")));
    failure.expect(Level::INFO, &failed);
    assert_eq!(failure.field("message"), "Task attempt failure processed");
    assert_eq!(failure.field("workhorse.task.state"), "<missing>", "{failure:?}");

    events
        .one("workhorse.handler.missing")
        .expect(Level::WARN, &attempt(unknown.task_id, "unknown"));
    let mut released = task(unknown.task_id, "unknown");
    released.push(("workhorse.release.status", text("released")));
    events.one("workhorse.task.release_processed").expect(Level::INFO, &released);
    // A claim without a handler writes the handler and execution records as TypeScript does.
    let id = unknown.task_id.to_string();
    events
        .one_with("workhorse.handler.started", "workhorse.task.id", &id)
        .expect(Level::DEBUG, &attempt(unknown.task_id, "unknown"));
    events
        .one_with("workhorse.handler.finished", "workhorse.task.id", &id)
        .expect(Level::DEBUG, &attempt(unknown.task_id, "unknown"));
    let mut execution = attempt(unknown.task_id, "unknown");
    execution.push(("workhorse.handler.outcome", text("released")));
    events
        .one_with("workhorse.task.execution_finished", "workhorse.task.id", &id)
        .expect(Level::INFO, &execution);

    let dispatched = events.one("workhorse.handler.batch_dispatched");
    dispatched.expect(Level::INFO, &[("workhorse.queue.name", text(queue_name))]);
    assert_eq!(dispatched.field("message"), "Task batch dispatched");
    let all = format!("{:?}", events.0.lock().unwrap());
    assert!(!all.contains("never-log-this"), "a record holds the error message");
}

/// The panic message of [`PanickingLayer`].
const SUBSCRIBER_PANIC: &str = "the log subscriber failed";

/// A layer that panics on each record of the SDK, as a failing `tracing` subscriber can.
struct PanickingLayer;

impl PanickingLayer {
    /// Keeps the expected panics of this layer out of the test output. The panic hook is global,
    /// so each other panic goes to the earlier hook.
    fn quiet_hook() {
        static QUIET: std::sync::Once = std::sync::Once::new();
        QUIET.call_once(|| {
            let earlier = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                if info.payload().downcast_ref::<&str>() != Some(&SUBSCRIBER_PANIC) {
                    earlier(info);
                }
            }));
        });
    }
}

impl<S: tracing::Subscriber> Layer<S> for PanickingLayer {
    fn on_event(&self, event: &tracing::Event<'_>, _: Context<'_, S>) {
        if event.metadata().target().starts_with("workhorse") {
            std::panic::panic_any(SUBSCRIBER_PANIC);
        }
    }
}

/// A failing log subscriber never changes the result of an operation and never stops a handler.
/// Before, a subscriber panic unwound the queue, admin, and worker operations that wrote a record.
#[tokio::test]
async fn a_panicking_subscriber_changes_no_operation_result() {
    let Some(database) = scratch_database("panicking_log_subscriber").await else { return };
    let queue_name = "rust-log-panicking";
    let queue = Queue::connect(database.url(), queue_name).await.unwrap();
    let admin = Admin::connect(database.url()).await.unwrap();
    PanickingLayer::quiet_hook();
    let _subscriber =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(PanickingLayer));

    let purged = queue.enqueue("purged", &json!({}), EnqueueOptions::default()).await.unwrap();
    assert_eq!(purged.outcome, EnqueueOutcome::Accepted);
    admin.pause_queue(queue_name, &audit("pause-panicking")).await.unwrap();
    admin.resume_queue(queue_name, &audit("resume-panicking")).await.unwrap();
    assert_eq!(admin.purge_queue(queue_name, &audit("purge-panicking")).await.unwrap(), 1);
    let canceled = queue.enqueue("canceled", &json!({}), EnqueueOptions::default()).await.unwrap();
    queue.cancel(canceled.task_id, None, None).await.unwrap();
    let group = queue
        .task_group(TaskGroupCallbacks::default(), vec![EnqueueRequest::new("grouped", json!({}))])
        .await
        .unwrap();
    assert_eq!(group.tasks.len(), 1);

    let ran = Arc::new(Mutex::new(false));
    let worker = worker_on(database.url(), queue_name);
    worker.handle("grouped", {
        let ran = Arc::clone(&ran);
        move |_: Value, _| {
            let ran = Arc::clone(&ran);
            async move {
                *ran.lock().unwrap() = true;
                Ok::<_, HandlerError>(json!("done"))
            }
        }
    });
    let worked = tokio::time::timeout(Duration::from_secs(30), worker.run_once()).await;
    assert!(worked.unwrap().unwrap(), "the worker claimed no task");
    assert!(*ran.lock().unwrap(), "the handler did not run");
    let (client, connection) = tokio_postgres::connect(database.url(), NoTls).await.unwrap();
    tokio::spawn(connection);
    let state: String = client
        .query_one(
            "SELECT state FROM workhorse.task_outcome WHERE task_id = $1",
            &[&group.tasks[0].task_id],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(state, "succeeded");
}

/// The task-group enqueue paths wrote no enqueue record, but the other six SDKs log them.
#[tokio::test]
async fn task_group_enqueues_log_their_events() {
    let Some(database) = scratch_database("task_group_enqueue_log").await else { return };
    let queue_name = "rust-log-groups";
    let queue = Queue::connect(database.url(), queue_name).await.unwrap();
    let events = Events::default();
    let _subscriber = events.install();

    let created = queue
        .task_group(TaskGroupCallbacks::default(), vec![EnqueueRequest::new("sealed", json!({}))])
        .await
        .unwrap();
    let open = queue.create_task_group(TaskGroupCallbacks::default()).await.unwrap();
    let added = queue
        .add_to_task_group(open.id, vec![EnqueueRequest::new("added", json!({}))])
        .await
        .unwrap();

    for (task_id, task_type) in [(created.tasks[0].task_id, "sealed"), (added[0].task_id, "added")]
    {
        events
            .one_with("workhorse.task.enqueued", "workhorse.task.id", &task_id.to_string())
            .expect(
                Level::DEBUG,
                &[
                    ("workhorse.task.type", text(task_type)),
                    ("workhorse.queue.name", text(queue_name)),
                ],
            );
    }
}

/// `fail_v2` can answer `cancel_requested`. TypeScript writes `workhorse.task.failure_processed`
/// for each answer, and the Rust worker wrote it only for the answers that settle the attempt.
#[tokio::test]
async fn a_failure_that_meets_a_cancellation_logs_its_failure_record() {
    let Some(database) = scratch_database("failure_cancel_requested_log").await else { return };
    let queue_name = "rust-log-failure-cancel";
    let queue = Arc::new(Queue::connect(database.url(), queue_name).await.unwrap());
    let task_id =
        queue.enqueue("cancels", &json!({}), EnqueueOptions::default()).await.unwrap().task_id;
    let worker = worker_on(database.url(), queue_name);
    worker.handle("cancels", {
        let queue = Arc::clone(&queue);
        move |_: Value, context: HandlerContext| {
            let queue = Arc::clone(&queue);
            async move {
                // The cancellation request comes before the failure, and no heartbeat round runs
                // in between, so fail_v2 answers cancel_requested.
                queue.cancel(context.task().id, None, None).await.unwrap();
                Err::<Value, _>(HandlerError::new("failed after the cancellation request"))
            }
        }
    });
    let events = Events::default();
    let _subscriber = events.install();
    let worked = tokio::time::timeout(Duration::from_secs(30), worker.run_once()).await;
    assert!(worked.unwrap().unwrap(), "the worker claimed no task");

    events.one("workhorse.task.failure_processed").expect(
        Level::INFO,
        &[
            ("workhorse.task.id", text(task_id)),
            ("workhorse.task.type", text("cancels")),
            ("workhorse.attempt.outcome", text("cancel_requested")),
            ("workhorse.worker.id", text(queue_name)),
        ],
    );
    events.one("workhorse.task.execution_finished").expect(
        Level::INFO,
        &[("workhorse.task.id", text(task_id)), ("workhorse.handler.outcome", text("canceled"))],
    );
}

/// TypeScript warns once when `run()` starts without a notification subscription. The Rust
/// worker did not warn when the options asked for polling.
#[tokio::test]
async fn a_polling_only_run_logs_its_warning() {
    let Some(database) = scratch_database("polling_only_warning_log").await else { return };
    let queue_name = "rust-log-polling-only";
    let worker = worker_on(database.url(), queue_name);
    let events = Events::default();
    let _subscriber = events.install();
    let run = worker.run(tokio::time::sleep(Duration::from_millis(200)));
    tokio::time::timeout(Duration::from_secs(30), run).await.unwrap().unwrap();

    events.one("workhorse.worker.polling_only").expect(
        Level::WARN,
        &[("workhorse.worker.id", text(queue_name)), ("workhorse.worker.pool_max_size", text(4))],
    );
}
