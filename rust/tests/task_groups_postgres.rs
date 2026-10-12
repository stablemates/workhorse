//! Task groups (ADR 0095) against a real PostgreSQL schema, one scratch database per test.
mod support;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use support::{scratch_database, ScratchDatabase};
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;
use workhorse::contracts::{TaskContractVersion, TaskTypeContracts};
use workhorse::{
    Admin, AdminAudit, BatchItem, BatchOptions, BatchResult, EnqueueOptions, EnqueueRequest, Error,
    HandlerContext, Idempotency, Queue, QueueTier, TaskGroupCallbackKind, TaskGroupCallbacks,
    TaskGroupCounts, TaskGroupEventType, TaskGroupLink, TaskGroupMemberOutcome,
    TaskGroupMemberQuery, TaskGroupResult, TaskGroupRole, TaskGroupState, Throttle, Worker,
    WorkerOptions,
};

const QUEUE: &str = "rust-groups";

struct Harness {
    database: ScratchDatabase,
    queue: Queue<Client>,
    admin: Admin<Client>,
}

async fn harness(name: &str) -> Option<Harness> {
    let database = scratch_database(name).await?;
    let queue = Queue::connect(database.url(), QUEUE).await.unwrap();
    let admin = Admin::connect(database.url()).await.unwrap();
    Some(Harness { database, queue, admin })
}

impl Harness {
    fn worker(&self) -> Worker {
        let manager = deadpool_postgres::Manager::new(self.database.url().parse().unwrap(), NoTls);
        let pool = deadpool_postgres::Pool::builder(manager).max_size(6).build().unwrap();
        let options = WorkerOptions {
            queues: vec![QUEUE.into()],
            worker_id: Some(format!("rust-groups-{}", Uuid::new_v4())),
            polling_only: true,
            poll_interval: Some(Duration::from_millis(20)),
            ..WorkerOptions::default()
        };
        Worker::new(pool, options).unwrap()
    }
}

fn request(task_type: &str, payload: Value) -> EnqueueRequest {
    EnqueueRequest::new(task_type, payload)
        .with_options(EnqueueOptions { max_attempts: 1, ..Default::default() })
}

fn audit() -> AdminAudit {
    AdminAudit { actor: "ops".into(), reason: "stop the import".into(), request_id: "req-1".into() }
}

fn closed_reason(error: Error) -> String {
    match error {
        Error::TaskGroupClosed { details } => details.reason,
        other => panic!("expected a closed task group, got {other:?}"),
    }
}

