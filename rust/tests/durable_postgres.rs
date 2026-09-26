//! The durable handler context against a real PostgreSQL schema, one scratch database per test.
//!
//! Each test drives the real worker, so a suspension releases the task through PostgreSQL and a
//! replay reads back what the first attempt saved.
mod support;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::Utc;
use serde_json::{json, Value};
use support::{scratch_database, ScratchDatabase};
use tokio::sync::{mpsc, oneshot};
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;
use workhorse::{
    Admin, BatchItem, BatchOptions, BatchResult, ChildOutcome, ChildTaskRequest, DeliveryOptions,
    EnqueueOptions, Error, HandlerContext, HandlerError, HumanOutcome, Operation, Queue,
    SignalOutcome, TaskState, Worker, WorkerOptions,
};

const QUEUE: &str = "rust-durable";
const HOUR: Duration = Duration::from_secs(3600);
const WAIT: Duration = Duration::from_secs(10);

struct Harness {
    database: ScratchDatabase,
    queue: Queue<Client>,
    admin: Admin<Client>,
    worker: Worker,
}

async fn harness(name: &str) -> Option<Harness> {
    let database = scratch_database(name).await?;
    let queue = Queue::connect(database.url(), QUEUE).await.unwrap();
    let admin = Admin::connect(database.url()).await.unwrap();
    // Room for a parent and its children, and a heartbeat quick enough to see a cancellation.
    let manager = deadpool_postgres::Manager::new(database.url().parse().unwrap(), NoTls);
    let pool = deadpool_postgres::Pool::builder(manager).max_size(8).build().unwrap();
    let options = WorkerOptions {
        queues: vec![QUEUE.into()],
        worker_id: Some(format!("rust-durable-{}", Uuid::new_v4())),
        polling_only: true,
        poll_interval: Some(Duration::from_millis(20)),
        concurrency: 4,
        heartbeat_interval: Some(Duration::from_millis(100)),
        ..WorkerOptions::default()
    };
    let worker = Worker::new(pool, options).unwrap();
    Some(Harness { database, queue, admin, worker })
}

impl Harness {
    async fn enqueue(&self, task_type: &str, payload: Value) -> Uuid {
        self.queue.enqueue(task_type, &payload, EnqueueOptions::default()).await.unwrap().task_id
    }

    async fn run_once(&self) {
        assert!(self.worker.run_once().await.unwrap(), "run_once() processed nothing");
    }

    async fn state(&self, task: Uuid) -> TaskState {
        self.admin.get_task(task).await.unwrap().expect("task exists").state
    }

    async fn result(&self, task: Uuid) -> Option<Value> {
        self.admin.get_task(task).await.unwrap().expect("task exists").result
    }

    /// Makes a suspended task due now, as if its wake time had passed.
    async fn wake(&self, task: Uuid) {
        self.database
            .connect()
            .await
            .execute(
                "UPDATE workhorse.task_runtime SET run_at = clock_timestamp() - interval '1 millisecond'
                  WHERE task_id = $1",
                &[&task],
            )
            .await
            .unwrap();
    }

