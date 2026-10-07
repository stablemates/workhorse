//! The durable handler context against a real PostgreSQL schema, one scratch database per test.
//!
//! Each test drives the real worker, so a suspension releases the task through PostgreSQL and a
//! replay reads back what the first attempt saved.
mod support;

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::Utc;
use serde_json::{json, Value};
use support::{scratch_database, ScratchDatabase};
use tokio::sync::{mpsc, oneshot};
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;
use workhorse::contracts::{TaskContractVersion, TaskTypeContracts};
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
    pool: deadpool_postgres::Pool,
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
    let worker = Worker::new(pool.clone(), options).unwrap();
    Some(Harness { database, queue, admin, worker, pool })
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

/// Makes `current` the contract new `task_type` tasks use, retaining every version in `versions`.
async fn sync_contract(
    harness: &Harness,
    task_type: &str,
    current: &str,
    versions: Vec<(&str, TaskContractVersion)>,
) {
    let versions = versions.into_iter().map(|(name, version)| (name.to_string(), version));
    let contracts = TaskTypeContracts {
        current_version: current.into(),
        versions: BTreeMap::from_iter(versions),
    };
    harness
        .queue
        .sync_contracts(&BTreeMap::from([(task_type.to_string(), contracts)]))
        .await
        .unwrap();
}

/// A contract accepting `{"n": integer}` whose limits and keys a stamped child carries.
fn counted_contract(max_payload_bytes: i32) -> TaskContractVersion {
    TaskContractVersion {
        payload_schema: json!({
            "type": "object",
            "properties": { "n": { "type": "integer" } },
            "required": ["n"],
        }),
        max_payload_bytes,
        max_result_bytes: 2048,
        sensitive_payload_keys: vec!["secret".into()],
        sensitive_result_keys: vec!["token".into()],
        ..TaskContractVersion::default()
    }
}