#[tokio::test]
async fn a_sealed_group_runs_its_callback_after_a_member_adds_a_task() {
    let Some(harness) = harness("task_groups_block").await else { return };
    let worker = harness.worker();
    worker.handle("import", |payload: Value, context: HandlerContext| async move {
        if payload["spawn"] == json!(true) {
            let added = context
                .task_group()
                // A request without a queue goes to `default`, as a child task request does.
                .add(vec![request("import", json!({ "spawn": false })).with_options(
                    EnqueueOptions {
                        queue: Some(QUEUE.into()),
                        max_attempts: 1,
                        ..Default::default()
                    },
                )])
                .await?;
            assert_eq!(added.len(), 1);
        }
        Ok(json!({ "imported": true }))
    });
    let seen: Arc<Mutex<Option<TaskGroupLink>>> = Arc::default();
    let reported = Arc::clone(&seen);
    worker.handle("report", move |_: Value, context: HandlerContext| {
        let reported = Arc::clone(&reported);
        async move {
            let link = context.task_group().get().await?;
            // A callback task is not a member, so it cannot add to its group.
            assert!(context.task_group().add(vec![request("import", json!({}))]).await.is_err());
            *reported.lock().unwrap() = link;
            Ok(json!(null))
        }
    });

    let callbacks = TaskGroupCallbacks {
        on_finish: Some(request("report", json!({ "report": true }))),
        on_failure: Some(request("report", json!({ "report": false }))),
        ..Default::default()
    };
    let block = harness
        .queue
        .task_group(callbacks, vec![request("import", json!({ "spawn": true }))])
        .await
        .unwrap();
    let group = block.group;
    assert_eq!(group.state, TaskGroupState::Sealed);
    assert_eq!((group.counts.total, group.counts.pending), (1, 1));
    assert_eq!(block.tasks.len(), 1);
    let kinds: Vec<_> = group.callbacks.iter().map(|callback| callback.kind).collect();
    assert_eq!(kinds, [TaskGroupCallbackKind::OnFinish, TaskGroupCallbackKind::OnFailure]);
    assert!(group.callbacks.iter().all(|callback| callback.task_id.is_none()));

    // After the seal, only a running member task can add.
    let refused =
        harness.queue.add_to_task_group(group.id, vec![request("import", json!({}))]).await;
    assert_eq!(closed_reason(refused.unwrap_err()), "sealed");

    // The first member, the member it added, then the onFinish callback.
    for _ in 0..3 {
        assert!(worker.run_once().await.unwrap());
    }
    let finished = harness.queue.get_task_group(group.id).await.unwrap().unwrap();
    assert_eq!(finished.state, TaskGroupState::Finished);
    assert_eq!(finished.result, Some(TaskGroupResult::Succeeded));
    assert_eq!((finished.counts.total, finished.counts.succeeded), (2, 2));
    let on_finish = finished.callbacks[0].task_id.expect("the onFinish task");
    assert_eq!(finished.callbacks[1].task_id, None);

    let link = seen.lock().unwrap().clone().expect("the callback read its group");
    assert_eq!(link.role, TaskGroupRole::Callback);
    assert_eq!(link.callback, Some(TaskGroupCallbackKind::OnFinish));
    assert_eq!(link.group.id, group.id);
    let found = harness.queue.find_task_group(on_finish).await.unwrap().unwrap();
    assert_eq!(found.role, TaskGroupRole::Callback);

    let page = harness
        .queue
        .list_task_group_members(group.id, TaskGroupMemberQuery { after: 0, limit: 1 })
        .await
        .unwrap();
    assert_eq!(page.members.len(), 1);
    assert_eq!(page.members[0].task_id, block.tasks[0].task_id);
    assert_eq!(page.members[0].outcome, Some(TaskGroupMemberOutcome::Succeeded));
    assert_eq!(page.next_after, Some(1));
    let rest = harness
        .admin
        .list_task_group_members(group.id, TaskGroupMemberQuery { after: 1, limit: 10 })
        .await
        .unwrap();
    assert_eq!(rest.members.len(), 1);
    assert_eq!(rest.next_after, None);
    let member = harness.queue.find_task_group(rest.members[0].task_id).await.unwrap().unwrap();
    assert_eq!((member.role, member.callback), (TaskGroupRole::Member, None));
}

#[tokio::test]
async fn an_operator_cancel_finishes_an_open_group_with_its_failure_callback() {
    let Some(harness) = harness("task_groups_cancel").await else { return };
    let mut client = harness.database.connect().await;
    let transaction = client.transaction().await.unwrap();
    let queue = Queue::new(transaction, QUEUE);
    let callbacks = TaskGroupCallbacks {
        on_success: Some(request("report", json!({}))),
        on_failure: Some(request("report", json!({}))),
        ..Default::default()
    };
    let group = queue.create_task_group(callbacks).await.unwrap();
    assert_eq!(group.state, TaskGroupState::Open);
    let added = queue
        .add_to_task_group(
            group.id,
            vec![request("import", json!({ "row": 1 })), request("import", json!({ "row": 2 }))],
        )
        .await
        .unwrap();
    assert_eq!(added.len(), 2);
    queue.into_inner().commit().await.unwrap();
    assert_eq!(harness.queue.get_task_group(group.id).await.unwrap().unwrap().counts.total, 2);

    let canceled = harness.admin.cancel_task_group(group.id, &audit()).await.unwrap().unwrap();
    assert_eq!(canceled.state, TaskGroupState::Finished);
    assert_eq!(canceled.result, Some(TaskGroupResult::Failed));
    assert_eq!(canceled.counts.canceled, 2);
    assert_eq!(canceled.canceled_by.as_deref(), Some("ops"));
    let on_failure = canceled.callbacks.iter().find(|c| c.kind == TaskGroupCallbackKind::OnFailure);
    assert!(on_failure.unwrap().task_id.is_some());
    let on_success = canceled.callbacks.iter().find(|c| c.kind == TaskGroupCallbackKind::OnSuccess);
    assert_eq!(on_success.unwrap().task_id, None);

    // A cancel of a finished group changes nothing, and a canceled group refuses every add.
    let again = harness.admin.cancel_task_group(group.id, &audit()).await.unwrap().unwrap();
    assert_eq!(again, canceled);
    let refused =
        harness.queue.add_to_task_group(group.id, vec![request("import", json!({}))]).await;
    assert_eq!(closed_reason(refused.unwrap_err()), "canceled");
    assert_eq!(harness.admin.cancel_task_group(Uuid::new_v4(), &audit()).await.unwrap(), None);
    assert_eq!(harness.admin.get_task_group(Uuid::new_v4()).await.unwrap(), None);

    let events = harness.admin.list_task_group_events(group.id, 1_000).await.unwrap();
    let types: Vec<_> = events.iter().map(|event| event.event_type).collect();
    for expected in [
        TaskGroupEventType::Created,
        TaskGroupEventType::Sealed,
        TaskGroupEventType::Canceled,
        TaskGroupEventType::Finished,
        TaskGroupEventType::CallbackEnqueued,
    ] {
        assert!(types.contains(&expected), "{expected:?} is missing from {types:?}");
    }
    assert!(harness.admin.list_task_group_drift(1_000).await.unwrap().is_empty());
    assert!(harness.admin.repair_task_group_drift(&audit(), 1_000).await.unwrap().is_empty());
    assert!(harness.admin.list_task_group_drift(0).await.is_err());
}