    async fn wait_for(&self, task: Uuid, state: TaskState) {
        tokio::time::timeout(WAIT, async {
            while self.state(task).await != state {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("task {task} never reached {state:?}"));
    }

    /// Runs the worker in the background until the returned channel is sent on.
    fn run(&self) -> (oneshot::Sender<()>, tokio::task::JoinHandle<Result<(), Error>>) {
        let (stop, stopped) = oneshot::channel::<()>();
        let worker = self.worker.clone();
        let running = tokio::spawn(async move {
            worker
                .run(async move {
                    let _ = stopped.await;
                })
                .await
        });
        (stop, running)
    }
}

fn children_options() -> EnqueueOptions {
    EnqueueOptions { queue: Some(QUEUE.into()), max_attempts: 1, ..EnqueueOptions::default() }
}

fn child(name: &str, task_type: &str, payload: Value) -> ChildTaskRequest {
    ChildTaskRequest {
        options: children_options(),
        ..ChildTaskRequest::new(name, task_type, &payload).unwrap()
    }
}

#[tokio::test]
async fn checkpoint_replays_its_saved_value_after_a_suspension() {
    let Some(harness) = harness("durable_checkpoint").await else { return };
    let task = harness.enqueue("prepare", Value::Null).await;
    let operations = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&operations);
    harness.worker.handle("prepare", move |_: Value, context: HandlerContext| {
        let counted = Arc::clone(&counted);
        async move {
            let prepared: Value = context
                .checkpoint("fetch", || async move {
                    Ok(json!({ "operation": counted.fetch_add(1, Ordering::SeqCst) + 1 }))
                })
                .await?;
            context.sleep("settle", HOUR).await?;
            Ok(prepared)
        }
    });
    harness.run_once().await;
    assert_eq!(harness.state(task).await, TaskState::Scheduled);
    let saved = harness.admin.get_checkpoint(task, "fetch").await.unwrap().unwrap();
    assert_eq!(saved.value, json!({ "operation": 1 }));
    harness.wake(task).await;
    harness.run_once().await;
    assert_eq!(harness.state(task).await, TaskState::Succeeded);
    assert_eq!(harness.result(task).await, Some(json!({ "operation": 1 })));
    assert_eq!(operations.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn sleep_suspends_until_its_wake_time_and_a_past_wake_time_returns_at_once() {
    let Some(harness) = harness("durable_sleep").await else { return };
    let sleeping = harness.enqueue("sleep", Value::Null).await;
    let until = harness.enqueue("sleep-until", Value::Null).await;
    let past = harness.enqueue("sleep-until-past", Value::Null).await;
    let runs = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&runs);
    harness.worker.handle("sleep", move |_: Value, context: HandlerContext| {
        counted.fetch_add(1, Ordering::SeqCst);
        async move {
            context.sleep("nap", HOUR).await?;
            Ok(json!("rested"))
        }
    });
    harness.worker.handle("sleep-until", |_: Value, context: HandlerContext| async move {
        context.sleep_until("dawn", Utc::now() + chrono::Duration::hours(1)).await?;
        Ok(json!("dawn"))
    });
    harness.worker.handle("sleep-until-past", |_: Value, context: HandlerContext| async move {
        context.sleep_until("yesterday", Utc::now() - chrono::Duration::days(1)).await?;
        Ok(json!("already"))
    });
    for _ in 0..3 {
        harness.run_once().await;
    }
    assert_eq!(harness.state(sleeping).await, TaskState::Scheduled);
    assert_eq!(harness.state(until).await, TaskState::Scheduled);
    assert_eq!(harness.state(past).await, TaskState::Succeeded);
    let wait = harness.admin.get_wait(sleeping, "nap").await.unwrap().unwrap();
    assert_eq!(wait.duration_ms, Some(3_600_000));
    harness.wake(sleeping).await;
    harness.run_once().await;
    assert_eq!(harness.state(sleeping).await, TaskState::Succeeded);
    assert_eq!(harness.result(sleeping).await, Some(json!("rested")));
    assert_eq!(runs.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn signal_and_human_waits_resume_with_what_was_delivered() {
    let Some(harness) = harness("durable_external_waits").await else { return };
    let signalled = harness.enqueue("signal", Value::Null).await;
    let reviewed = harness.enqueue("human", Value::Null).await;
    harness.worker.handle("signal", |_: Value, context: HandlerContext| async move {
        let signal: SignalOutcome<Value> = context.wait_for_signal("approved", None).await?;
        Ok(signal.payload)
    });
    harness.worker.handle("human", |_: Value, context: HandlerContext| async move {
        let question = json!({ "question": "ship it?" });
        let human: HumanOutcome<Value> =
            context.wait_for_human("review", &question, Some(HOUR)).await?;
        Ok(human.result)
    });
    harness.run_once().await;
    harness.run_once().await;
    assert_eq!(harness.state(signalled).await, TaskState::Scheduled);
    assert_eq!(harness.state(reviewed).await, TaskState::Scheduled);
    let options = DeliveryOptions::new("delivery-1", "ops");
    harness
        .queue
        .send_signal(signalled, "approved", &json!({ "by": "ops" }), options)
        .await
        .unwrap();
    let options = DeliveryOptions::new("delivery-2", "ann");
    harness.queue.complete_human_wait(reviewed, "review", &json!(true), options).await.unwrap();
    let (stop, running) = harness.run();
    harness.wait_for(signalled, TaskState::Succeeded).await;
    harness.wait_for(reviewed, TaskState::Succeeded).await;
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
    assert_eq!(harness.result(signalled).await, Some(json!({ "by": "ops" })));
    assert_eq!(harness.result(reviewed).await, Some(json!(true)));
}

#[tokio::test]
async fn run_child_suspends_the_parent_until_the_child_succeeds() {
    let Some(harness) = harness("durable_run_child").await else { return };
    let parent = harness.enqueue("parent", json!(20)).await;
    harness.worker.handle("parent", |input: i64, context: HandlerContext| async move {
        let doubled: i64 =
            context.run_child("double", "double", &input, children_options()).await?;
        Ok(doubled + 2)
    });
    harness.worker.handle("double", |input: i64, _| async move { Ok(input * 2) });
    let (stop, running) = harness.run();
    harness.wait_for(parent, TaskState::Succeeded).await;
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
    assert_eq!(harness.result(parent).await, Some(json!(42)));
}

#[tokio::test]
async fn run_children_reports_how_each_child_ended() {
    let Some(harness) = harness("durable_run_children").await else { return };
    let parent = harness.enqueue("fan-out", Value::Null).await;
    let outcomes = Arc::new(Mutex::new(None));
    let recorded = Arc::clone(&outcomes);
    harness.worker.handle("fan-out", move |_: Value, context: HandlerContext| {
        let recorded = Arc::clone(&recorded);
        async move {
            let children = vec![
                child("ok", "succeed", json!(7)),
                child("broken", "fail", Value::Null),
                child("stopped", "cancelled", Value::Null),
            ];
            let settled = context.run_children(children).await?;
            *recorded.lock().unwrap() = Some(settled);
            Ok(json!("settled"))
        }
    });
    harness.worker.handle("succeed", |input: i64, _| async move { Ok(input) });
    harness.worker.handle("fail", |_: Value, _| async move {
        Err::<Value, _>(HandlerError::named("Broken", "child failed"))
    });
    let (started, mut cancellable) = mpsc::unbounded_channel();
    harness.worker.handle("cancelled", move |_: Value, context: HandlerContext| {
        let started = started.clone();
        async move {
            let _ = started.send(context.task().id);
            context.cancellation().cancelled().await;
            Err::<Value, _>(HandlerError::new("cancelled"))
        }
    });
    let (stop, running) = harness.run();
    let stopped = tokio::time::timeout(WAIT, cancellable.recv()).await.unwrap().unwrap();
    harness.queue.cancel(stopped, Some("test"), Some("not needed")).await.unwrap();
    harness.wait_for(parent, TaskState::Succeeded).await;
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
    let outcomes = outcomes.lock().unwrap().take().expect("the parent resumed");
    assert_eq!(outcomes["ok"], ChildOutcome::Succeeded(json!(7)));
    let ChildOutcome::Failed(failure) = &outcomes["broken"] else {
        panic!("broken ended {:?}", outcomes["broken"])
    };
    assert_eq!((failure.name.as_str(), failure.message.as_str()), ("Broken", "child failed"));
    assert_eq!(outcomes["stopped"], ChildOutcome::Canceled);
}

#[tokio::test]
async fn run_children_all_returns_every_result_by_name() {
    let Some(harness) = harness("durable_run_children_all").await else { return };
    let parent = harness.enqueue("sum", Value::Null).await;
    harness.worker.handle("sum", |_: Value, context: HandlerContext| async move {
        let children = vec![child("a", "square", json!(3)), child("b", "square", json!(4))];
        let results = context.run_children_all(children).await?;
        Ok(json!({ "a": results["a"], "b": results["b"] }))
    });
    harness.worker.handle("square", |input: i64, _| async move { Ok(input * input) });
    let (stop, running) = harness.run();
    harness.wait_for(parent, TaskState::Succeeded).await;
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
    assert_eq!(harness.result(parent).await, Some(json!({ "a": 9, "b": 16 })));
}

#[tokio::test]
async fn progress_round_trips_and_a_quick_change_is_rate_limited() {
    let Some(harness) = harness("durable_progress").await else { return };
    let task = harness.enqueue("report", Value::Null).await;
    const RESTAMP: &str = "UPDATE workhorse.task_progress
                              SET updated_at = clock_timestamp() + interval '1 second'
                            WHERE task_id = $1";
    let restamp = Arc::new(harness.database.connect().await);
    harness.worker.handle("report", move |_: Value, context: HandlerContext| {
        let restamp = Arc::clone(&restamp);
        async move {
            assert_eq!(context.get_progress::<Value>().await?, None);
            context.set_progress(&json!({ "done": 1 })).await?;
            // An identical value is unchanged, so it is never rate limited.
            context.set_progress(&json!({ "done": 1 })).await?;
            // The window must not depend on how long the calls above took on a loaded runner.
            restamp.execute(RESTAMP, &[&context.task().id]).await.unwrap();
            let limited = context.set_progress(&json!({ "done": 2 })).await;
            let Err(Error::ProgressRateLimited { retry_after }) = limited else {
                panic!("a quick change returned {limited:?}")
            };
            assert!(retry_after > Duration::ZERO);
            Ok(context.get_progress::<Value>().await?)
        }
    });
    harness.run_once().await;
    assert_eq!(harness.result(task).await, Some(json!({ "done": 1 })));
    let progress = harness.admin.get_progress(task).await.unwrap().unwrap();
    assert_eq!((progress.value, progress.revision), (json!({ "done": 1 }), 1));
}

#[tokio::test]
async fn a_different_request_under_a_retained_name_conflicts() {
    let Some(harness) = harness("durable_conflict").await else { return };
    let task = harness.enqueue("nap", Value::Null).await;
    let runs = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&runs);
    harness.worker.handle("nap", move |_: Value, context: HandlerContext| {
        let run = counted.fetch_add(1, Ordering::SeqCst);
        async move {
            if run == 0 {
                context.sleep("nap", HOUR).await?;
                return Ok(Value::Null);
            }
            // The replay asks the retained relative wait for an absolute wake time.
            let slept = context.sleep_until("nap", Utc::now() + chrono::Duration::hours(1)).await;
            let conflicted =
                matches!(&slept, Err(Error::Conflict { operation: Operation::Sleep, name }) if name == "nap");
            Ok(json!(conflicted))
        }
    });
    harness.run_once().await;
    harness.wake(task).await;
    harness.run_once().await;
    assert_eq!(harness.result(task).await, Some(json!(true)));
}

#[tokio::test]
async fn concurrent_calls_under_one_name_share_one_durable_write() {
    let Some(harness) = harness("durable_in_flight").await else { return };
    let task = harness.enqueue("shared", Value::Null).await;
    let operations = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&operations);
    harness.worker.handle("shared", move |_: Value, context: HandlerContext| {
        let counted = Arc::clone(&counted);
        async move {
            let op = |value: i64| {
                let counted = Arc::clone(&counted);
                move || async move {
                    counted.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    Ok(value)
                }
            };
            let (first, second) =
                tokio::join!(context.checkpoint("once", op(1)), context.checkpoint("once", op(2)));
            let (first, second): (i64, i64) = (first?, second?);
            let (a, b) = tokio::join!(
                context.sleep("pause", Duration::from_secs(60)),
                context.sleep("pause", Duration::from_secs(120)),
            );
            let conflicted = [a, b]
                .into_iter()
                .filter_map(Result::err)
                .any(|error| matches!(error, Error::Conflict { operation: Operation::Sleep, .. }));
            Ok(json!([first, second, conflicted]))
        }
    });
    harness.run_once().await;
    // The second sleep conflicted and the first suspended, so the handler still returned.
    assert_eq!(operations.load(Ordering::SeqCst), 1);
    harness.wake(task).await;
    harness.run_once().await;
    let result = harness.result(task).await.unwrap();
    assert_eq!(result[0], result[1]);
    assert_eq!(result[2], json!(true), "a different concurrent sleep request did not conflict");
    assert_eq!(operations.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn batch_members_checkpoint_and_report_progress_independently() {
    let Some(harness) = harness("durable_batch").await else { return };
    let mut tasks = Vec::new();
    for payload in [1, 2] {
        tasks.push(harness.enqueue("batch", json!(payload)).await);
    }
    let options = BatchOptions { max_size: 2, linger: Duration::from_millis(500) };
    harness.worker.handle_batch("batch", options, |items: Vec<BatchItem<i64>>| async move {
        let mut results = Vec::new();
        for item in items {
            let (payload, context) = (item.payload, item.context);
            let saved = context.checkpoint("scaled", || async move { Ok(payload * 10) }).await;
            let progress = context.set_progress(&json!({ "item": payload })).await;
            results.push(match (saved, progress) {
                (Ok(saved), Ok(())) => BatchResult::Succeeded(saved),
                (Err(error), _) => BatchResult::Failed(error),
                (_, Err(error)) => BatchResult::Failed(error.into()),
            });
        }
        results
    });
    let (stop, running) = harness.run();
    for task in &tasks {
        harness.wait_for(*task, TaskState::Succeeded).await;
    }
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
    for (task, payload) in tasks.into_iter().zip([1, 2]) {
        let saved = harness.admin.get_checkpoint(task, "scaled").await.unwrap().unwrap();
        assert_eq!(saved.value, json!(payload * 10));
        let progress = harness.admin.get_progress(task).await.unwrap().unwrap();
        assert_eq!(progress.value, json!({ "item": payload }));
    }
}

#[tokio::test]
async fn invalid_requests_fail_before_reaching_postgresql() {
    let Some(harness) = harness("durable_validation").await else { return };
    let task = harness.enqueue("validate", Value::Null).await;
    harness.worker.handle("validate", |_: Value, context: HandlerContext| async move {
        let invalid = |error: &Error| matches!(error, Error::InvalidArgument(_));
        let far = Utc::now() + chrono::Duration::days(400);
        let large = json!("x".repeat(70_000));
        let many = (0..101).map(|n| child(&format!("c{n}"), "noop", Value::Null)).collect();
        let twins = vec![child("same", "noop", Value::Null), child("same", "noop", Value::Null)];
        let keyed = EnqueueOptions {
            idempotency: Some(workhorse::Idempotency::new("key")),
            ..children_options()
        };
        let checks = [
            context.sleep("", HOUR).await.is_err_and(|e| invalid(&e)),
            context.sleep("zero", Duration::ZERO).await.is_err_and(|e| invalid(&e)),
            context
                .sleep("fraction", Duration::from_micros(1500))
                .await
                .is_err_and(|e| invalid(&e)),
            context.sleep_until("far", far).await.is_err_and(|e| invalid(&e)),
            context.wait_for_signal::<Value>(" padded", None).await.is_err_and(|e| invalid(&e)),
            context
                .wait_for_human::<_, Value>("big", &large, None)
                .await
                .is_err_and(|e| invalid(&e)),
            context.run_children(twins).await.is_err_and(|e| invalid(&e)),
            matches!(
                context.run_children(many).await,
                Err(Error::LimitExceeded { operation: Operation::RunChildren, .. })
            ),
            context
                .run_child::<_, Value>("keyed", "noop", &Value::Null, keyed)
                .await
                .is_err_and(|e| invalid(&e)),
        ];
        Ok(json!(checks))
    });
    harness.run_once().await;
    assert_eq!(harness.result(task).await, Some(Value::Array(vec![json!(true); 9])));
    // Nothing reached PostgreSQL, so no wait and no child exists.
    assert!(harness.admin.list_waits(task).await.unwrap().is_empty());
}