/// Each child of `task_type` as its contract version and stamped limits and keys, by child name.
async fn child_stamps(harness: &Harness, task_type: &str) -> BTreeMap<String, Value> {
    let client = harness.database.connect().await;
    let rows = client
        .query(
            "SELECT child.child_name, task.contract_version, task.payload_max_bytes,
                    task.result_max_bytes, task.payload_redact_keys, task.result_redact_keys
               FROM workhorse.task task
               JOIN workhorse.task_child child ON child.child_task_id = task.id
              WHERE task.task_type = $1",
            &[&task_type],
        )
        .await
        .unwrap();
    rows.iter()
        .map(|row| {
            let stamp = json!([
                row.get::<_, Option<String>>(1),
                row.get::<_, i32>(2),
                row.get::<_, i32>(3),
                row.get::<_, Vec<String>>(4),
                row.get::<_, Vec<String>>(5),
            ]);
            (row.get::<_, String>(0), stamp)
        })
        .collect()
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
async fn children_of_a_contracted_type_carry_its_current_contract() {
    let Some(harness) = harness("durable_contracted_children").await else { return };
    sync_contract(&harness, "counted", "v1", vec![("v1", counted_contract(4096))]).await;
    // A task makes one child-set call, so each set mode gets its own parent.
    let single = harness.enqueue("single-parent", Value::Null).await;
    let settled = harness.enqueue("settled-parent", Value::Null).await;
    let all = harness.enqueue("all-parent", Value::Null).await;
    harness.worker.handle("single-parent", |_: Value, context: HandlerContext| async move {
        let one: i64 =
            context.run_child("one", "counted", &json!({ "n": 1 }), children_options()).await?;
        Ok(json!(one))
    });
    harness.worker.handle("settled-parent", |_: Value, context: HandlerContext| async move {
        let settled =
            context.run_children(vec![child("two", "counted", json!({ "n": 2 }))]).await?;
        let ChildOutcome::Succeeded(two) = &settled["two"] else {
            panic!("two ended {:?}", settled["two"])
        };
        Ok(two.clone())
    });
    harness.worker.handle("all-parent", |_: Value, context: HandlerContext| async move {
        let all = context
            .run_children_all(vec![
                child("three", "counted", json!({ "n": 3 })),
                child("four", "counted", json!({ "n": 4 })),
            ])
            .await?;
        Ok(json!([all["three"], all["four"]]))
    });
    harness.worker.handle("counted", |input: Value, _| async move { Ok(input["n"].clone()) });
    let (stop, running) = harness.run();
    for parent in [single, settled, all] {
        harness.wait_for(parent, TaskState::Succeeded).await;
    }
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
    assert_eq!(harness.result(single).await, Some(json!(1)));
    assert_eq!(harness.result(settled).await, Some(json!(2)));
    assert_eq!(harness.result(all).await, Some(json!([3, 4])));
    let stamp = json!(["v1", 4096, 2048, ["secret"], ["token"]]);
    let stamps = child_stamps(&harness, "counted").await;
    assert_eq!(stamps.keys().collect::<Vec<_>>(), ["four", "one", "three", "two"]);
    assert!(stamps.values().all(|value| *value == stamp), "children were stamped {stamps:?}");
}

#[tokio::test]
async fn a_child_payload_its_contract_rejects_fails_before_any_write() {
    let Some(harness) = harness("durable_child_contract_validation").await else { return };
    sync_contract(&harness, "counted", "v1", vec![("v1", counted_contract(4096))]).await;
    let task = harness.enqueue("reject", Value::Null).await;
    harness.worker.handle("reject", |_: Value, context: HandlerContext| async move {
        let rejected = |error: &Error| {
            matches!(error, Error::ContractValidation { task_type, version }
                if task_type == "counted" && version == "v1")
        };
        let wrong = json!({ "n": "one" });
        let checks = [
            context
                .run_child::<_, Value>("one", "counted", &wrong, children_options())
                .await
                .is_err_and(|e| rejected(&e)),
            context
                .run_children(vec![
                    child("fine", "counted", json!({ "n": 1 })),
                    child("wrong", "counted", wrong),
                ])
                .await
                .is_err_and(|e| rejected(&e)),
        ];
        Ok(json!(checks))
    });
    harness.run_once().await;
    assert_eq!(harness.result(task).await, Some(json!([true, true])));
    assert!(child_stamps(&harness, "counted").await.is_empty());
}

#[tokio::test]
async fn a_replayed_parent_joins_children_created_under_an_older_contract() {
    let Some(harness) = harness("durable_child_contract_replay").await else { return };
    sync_contract(&harness, "counted", "v1", vec![("v1", counted_contract(4096))]).await;
    let single = harness.enqueue("single-parent", Value::Null).await;
    let set = harness.enqueue("set-parent", Value::Null).await;
    let runs = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&runs);
    harness.worker.handle("single-parent", move |_: Value, context: HandlerContext| {
        counted.fetch_add(1, Ordering::SeqCst);
        async move {
            let one: i64 =
                context.run_child("one", "counted", &json!({ "n": 1 }), children_options()).await?;
            Ok(json!(one))
        }
    });
    harness.worker.handle("set-parent", |_: Value, context: HandlerContext| async move {
        let all = context
            .run_children_all(vec![
                child("two", "counted", json!({ "n": 2 })),
                child("three", "counted", json!({ "n": 3 })),
            ])
            .await?;
        Ok(json!([all["two"], all["three"]]))
    });
    // Each parent's first attempt creates its children under v1 and suspends.
    harness.run_once().await;
    harness.run_once().await;
    assert_eq!(harness.state(single).await, TaskState::Blocked);
    assert_eq!(harness.state(set).await, TaskState::Blocked);
    // v2 accepts every payload with a different limit, so each current request differs from the
    // accepted one.
    let v2 = TaskContractVersion { payload_schema: json!(true), ..counted_contract(8192) };
    sync_contract(&harness, "counted", "v2", vec![("v1", counted_contract(4096)), ("v2", v2)])
        .await;
    harness.worker.handle("counted", |input: Value, _| async move { Ok(input["n"].clone()) });
    let (stop, running) = harness.run();
    harness.wait_for(single, TaskState::Succeeded).await;
    harness.wait_for(set, TaskState::Succeeded).await;
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
    assert_eq!(harness.result(single).await, Some(json!(1)));
    assert_eq!(harness.result(set).await, Some(json!([2, 3])));
    assert_eq!(runs.load(Ordering::SeqCst), 2, "the single-child parent never replayed");
    let stamp = json!(["v1", 4096, 2048, ["secret"], ["token"]]);
    let stamps = child_stamps(&harness, "counted").await;
    assert_eq!(stamps.len(), 3, "a replay created another child: {stamps:?}");
    assert!(stamps.values().all(|value| *value == stamp), "children were stamped {stamps:?}");
}

