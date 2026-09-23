//! The operator client against a real PostgreSQL schema, one scratch database per test.
mod support;

use chrono::{Duration, Utc};
use serde_json::json;
use support::scratch_database;
use tokio_postgres::{Client, NoTls};
use uuid::Uuid;
use workhorse::durable_postgres::{PostgresDurableContext, WaitState};
use workhorse::{
    Admin, AdminAudit, BulkRedriveOptions, DeadLetterFilter, DeadLetterQuery, EnqueueOptions,
    Error, ExternalWaitQuery, PayloadStatus, Queue, RedriveStatus, TaskListQuery,
    TaskPayloadProjection, TaskState, TaskTimelineEntry, TaskTimelineQuery, WaitMode,
};

const WORKER: &str = "rust-admin-test";

fn audit(request_id: &str) -> AdminAudit {
    AdminAudit { actor: "ops".into(), reason: "incident 42".into(), request_id: request_id.into() }
}

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

/// Enqueues a single-attempt task on `queue`, claims it, and fails it into a dead letter.
async fn dead_letter(queue: &Queue<Client>, observer: &Client, name: &str) -> Uuid {
    let options =
        EnqueueOptions { max_attempts: 1, tags: vec!["rust".into()], ..EnqueueOptions::default() };
    queue.enqueue("admin.fail", &json!({"n": name}), options).await.unwrap();
    let (task_id, fence) = claim(observer, "rust-admin").await;
    let state: String = observer
        .query_one(
            "SELECT workhorse.fail_v1($1, $2, $3, $4::jsonb)",
            &[&task_id, &WORKER, &fence, &json!({"name": name, "message": "boom"})],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(state, "failed");
    task_id
}

async fn register_worker(client: &Client, worker_id: &str) {
    client
        .execute(
            "SELECT workhorse.register_worker_v1($1, $2, 'rust-host', 42, $3, '{}', 1, 30000,
                    10000, 250, 1000, 60000, 5000, 0, false, NULL, NULL, NULL)",
            &[&worker_id, &Uuid::new_v4(), &vec!["rust-admin"]],
        )
        .await
        .unwrap();
}

async fn queue_paused(client: &Client, queue: &str) -> Option<bool> {
    client
        .query_opt("SELECT paused FROM workhorse.queue_control WHERE queue_name = $1", &[&queue])
        .await
        .unwrap()
        .map(|row| row.get(0))
}

#[tokio::test]
async fn admin_lists_looks_up_and_times_tasks_across_pages() {
    let Some(database) = scratch_database("admin_tasks").await else { return };
    let queue = Queue::connect(database.url(), "rust-admin").await.unwrap();
    let admin = Admin::connect(database.url()).await.unwrap();
    let observer = database.connect().await;

    let mut enqueued = Vec::new();
    for n in 0..3 {
        let payload = json!({"n": n, "secret": "hide"});
        let options = EnqueueOptions { tags: vec!["rust".into()], ..EnqueueOptions::default() };
        enqueued.push(queue.enqueue("admin.list", &payload, options).await.unwrap().task_id);
    }
    let query = TaskListQuery {
        queue: Some("rust-admin".into()),
        states: vec![TaskState::Ready],
        limit: 2,
        payload: TaskPayloadProjection {
            include: true,
            redact_keys: vec!["secret".into()],
            ..TaskPayloadProjection::default()
        },
        ..TaskListQuery::default()
    };
    let first = admin.list_tasks(query.clone()).await.unwrap();
    assert_eq!(first.items.len(), 2);
    let cursor = first.next_cursor.clone().expect("a second page");
    let second = admin.list_tasks(TaskListQuery { cursor: Some(cursor), ..query }).await.unwrap();
    assert_eq!(second.items.len(), 1);
    assert_eq!(second.next_cursor, None);
    let mut listed: Vec<Uuid> = first.items.iter().chain(&second.items).map(|t| t.id).collect();
    listed.sort();
    enqueued.sort();
    assert_eq!(listed, enqueued, "the pages cover every task once");
    let item = &first.items[0];
    assert_eq!(item.payload_status, PayloadStatus::Included);
    assert_ne!(item.payload.as_ref().unwrap()["secret"], json!("hide"));
    assert_eq!(item.tags, vec!["rust".to_string()]);

    let (task_id, fence) = claim(&observer, "rust-admin").await;
    observer
        .execute(
            "SELECT workhorse.complete_v1($1, $2, $3, $4::jsonb)",
            &[&task_id, &WORKER, &fence, &json!({"ok": true})],
        )
        .await
        .unwrap();
    let task = admin.get_task(task_id).await.unwrap().expect("the task");
    assert_eq!(task.state, TaskState::Succeeded);
    assert_eq!(task.result, Some(json!({"ok": true})));
    assert_eq!(task.fence_token, fence);
    assert_eq!(admin.get_task(Uuid::nil()).await.unwrap(), None);

    let mut entries = Vec::new();
    let mut timeline = TaskTimelineQuery { limit: 1, cursor: None };
    loop {
        let page = admin.get_task_timeline(task_id, timeline).await.unwrap();
        assert!(page.items.len() <= 1);
        entries.extend(page.items);
        match page.next_cursor {
            Some(cursor) => timeline.cursor = Some(cursor),
            None => break,
        }
    }
    assert!(entries.len() >= 2, "{entries:?}");
    assert!(entries.iter().any(|entry| matches!(
        entry,
        TaskTimelineEntry::Attempt(attempt) if attempt.worker_id == WORKER && attempt.fence_token == fence
    )));
    let foreign = TaskTimelineQuery { limit: 1, cursor: timeline.cursor };
    if foreign.cursor.is_some() {
        let rejected = admin.get_task_timeline(Uuid::nil(), foreign).await;
        assert!(matches!(rejected, Err(Error::InvalidArgument(_))), "{rejected:?}");
    }
}