#[tokio::test]
async fn a_drifted_counter_is_listed_and_repaired() {
    let Some(harness) = harness("task_groups_drift").await else { return };
    let group = harness.queue.create_task_group(TaskGroupCallbacks::default()).await.unwrap();
    harness.queue.add_to_task_group(group.id, vec![request("import", json!({}))]).await.unwrap();
    harness.queue.seal_task_group(group.id).await.unwrap();
    // Make the recorded counter disagree with the one pending member. The counts of a group that
    // is not finished live in its shard rows (ADR 0096), and the member is in shard 0.
    let client = harness.database.connect().await;
    client
        .execute(
            "UPDATE workhorse.task_group_shard SET total_count = 2 WHERE group_id = $1 AND shard = 0",
            &[&group.id],
        )
        .await
        .unwrap();

    let drift = harness.admin.list_task_group_drift(10).await.unwrap();
    assert_eq!(drift.len(), 1);
    assert_eq!(
        (drift[0].group_id, drift[0].recorded.total, drift[0].counted.total),
        (group.id, 2, 1)
    );
    let repairs = harness.admin.repair_task_group_drift(&audit(), 10).await.unwrap();
    assert_eq!(repairs.len(), 1);
    assert_eq!((repairs[0].group_id, repairs[0].pending), (group.id, 1));
    assert!(harness.admin.list_task_group_drift(10).await.unwrap().is_empty());
}

#[tokio::test]
async fn task_group_refusals_map_to_their_errors() {
    let Some(harness) = harness("task_groups_errors").await else { return };
    let queue = &harness.queue;
    let group = queue.create_task_group(TaskGroupCallbacks::default()).await.unwrap();

    // A callback cannot coalesce, and an add cannot debounce or throttle.
    let keyed = request("report", json!({})).with_options(EnqueueOptions {
        idempotency: Some(Idempotency::new("report")),
        ..Default::default()
    });
    let callbacks = TaskGroupCallbacks { on_finish: Some(keyed), ..Default::default() };
    assert!(matches!(queue.create_task_group(callbacks).await, Err(Error::InvalidArgument(_))));
    let throttled = request("import", json!({})).with_options(EnqueueOptions {
        throttle: Some(Throttle::new("t", 1_000)),
        ..Default::default()
    });
    let refused = queue.add_to_task_group(group.id, vec![throttled]).await;
    assert!(matches!(refused, Err(Error::InvalidArgument(_))));
    let too_many = vec![request("import", json!({})); 1_001];
    assert!(matches!(
        queue.add_to_task_group(group.id, too_many).await,
        Err(Error::InvalidArgument(_))
    ));

    // An idempotency hit that returns a task outside the group (P1010).
    let keyed =
        EnqueueOptions { idempotency: Some(Idempotency::new("row-7")), ..Default::default() };
    let outside = queue.enqueue("import", &json!({ "row": 7 }), keyed.clone()).await.unwrap();
    let conflict = queue
        .add_to_task_group(
            group.id,
            vec![EnqueueRequest::new("import", json!({ "row": 7 })).with_options(keyed)],
        )
        .await
        .unwrap_err();
    match conflict {
        Error::TaskGroupMembershipConflict { details } => {
            assert_eq!(details.group_id, group.id.to_string());
            assert_eq!(details.task_id, outside.task_id.to_string());
            assert_eq!(details.member_of, None);
        }
        other => panic!("expected a membership conflict, got {other:?}"),
    }

    // A fast-tier member (P1007).
    harness.admin.set_queue_tier("rust-groups-fast", QueueTier::Fast, &audit()).await.unwrap();
    let fast = request("import", json!({})).with_options(EnqueueOptions {
        queue: Some("rust-groups-fast".into()),
        ..Default::default()
    });
    match queue.add_to_task_group(group.id, vec![fast]).await.unwrap_err() {
        Error::FastTierUnsupported { feature, .. } => assert_eq!(feature, "task groups"),
        other => panic!("expected a fast-tier refusal, got {other:?}"),
    }

    // An add to an unknown group, and an empty add, which sends nothing.
    assert!(queue
        .add_to_task_group(Uuid::new_v4(), vec![request("import", json!({}))])
        .await
        .is_err());
    assert!(queue.add_to_task_group(Uuid::new_v4(), Vec::new()).await.unwrap().is_empty());

    // An empty group finishes at the seal.
    let sealed = queue.seal_task_group(group.id).await.unwrap();
    assert_eq!(sealed.state, TaskGroupState::Finished);
    assert_eq!(sealed.result, Some(TaskGroupResult::Succeeded));
    let refused = queue.add_to_task_group(group.id, vec![request("import", json!({}))]).await;
    assert_eq!(closed_reason(refused.unwrap_err()), "finished");
}