#[tokio::test]
async fn a_replayed_parent_keeps_a_child_its_new_contract_would_reject() {
    let Some(harness) = harness("durable_child_contract_narrowed").await else { return };
    sync_contract(&harness, "counted", "v1", vec![("v1", counted_contract(4096))]).await;
    let parent = harness.enqueue("narrowed-parent", Value::Null).await;
    harness.worker.handle("narrowed-parent", |_: Value, context: HandlerContext| async move {
        let one: i64 =
            context.run_child("one", "counted", &json!({ "n": 1 }), children_options()).await?;
        Ok(json!(one))
    });
    harness.run_once().await;
    // v2 no longer accepts the payload `one` was created with.
    let v2 = TaskContractVersion {
        payload_schema: json!({ "type": "object", "required": ["m"] }),
        ..counted_contract(4096)
    };
    sync_contract(&harness, "counted", "v2", vec![("v1", counted_contract(4096)), ("v2", v2)])
        .await;
    harness.worker.handle("counted", |input: Value, _| async move { Ok(input["n"].clone()) });
    let (stop, running) = harness.run();
    harness.wait_for(parent, TaskState::Succeeded).await;
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
    assert_eq!(harness.result(parent).await, Some(json!(1)));
    assert_eq!(child_stamps(&harness, "counted").await["one"][0], json!("v1"));
}