#[tokio::test]
async fn admin_pauses_resumes_and_purges_a_queue() {
    let Some(database) = scratch_database("admin_queue_control").await else { return };
    let queue = Queue::connect(database.url(), "rust-admin").await.unwrap();
    let admin = Admin::connect(database.url()).await.unwrap();
    let observer = database.connect().await;

    admin.pause_queue("rust-admin", &audit("pause-1")).await.unwrap();
    assert_eq!(queue_paused(&observer, "rust-admin").await, Some(true));
    admin.resume_queue("rust-admin", &audit("resume-1")).await.unwrap();
    assert_eq!(queue_paused(&observer, "rust-admin").await, Some(false));

    for _ in 0..2 {
        queue.enqueue("admin.purge", &json!({}), EnqueueOptions::default()).await.unwrap();
    }
    assert_eq!(admin.purge_queue("rust-admin", &audit("purge-1")).await.unwrap(), 2);
    assert_eq!(admin.purge_queue("rust-admin", &audit("purge-1")).await.unwrap(), 2);
    let conflict = admin.purge_queue("rust-other", &audit("purge-1")).await;
    match conflict {
        Err(Error::PurgeIdempotencyConflict { details }) => {
            assert_eq!(details.queue, "rust-other");
            assert_eq!(details.conflicting_fields, vec!["queue".to_string()]);
        }
        other => panic!("expected a purge conflict, got {other:?}"),
    }
}