#[tokio::test]
async fn a_changed_contract_reloads_before_the_group_is_created() {
    let Some(harness) = harness("task_groups_contracts").await else { return };
    let contract = TaskTypeContracts {
        current_version: "v1".into(),
        versions: BTreeMap::from([(
            "v1".to_string(),
            TaskContractVersion {
                payload_schema: json!({ "type": "object", "required": ["row"] }),
                ..TaskContractVersion::default()
            },
        )]),
    };
    let contracts = BTreeMap::from([
        ("import".to_string(), contract.clone()),
        ("report".to_string(), contract),
    ]);
    harness.queue.sync_contracts(&contracts).await.unwrap();
    // This client has no cached contract, so PostgreSQL reports a mismatch and it retries once.
    let queue = Queue::connect(harness.database.url(), QUEUE).await.unwrap();
    let callbacks = TaskGroupCallbacks {
        on_finish: Some(request("report", json!({ "row": 0 }))),
        ..Default::default()
    };
    let block =
        queue.task_group(callbacks, vec![request("import", json!({ "row": 1 }))]).await.unwrap();
    assert_eq!(block.group.counts.total, 1);
    let snapshot = harness.admin.get_task(block.tasks[0].task_id).await.unwrap().unwrap();
    assert_eq!(snapshot.contract_version.as_deref(), Some("v1"));

    // The reloaded contract now rejects a payload before any round trip.
    let group = queue.create_task_group(TaskGroupCallbacks::default()).await.unwrap();
    let invalid = queue.add_to_task_group(group.id, vec![request("import", json!({}))]).await;
    assert!(matches!(invalid, Err(Error::ContractValidation { .. })));
    let other = Queue::connect(harness.database.url(), QUEUE).await.unwrap();
    let added =
        other.add_to_task_group(group.id, vec![request("import", json!({ "row": 2 }))]).await;
    assert_eq!(added.unwrap().len(), 1);
}

#[tokio::test]
async fn a_success_callback_reads_the_counts_of_its_group() {
    let Some(harness) = harness("task_groups_success").await else { return };
    let worker = harness.worker();
    worker.handle("import", |_: Value, _: HandlerContext| async { Ok(json!(null)) });
    let seen: Arc<Mutex<Option<TaskGroupLink>>> = Arc::default();
    let reported = Arc::clone(&seen);
    worker.handle("report", move |_: Value, context: HandlerContext| {
        let reported = Arc::clone(&reported);
        async move {
            *reported.lock().unwrap() = context.task_group().get().await?;
            Ok(json!(null))
        }
    });
    let callbacks = TaskGroupCallbacks {
        on_success: Some(request("report", json!({}))),
        on_failure: Some(request("report", json!({}))),
        ..Default::default()
    };
    let members =
        vec![request("import", json!({ "row": 1 })), request("import", json!({ "row": 2 }))];
    let group = harness.queue.task_group(callbacks, members).await.unwrap().group;
    for _ in 0..3 {
        assert!(worker.run_once().await.unwrap());
    }
    let link = seen.lock().unwrap().clone().expect("the onSuccess callback ran");
    assert_eq!(
        (link.role, link.callback),
        (TaskGroupRole::Callback, Some(TaskGroupCallbackKind::OnSuccess))
    );
    assert_eq!(link.group.id, group.id);
    assert_eq!(link.group.result, Some(TaskGroupResult::Succeeded));
    let counts = TaskGroupCounts { total: 2, succeeded: 2, failed: 0, canceled: 0, pending: 0 };
    assert_eq!(link.group.counts, counts);
    let on_failure =
        link.group.callbacks.iter().find(|c| c.kind == TaskGroupCallbackKind::OnFailure);
    assert_eq!(on_failure.unwrap().task_id, None);
}