#[tokio::test]
async fn identical_replayed_calls_share_one_call_across_a_contract_change() {
    let Some(harness) = harness("durable_child_contract_advance").await else { return };
    sync_contract(&harness, "counted", "v1", vec![("v1", counted_contract(4096))]).await;
    let parent = harness.enqueue("advanced-parent", Value::Null).await;
    let (events, mut replay) = mpsc::unbounded_channel::<&'static str>();
    let notify = || Arc::new(tokio::sync::Notify::new());
    let (locked, advanced) = (notify(), notify());
    let attempts = Arc::new(AtomicUsize::new(0));
    let handler_notices = (Arc::clone(&locked), Arc::clone(&advanced));
    let pool = harness.pool.clone();
    harness.worker.handle("advanced-parent", move |_: Value, context: HandlerContext| {
        let replaying = attempts.fetch_add(1, Ordering::SeqCst) > 0;
        let (locked, advanced) = handler_notices.clone();
        let (events, pool) = (events.clone(), pool.clone());
        async move {
            let payload = json!({ "n": 1 });
            let one =
                || context.run_child::<_, i64>("one", "counted", &payload, children_options());
            if !replaying {
                return Ok(json!(one().await?));
            }
            events.send("replaying").unwrap();
            locked.notified().await;
            // The first call loads the current contract, then waits on the parent's locked row.
            let cloned = context.clone();
            let mut first = tokio::spawn(async move {
                cloned
                    .run_child::<_, i64>("one", "counted", &json!({ "n": 1 }), children_options())
                    .await
            });
            events.send("first").unwrap();
            advanced.notified().await;
            // The second, identical call loads a newer contract while the first is in flight.
            let second = one();
            tokio::pin!(second);
            // The second call holds a pooled connection from its first poll until its lookup
            // returns, and it joins the first call without yielding in between. Only the first
            // call's blocked statement then holds one, and other pool users can only add to that.
            let in_use = || {
                let status = pool.status();
                status.size - status.available + status.waiting
            };
            let mut early = None;
            let joined = tokio::time::timeout(WAIT, async {
                loop {
                    tokio::select! {
                        biased;
                        outcome = &mut second => {
                            early = Some(outcome);
                            return;
                        }
                        () = tokio::time::sleep(Duration::from_millis(10)) => {}
                    }
                    if in_use() <= 1 {
                        return;
                    }
                }
            })
            .await
            .is_ok();
            events.send("release").unwrap();
            let first = loop {
                tokio::select! {
                    biased;
                    outcome = &mut second, if early.is_none() => early = Some(outcome),
                    first = &mut first => break first.unwrap(),
                }
            };
            let shown = |outcome: Result<i64, Error>| match outcome {
                Ok(value) => json!(value),
                Err(error) => json!(error.to_string()),
            };
            let second = match early {
                Some(outcome) => shown(outcome),
                None => shown(tokio::time::timeout(WAIT, &mut second).await.unwrap()),
            };
            if !joined {
                return Ok(json!("the second call kept a connection while the first was blocked"));
            }
            Ok(json!([shown(first), second]))
        }
    });
    harness.worker.handle("counted", |input: Value, _| async move { Ok(input["n"].clone()) });
    harness.run_once().await;
    assert_eq!(harness.state(parent).await, TaskState::Blocked);
    let v2 = TaskContractVersion { payload_schema: json!(true), ..counted_contract(8192) };
    let v3 = TaskContractVersion { payload_schema: json!(true), ..counted_contract(16384) };
    let v1 = || ("v1", counted_contract(4096));
    sync_contract(&harness, "counted", "v2", vec![v1(), ("v2", v2.clone())]).await;
    let (stop, running) = harness.run();
    assert_eq!(replay.recv().await, Some("replaying"));
    let locker = harness.database.connect().await;
    locker.batch_execute("BEGIN").await.unwrap();
    locker
        .execute("SELECT 1 FROM workhorse.task_runtime WHERE task_id = $1 FOR UPDATE", &[&parent])
        .await
        .unwrap();
    locked.notify_one();
    assert_eq!(replay.recv().await, Some("first"));
    // A transaction reads one snapshot of pg_stat_activity, so the locker cannot watch for waiters.
    let watcher = harness.database.connect().await;
    tokio::time::timeout(WAIT, async {
        loop {
            let waiting: i64 = watcher
                .query_one(
                    "SELECT count(*) FROM pg_stat_activity
                      WHERE datname = current_database() AND pid <> pg_backend_pid()
                        AND wait_event_type = 'Lock' AND query LIKE '%create_child_v2%'",
                    &[],
                )
                .await
                .unwrap()
                .get(0);
            if waiting > 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the first call never waited on the parent's row");
    sync_contract(&harness, "counted", "v3", vec![v1(), ("v2", v2), ("v3", v3)]).await;
    advanced.notify_one();
    assert_eq!(replay.recv().await, Some("release"));
    locker.batch_execute("COMMIT").await.unwrap();
    harness.wait_for(parent, TaskState::Succeeded).await;
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
    assert_eq!(harness.result(parent).await, Some(json!([1, 1])));
    let stamps = child_stamps(&harness, "counted").await;
    assert_eq!(stamps.len(), 1, "a replay created another child: {stamps:?}");
    assert_eq!(stamps["one"][0], json!("v1"));
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

// SM-1164: the worker failed any error named after a conflict class for good. It now reads the
// marker that converting `Error::Conflict` sets, so an application error that only shares a
// conflict's name retries under the task's policy.
#[tokio::test]
async fn only_a_converted_conflict_fails_without_a_retry() {
    let Some(harness) = harness("durable_conflict_marker").await else { return };
    let options = || EnqueueOptions { max_attempts: 3, ..EnqueueOptions::default() };
    let named = harness.queue.enqueue("named", &Value::Null, options()).await.unwrap().task_id;
    let replayed =
        harness.queue.enqueue("replayed", &Value::Null, options()).await.unwrap().task_id;
    harness.worker.handle("named", |_: Value, _| async {
        Err::<Value, _>(HandlerError::named("WaitConflictError", "upstream briefly unavailable"))
    });
    let runs = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&runs);
    harness.worker.handle("replayed", move |_: Value, context: HandlerContext| {
        let run = counted.fetch_add(1, Ordering::SeqCst);
        async move {
            if run == 0 {
                context.sleep("nap", HOUR).await?;
            } else {
                context.sleep_until("nap", Utc::now() + chrono::Duration::hours(1)).await?;
            }
            Ok(Value::Null)
        }
    });
    harness.run_once().await;
    harness.run_once().await;
    harness.wake(replayed).await;
    harness.run_once().await;

    let named = harness.admin.get_task(named).await.unwrap().expect("task exists");
    assert_ne!(named.state, TaskState::Failed, "a named application error failed for good");
    assert_eq!(named.current_attempt, 2);
    assert_eq!(named.error.expect("the attempt recorded its error")["name"], "WaitConflictError");
    let replayed = harness.admin.get_task(replayed).await.unwrap().expect("task exists");
    assert_eq!(replayed.state, TaskState::Failed);
    assert_eq!(replayed.current_attempt, 1);
    assert_eq!(
        replayed.error.expect("the conflict recorded its error")["name"],
        "WaitConflictError"
    );
}

// A handler panic fails its attempt, even when it follows the shutdown cancellation. Only an
// ordinary error after that cancellation returns the task without an attempt.
#[tokio::test]
async fn a_panic_after_the_shutdown_fails_its_attempt() {
    let Some(harness) = harness("durable_shutdown_panic").await else { return };
    let options = EnqueueOptions { max_attempts: 1, ..EnqueueOptions::default() };
    let task = harness.queue.enqueue("panicking", &Value::Null, options).await.unwrap().task_id;
    let worker = Worker::new(
        harness.pool.clone(),
        WorkerOptions {
            queues: vec![QUEUE.into()],
            worker_id: Some(format!("rust-shutdown-panic-{}", Uuid::new_v4())),
            polling_only: true,
            poll_interval: Some(Duration::from_millis(20)),
            shutdown_grace_period: Duration::from_millis(50),
            ..WorkerOptions::default()
        },
    )
    .unwrap();
    let (started, mut handler_started) = tokio::sync::watch::channel(false);
    worker.handle("panicking", move |_: Value, context: HandlerContext| {
        let started = started.clone();
        async move {
            let _ = started.send(true);
            context.cancellation().cancelled().await;
            panic!("the unwind failed");
            #[allow(unreachable_code)]
            Ok(Value::Null)
        }
    });
    let (stop, stopped) = oneshot::channel::<()>();
    let running = tokio::spawn({
        let worker = worker.clone();
        async move {
            worker
                .run(async move {
                    let _ = stopped.await;
                })
                .await
        }
    });
    handler_started.wait_for(|started| *started).await.unwrap();
    stop.send(()).unwrap();
    running.await.unwrap().unwrap();
    assert_eq!(harness.state(task).await, TaskState::Failed);
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

#[tokio::test]
async fn single_child_rename_and_second_child() {
    for second in [false, true] {
        let Some(harness) = harness("durable_child_rename").await else { return };
        let parent = harness.enqueue("rename-parent", Value::Null).await;
        let runs = Arc::new(AtomicUsize::new(0));
        harness.worker.handle("rename-parent", move |_: Value, context: HandlerContext| {
            let runs = runs.clone();
            async move {
                let name = if runs.fetch_add(1, Ordering::SeqCst) == 0 { "a" } else { "b" };
                if second {
                    let _: Value = context
                        .run_child("a", "rename-child", &Value::Null, children_options())
                        .await?;
                }
                let result: Result<Value, Error> =
                    context.run_child(name, "rename-child", &Value::Null, children_options()).await;
                if name == "a" {
                    return Ok(result?);
                }
                let error = result.expect_err("a renamed call must be refused");
                let kind = match &error {
                    Error::Conflict { .. } => "conflict",
                    Error::LimitExceeded { .. } => "limit",
                    _ => "other",
                };
                Ok(json!({"kind": kind, "message": error.to_string()}))
            }
        });
        // Only the parent is registered until it has actually suspended.
        let (stop, running) = harness.run();
        harness.wait_for(parent, TaskState::Blocked).await;
        harness.worker.handle("rename-child", |_: Value, _| async { Ok(Value::Null) });
        harness.wait_for(parent, TaskState::Succeeded).await;
        stop.send(()).unwrap();
        running.await.unwrap().unwrap();
        let result = harness.result(parent).await.unwrap();
        assert_eq!(result["kind"], if second { "limit" } else { "conflict" });
        if !second {
            assert!(result["message"]
                .as_str()
                .unwrap()
                .contains("stored child \"a\", requested child \"b\""));
        }
        assert_eq!(
            harness
                .database
                .connect()
                .await
                .query_one(
                    "SELECT count(*) FROM workhorse.task_child WHERE parent_task_id = $1",
                    &[&parent]
                )
                .await
                .unwrap()
                .get::<_, i64>(0),
            1
        );
    }
}