#[tokio::test]
async fn admin_lists_and_redrives_dead_letters() {
    let Some(database) = scratch_database("admin_dead_letters").await else { return };
    let queue = Queue::connect(database.url(), "rust-admin").await.unwrap();
    let admin = Admin::connect(database.url()).await.unwrap();
    let observer = database.connect().await;

    let mut failed = Vec::new();
    for name in ["First", "Second", "Third"] {
        failed.push(dead_letter(&queue, &observer, name).await);
    }
    let filter = DeadLetterFilter { tags: vec!["rust".into()], ..DeadLetterFilter::default() };
    let first = admin
        .list_dead_letters(DeadLetterQuery { filter: filter.clone(), limit: 2, cursor: None })
        .await
        .unwrap();
    assert_eq!(first.items.len(), 2);
    let second = admin
        .list_dead_letters(DeadLetterQuery {
            filter: filter.clone(),
            limit: 2,
            cursor: first.next_cursor,
        })
        .await
        .unwrap();
    assert_eq!(second.items.len(), 1);
    assert_eq!(second.next_cursor, None);
    let named = DeadLetterFilter { error_name: Some("Second".into()), ..filter.clone() };
    let only = admin
        .list_dead_letters(DeadLetterQuery { filter: named, ..DeadLetterQuery::default() })
        .await
        .unwrap();
    assert_eq!(only.items.len(), 1);
    assert_eq!(only.items[0].task_id, failed[1]);
    assert_eq!(only.items[0].error["name"], json!("Second"));

    let redriven = admin.redrive(failed[0], &audit("redrive-1")).await.unwrap();
    assert_eq!(redriven.status, RedriveStatus::Redriven);
    assert_eq!(redriven.source_task_id, failed[0]);
    assert_eq!(redriven.target_state, Some(TaskState::Ready));
    let target = redriven.target_task_id.expect("a redrive target");
    let replayed = admin.redrive(failed[0], &audit("redrive-1")).await.unwrap();
    assert_eq!(replayed.status, RedriveStatus::Replayed);
    assert_eq!(replayed.target_task_id, Some(target));
    let different = AdminAudit { reason: "another incident".into(), ..audit("redrive-1") };
    match admin.redrive(failed[0], &different).await {
        Err(Error::RedriveIdempotencyConflict { details }) => {
            assert_eq!(details.source_task_id, failed[0].to_string());
            assert_eq!(details.conflicting_fields, vec!["reason".to_string()]);
        }
        other => panic!("expected a redrive conflict, got {other:?}"),
    }
    let missing = admin.redrive(Uuid::nil(), &audit("redrive-2")).await.unwrap();
    assert_eq!(missing.status, RedriveStatus::NotFound);

    let dry_run = BulkRedriveOptions { limit: 1, dry_run: true, cursor: None };
    let preview = admin.redrive_many(filter.clone(), &audit("bulk-0"), dry_run).await.unwrap();
    assert_eq!(preview.results.len(), 1);
    assert_eq!(preview.results[0].status, RedriveStatus::Eligible);
    let mut options = BulkRedriveOptions { limit: 1, ..BulkRedriveOptions::default() };
    let mut sources = Vec::new();
    loop {
        let page = admin.redrive_many(filter.clone(), &audit("bulk-1"), options).await.unwrap();
        sources.extend(page.results.iter().map(|result| (result.source_task_id, result.status)));
        match page.next_cursor {
            Some(cursor) => options.cursor = Some(cursor),
            None => break,
        }
    }
    assert!(sources.contains(&(failed[1], RedriveStatus::Redriven)), "{sources:?}");
    assert!(sources.contains(&(failed[2], RedriveStatus::Redriven)), "{sources:?}");
}

#[tokio::test]
async fn admin_reads_checkpoints_waits_and_human_waits() {
    let Some(database) = scratch_database("admin_durable_reads").await else { return };
    let queue = Queue::connect(database.url(), "rust-admin").await.unwrap();
    let admin = Admin::connect(database.url()).await.unwrap();
    let observer = database.connect().await;

    queue.enqueue("admin.durable", &json!({}), EnqueueOptions::default()).await.unwrap();
    let (task_id, fence) = claim(&observer, "rust-admin").await;
    let context = PostgresDurableContext::new(database.connect().await, task_id, WORKER, fence);
    context.save_checkpoint("fetched", &json!({"rows": 3})).await.unwrap();
    context.publish_progress(&json!({"done": 1})).await.unwrap();
    assert!(matches!(
        context.schedule_timer("cool-down", 60_000).await.unwrap(),
        WaitState::Waiting
    ));

    let checkpoint = admin.get_checkpoint(task_id, "fetched").await.unwrap().expect("checkpoint");
    assert_eq!(checkpoint.value, json!({"rows": 3}));
    assert_eq!(checkpoint.fence_token, fence);
    assert_eq!(admin.list_checkpoints(task_id).await.unwrap(), vec![checkpoint]);
    assert_eq!(admin.get_checkpoint(task_id, "missing").await.unwrap(), None);
    let progress = admin.get_progress(task_id).await.unwrap().expect("progress");
    assert_eq!(progress.value, json!({"done": 1}));
    assert_eq!(progress.worker_id, WORKER);
    let wait = admin.get_wait(task_id, "cool-down").await.unwrap().expect("wait");
    assert_eq!(wait.mode, WaitMode::Relative);
    assert_eq!(wait.duration_ms, Some(60_000));
    assert_eq!(admin.list_waits(task_id).await.unwrap(), vec![wait]);

    let mut signals = Vec::new();
    let mut humans = Vec::new();
    for n in 0..2 {
        queue.enqueue("admin.signal", &json!({}), EnqueueOptions::default()).await.unwrap();
        let (task_id, fence) = claim(&observer, "rust-admin").await;
        let context = PostgresDurableContext::new(database.connect().await, task_id, WORKER, fence);
        context.wait_for_signal(&format!("approved-{n}"), 60_000).await.unwrap();
        signals.push(task_id);
        queue.enqueue("admin.human", &json!({}), EnqueueOptions::default()).await.unwrap();
        let (task_id, fence) = claim(&observer, "rust-admin").await;
        let context = PostgresDurableContext::new(database.connect().await, task_id, WORKER, fence);
        context.wait_for_human("review", &json!({"n": n}), 60_000).await.unwrap();
        humans.push(task_id);
    }
    let first =
        admin.list_signal_waits(ExternalWaitQuery { limit: 1, cursor: None }).await.unwrap();
    assert_eq!(first.items.len(), 1);
    let second = admin
        .list_signal_waits(ExternalWaitQuery { limit: 1, cursor: first.next_cursor.clone() })
        .await
        .unwrap();
    assert_eq!(second.next_cursor, None);
    let mut waiting: Vec<Uuid> =
        first.items.iter().chain(&second.items).map(|w| w.task_id).collect();
    waiting.sort();
    signals.sort();
    assert_eq!(waiting, signals);
    assert!(first.items[0].name.starts_with("approved-"));

    let first = admin.list_human_waits(ExternalWaitQuery { limit: 1, cursor: None }).await.unwrap();
    let second = admin
        .list_human_waits(ExternalWaitQuery { limit: 1, cursor: first.next_cursor.clone() })
        .await
        .unwrap();
    assert_eq!(second.next_cursor, None);
    let mut waiting: Vec<Uuid> =
        first.items.iter().chain(&second.items).map(|w| w.task_id).collect();
    waiting.sort();
    humans.sort();
    assert_eq!(waiting, humans);
    assert_eq!(first.items[0].name, "review");
    assert!(first.items[0].context["n"].is_number(), "{:?}", first.items[0].context);
}