#[tokio::test]
async fn a_batch_member_adds_to_its_group() {
    let Some(harness) = harness("task_groups_batch").await else { return };
    let worker = harness.worker();
    worker.handle_batch(
        "batch-import",
        BatchOptions { max_size: 1, linger: Duration::ZERO },
        |items: Vec<BatchItem<Value>>| async move {
            let mut results = Vec::with_capacity(items.len());
            for item in &items {
                let group = item.context.task_group();
                let link = group.get().await.unwrap().expect("a member reads its group");
                assert_eq!(link.role, TaskGroupRole::Member);
                let extra = request("import", json!({})).with_options(EnqueueOptions {
                    queue: Some(QUEUE.into()),
                    max_attempts: 1,
                    ..Default::default()
                });
                assert_eq!(group.add(vec![extra]).await.unwrap().len(), 1);
                results.push(BatchResult::Succeeded(json!(null)));
            }
            results
        },
    );
    worker.handle("import", |_: Value, _: HandlerContext| async { Ok(json!(null)) });
    let members = vec![request("batch-import", json!({ "row": 1 }))];
    let group =
        harness.queue.task_group(TaskGroupCallbacks::default(), members).await.unwrap().group;
    for _ in 0..2 {
        assert!(worker.run_once().await.unwrap());
    }
    let finished = harness.queue.get_task_group(group.id).await.unwrap().unwrap();
    assert_eq!(finished.state, TaskGroupState::Finished);
    assert_eq!((finished.counts.total, finished.counts.succeeded), (2, 2));
}

#[tokio::test]
async fn a_member_add_checks_the_current_contract() {
    let Some(harness) = harness("task_groups_member_contract").await else { return };
    let contract = TaskTypeContracts {
        current_version: "v1".into(),
        versions: BTreeMap::from([(
            "v1".to_string(),
            TaskContractVersion {
                payload_schema: json!({ "type": "object", "required": ["row"] }),
                ..TaskContractVersion::default()
            },
        )]),
    };
    harness.queue.sync_contracts(&BTreeMap::from([("child".to_string(), contract)])).await.unwrap();
    let worker = harness.worker();
    let outcomes: Arc<Mutex<Vec<String>>> = Arc::default();
    let record = Arc::clone(&outcomes);
    worker.handle("import", move |_: Value, context: HandlerContext| {
        let record = Arc::clone(&record);
        async move {
            let child = |payload| {
                request("child", payload).with_options(EnqueueOptions {
                    queue: Some(QUEUE.into()),
                    ..Default::default()
                })
            };
            // The member's first add holds no contract, so PostgreSQL reports a mismatch and the
            // add reloads the contract before it checks the payload.
            let invalid = context.task_group().add(vec![child(json!({}))]).await;
            record.lock().unwrap().push(format!("{:?}", invalid.map(|added| added.len())));
            let valid = context.task_group().add(vec![child(json!({ "row": 1 }))]).await?;
            record.lock().unwrap().push(format!("added {}", valid.len()));
            Ok(json!(null))
        }
    });
    let members = vec![request("import", json!({}))];
    let group =
        harness.queue.task_group(TaskGroupCallbacks::default(), members).await.unwrap().group;
    assert!(worker.run_once().await.unwrap());
    let outcomes = outcomes.lock().unwrap().clone();
    assert!(outcomes[0].contains("ContractValidation"), "{outcomes:?}");
    assert_eq!(outcomes[1], "added 1");
    let page = harness
        .queue
        .list_task_group_members(group.id, TaskGroupMemberQuery::default())
        .await
        .unwrap();
    assert_eq!(page.members.len(), 2);
    let added = harness.admin.get_task(page.members[1].task_id).await.unwrap().unwrap();
    assert_eq!(added.contract_version.as_deref(), Some("v1"));
}
