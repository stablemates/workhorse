//! The log events of the Rust worker against a real PostgreSQL schema.
//!
//! Each test installs its own `tracing` subscriber that writes the plain text format into a
//! buffer, and reads the fields of the records from that text. The test runtime has one thread, so
//! the tasks of the worker see that subscriber.

mod support;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use support::scratch_database;
use tokio_postgres::NoTls;
use workhorse::{EnqueueOptions, HandlerContext, HandlerError, Queue, Worker, WorkerOptions};

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
            "workhorse.handler.outcome=\"suspended\"".to_owned(),
            format!("workhorse.task.id={task_id}"),
            format!("workhorse.queue.name={queue_name}"),
            format!("workhorse.worker.id={queue_name}"),
        ] {
            assert!(record.contains(&field), "{field} in {record}");
        }
    }
}