#[tokio::test]
async fn admin_pauses_and_resumes_a_registered_worker() {
    let Some(database) = scratch_database("admin_worker_pause").await else { return };
    let admin = Admin::connect(database.url()).await.unwrap();
    let observer = database.connect().await;
    register_worker(&observer, "rust-worker-1").await;

    let paused =
        admin.set_worker_paused("rust-worker-1", true, &audit("worker-1")).await.unwrap().unwrap();
    assert!(paused.paused);
    assert_eq!(paused.paused_by.as_deref(), Some("ops"));
    assert_eq!(paused.reason.as_deref(), Some("incident 42"));
    assert!(paused.paused_at.is_some());
    let workers = admin.list_workers().await.unwrap();
    assert_eq!(workers.len(), 1);
    assert_eq!(workers[0].worker_id, "rust-worker-1");
    assert_eq!(workers[0].queues, vec!["rust-admin".to_string()]);
    assert!(workers[0].paused);

    let resumed =
        admin.set_worker_paused("rust-worker-1", false, &audit("worker-2")).await.unwrap().unwrap();
    assert!(!resumed.paused);
    let missing = admin.set_worker_paused("nobody", true, &audit("worker-3")).await.unwrap();
    assert_eq!(missing, None);
}

#[tokio::test]
async fn admin_rejects_invalid_audits_and_limits_before_postgres() {
    let Some(database) = scratch_database("admin_validation").await else { return };
    let (client, connection) = tokio_postgres::connect(database.url(), NoTls).await.unwrap();
    // Without its connection task every PostgreSQL call fails as closed, so each
    // `InvalidArgument` below proves the check ran before the query.
    drop(connection);
    let admin = Admin::new(client);
    let invalid = |result: Result<(), Error>, message: &str| match result {
        Err(Error::InvalidArgument(actual)) => assert_eq!(actual, message),
        other => panic!("expected {message:?}, got {other:?}"),
    };

    let blank = |field: &str| {
        let mut audit = audit("r");
        match field {
            "actor" => audit.actor.clear(),
            "reason" => audit.reason.clear(),
            _ => audit.request_id.clear(),
        }
        audit
    };
    invalid(
        admin.pause_queue("q", &blank("actor")).await,
        "actor must contain between 1 and 200 characters",
    );
    invalid(
        admin.resume_queue("q", &blank("reason")).await,
        "reason must contain between 1 and 2000 characters",
    );
    invalid(
        admin.purge_queue("q", &blank("request_id")).await.map(drop),
        "request_id must contain between 1 and 512 UTF-8 bytes",
    );
    invalid(
        admin.redrive(Uuid::nil(), &blank("actor")).await.map(drop),
        "actor must contain between 1 and 200 characters",
    );
    let long = AdminAudit { request_id: "x".repeat(513), ..audit("r") };
    invalid(
        admin.set_worker_paused("w", true, &long).await.map(drop),
        "request_id must contain between 1 and 512 UTF-8 bytes",
    );
    invalid(
        admin
            .redrive_many(
                DeadLetterFilter::default(),
                &blank("reason"),
                BulkRedriveOptions::default(),
            )
            .await
            .map(drop),
        "reason must contain between 1 and 2000 characters",
    );
    let options = BulkRedriveOptions { limit: 1_001, ..BulkRedriveOptions::default() };
    invalid(
        admin.redrive_many(DeadLetterFilter::default(), &audit("r"), options).await.map(drop),
        "redrive_many limit must be an integer between 1 and 1000",
    );

    let tasks = |query: TaskListQuery| admin.list_tasks(query);
    invalid(
        tasks(TaskListQuery { limit: 0, ..TaskListQuery::default() }).await.map(drop),
        "list_tasks limit must be an integer between 1 and 1000",
    );
    let now = Utc::now();
    let reversed = TaskListQuery {
        created_after: Some(now),
        created_before: Some(now - Duration::seconds(1)),
        ..TaskListQuery::default()
    };
    invalid(tasks(reversed).await.map(drop), "created_after must be earlier than created_before");
    let repeated = TaskListQuery {
        states: vec![TaskState::Ready, TaskState::Ready],
        ..TaskListQuery::default()
    };
    invalid(tasks(repeated).await.map(drop), "states must be unique");
    let projection = |payload| TaskListQuery { payload, ..TaskListQuery::default() };
    let oversized =
        TaskPayloadProjection { max_bytes: 1_048_577, ..TaskPayloadProjection::default() };
    invalid(tasks(projection(oversized)).await.map(drop), "payload max_bytes is out of range");
    let many = TaskPayloadProjection {
        redact_keys: (0..51).map(|n| n.to_string()).collect(),
        ..TaskPayloadProjection::default()
    };
    invalid(
        tasks(projection(many)).await.map(drop),
        "payload redact_keys must contain at most 50 keys",
    );
    let duplicate = TaskPayloadProjection {
        redact_keys: vec!["a".into(), "a".into()],
        ..TaskPayloadProjection::default()
    };
    invalid(tasks(projection(duplicate)).await.map(drop), "payload redact_keys must be unique");
    let empty = TaskPayloadProjection {
        redact_keys: vec![String::new()],
        ..TaskPayloadProjection::default()
    };
    invalid(
        tasks(projection(empty)).await.map(drop),
        "payload redact_keys must contain strings of 1 to 200 characters",
    );

    invalid(
        admin
            .get_task_timeline(Uuid::nil(), TaskTimelineQuery { limit: 1_001, cursor: None })
            .await
            .map(drop),
        "get_task_timeline limit must be an integer between 1 and 1000",
    );
    invalid(
        admin
            .list_dead_letters(DeadLetterQuery { limit: 0, ..DeadLetterQuery::default() })
            .await
            .map(drop),
        "list_dead_letters limit must be an integer between 1 and 1000",
    );
    invalid(
        admin.list_signal_waits(ExternalWaitQuery { limit: 0, cursor: None }).await.map(drop),
        "external wait limit must be an integer between 1 and 1000",
    );
    invalid(
        admin.list_human_waits(ExternalWaitQuery { limit: 1_001, cursor: None }).await.map(drop),
        "external wait limit must be an integer between 1 and 1000",
    );
}

#[tokio::test]
async fn admin_control_rolls_back_with_the_callers_transaction() {
    let Some(database) = scratch_database("admin_transaction").await else { return };
    let mut client = database.connect().await;
    let observer = database.connect().await;

    let transaction = client.transaction().await.unwrap();
    let admin = Admin::new(transaction);
    admin.pause_queue("rust-admin", &audit("tx-1")).await.unwrap();
    admin.into_inner().rollback().await.unwrap();
    assert_eq!(queue_paused(&observer, "rust-admin").await, None);

    let transaction = client.transaction().await.unwrap();
    let admin = Admin::new(transaction);
    admin.pause_queue("rust-admin", &audit("tx-2")).await.unwrap();
    admin.into_inner().commit().await.unwrap();
    assert_eq!(queue_paused(&observer, "rust-admin").await, Some(true));
}
