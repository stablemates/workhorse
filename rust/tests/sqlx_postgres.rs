mod support;

use std::collections::BTreeMap;
use std::error::Error as StdError;
use std::future::Future;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx::{Connection, PgConnection, Postgres, Transaction};
use support::{scratch_database, ScratchDatabase};
use uuid::Uuid;
use workhorse::compatibility::CompatibilityCode;
use workhorse::contracts::{TaskContractVersion, TaskTypeContracts};
use workhorse::{
    EnqueueClient, EnqueueOptions, EnqueueOutcome, EnqueueRequest, Error, Idempotency, Queue,
};

fn assert_send<T: Future + Send>(future: T) -> T {
    future
}

async fn connection(database: &ScratchDatabase) -> PgConnection {
    PgConnection::connect(database.url()).await.unwrap()
}

async fn counts(observer: &mut PgConnection) -> (i64, i64) {
    sqlx::query_as(
        "SELECT (SELECT count(*) FROM public.business), \
                    (SELECT count(*) FROM workhorse.task)",
    )
    .fetch_one(observer)
    .await
    .unwrap()
}

async fn business(transaction: &mut Transaction<'_, Postgres>, id: i32) -> (i32, i64) {
    sqlx::query_as(
        "INSERT INTO public.business (id, pid, transaction_id) \
         VALUES ($1, pg_backend_pid(), txid_current()) RETURNING pid, transaction_id",
    )
    .bind(id)
    .fetch_one(&mut **transaction)
    .await
    .unwrap()
}

async fn identity_fixture(database: &ScratchDatabase) {
    sqlx::raw_sql(
        "CREATE TABLE public.business (id integer PRIMARY KEY, pid integer, transaction_id bigint); \
         CREATE TABLE public.enqueue_identity (task_id uuid, pid integer, transaction_id bigint); \
         CREATE FUNCTION public.record_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$ \
         BEGIN INSERT INTO public.enqueue_identity VALUES (NEW.id, pg_backend_pid(), txid_current()); \
         RETURN NEW; END $$; \
         CREATE TRIGGER record_enqueue BEFORE INSERT ON workhorse.task \
         FOR EACH ROW EXECUTE FUNCTION public.record_enqueue()",
    )
    .execute(&mut connection(database).await)
    .await
    .unwrap();
}

#[tokio::test]
async fn exact_transaction_identity_invisibility_commit_and_rollback() {
    let Some(database) = scratch_database("sqlx_identity").await else { return };
    identity_fixture(&database).await;
    let mut caller = connection(&database).await;
    let mut observer = connection(&database).await;
    let client = EnqueueClient::new("sqlx");
    let mut transaction = caller.begin().await.unwrap();
    let expected = business(&mut transaction, 1).await;
    let accepted = assert_send(client.enqueue(
        &mut transaction,
        "task",
        &json!({"business": 1}),
        EnqueueOptions::default(),
    ))
    .await
    .unwrap();
    let actual: (i32, i64) = sqlx::query_as(
        "SELECT pid, transaction_id FROM public.enqueue_identity WHERE task_id = $1",
    )
    .bind(accepted.task_id)
    .fetch_one(&mut *transaction)
    .await
    .unwrap();
    assert_eq!(expected, actual);
    let observer_pid: i32 =
        sqlx::query_scalar("SELECT pg_backend_pid()").fetch_one(&mut observer).await.unwrap();
    assert_ne!(observer_pid, expected.0);
    assert_eq!(counts(&mut observer).await, (0, 0));
    transaction.commit().await.unwrap();
    assert_eq!(counts(&mut observer).await, (1, 1));
    let mut transaction = caller.begin().await.unwrap();
    business(&mut transaction, 2).await;
    let rejected = client
        .enqueue(&mut transaction, "task", &json!({"business": 2}), EnqueueOptions::default())
        .await
        .unwrap();
    assert_eq!(counts(&mut observer).await, (1, 1));
    transaction.rollback().await.unwrap();
    assert_eq!(counts(&mut observer).await, (1, 1));
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM workhorse.task WHERE id=$1)")
            .bind(rejected.task_id)
            .fetch_one(&mut observer)
            .await
            .unwrap();
    assert!(!exists);
}

#[tokio::test]
async fn nested_sqlx_savepoint_rollback_and_release_preserve_outer_ownership() {
    let Some(database) = scratch_database("sqlx_savepoints").await else { return };
    identity_fixture(&database).await;
    let mut caller = connection(&database).await;
    let mut observer = connection(&database).await;
    let client = EnqueueClient::new("savepoints");
    let mut outer = caller.begin().await.unwrap();
    let expected = business(&mut outer, 1).await;
    client.enqueue(&mut outer, "outer", &json!({}), EnqueueOptions::default()).await.unwrap();
    let mut inner = outer.begin().await.unwrap();
    assert_eq!(business(&mut inner, 2).await, expected);
    client.enqueue(&mut inner, "inner", &json!({}), EnqueueOptions::default()).await.unwrap();
    inner.rollback().await.unwrap();
    assert_eq!(counts(&mut observer).await, (0, 0));
    outer.commit().await.unwrap();
    assert_eq!(counts(&mut observer).await, (1, 1));
    let mut outer = caller.begin().await.unwrap();
    let mut inner = outer.begin().await.unwrap();
    business(&mut inner, 3).await;
    client.enqueue(&mut inner, "released", &json!({}), EnqueueOptions::default()).await.unwrap();
    inner.commit().await.unwrap();
    assert_eq!(counts(&mut observer).await, (1, 1));
    outer.rollback().await.unwrap();
    assert_eq!(counts(&mut observer).await, (1, 1));
}

#[tokio::test]
async fn borrowed_pool_transaction_uses_its_only_connection_without_fallback() {
    let Some(database) = scratch_database("sqlx_pool_borrow").await else { return };
    identity_fixture(&database).await;
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(1)
        .connect(database.url())
        .await
        .unwrap();
    let mut transaction = pool.begin().await.unwrap();
    let identity = business(&mut transaction, 1).await;
    let client = EnqueueClient::new("pool");
    let payload = json!({});
    let result = tokio::time::timeout(
        Duration::from_secs(10),
        assert_send(client.enqueue(&mut transaction, "task", &payload, EnqueueOptions::default())),
    )
    .await
    .unwrap()
    .unwrap();
    let actual: (i32, i64) =
        sqlx::query_as("SELECT pid, transaction_id FROM public.enqueue_identity WHERE task_id=$1")
            .bind(result.task_id)
            .fetch_one(&mut *transaction)
            .await
            .unwrap();
    assert_eq!(actual, identity);
    transaction.rollback().await.unwrap();
    pool.close().await;
}

#[tokio::test]
async fn native_jsonb_uuid_nulls_timestamps_and_ordered_batch() {
    let Some(database) = scratch_database("sqlx_types").await else { return };
    let mut caller = connection(&database).await;
    let mut transaction = caller.begin().await.unwrap();
    let client = EnqueueClient::new("types");
    let payload = json!({"unicode": "é雪", "nested": [null, true, {"number": 2.5}]});
    let run_at: DateTime<Utc> = "2030-01-02T03:04:05.123Z".parse().unwrap();
    let deadline: DateTime<Utc> = "2030-01-03T03:04:05.456Z".parse().unwrap();
    let options = EnqueueOptions {
        run_at: Some(run_at),
        deadline: Some(deadline),
        priority: 37,
        idempotency: Some(Idempotency::new("same")),
        ..Default::default()
    };
    let results = assert_send(client.enqueue_many(
        &mut transaction,
        vec![
            EnqueueRequest::new("typed", payload.clone()).with_options(options.clone()),
            EnqueueRequest::new("other", json!({"index": 1})),
            EnqueueRequest::new("typed", payload.clone()).with_options(options),
        ],
    ))
    .await
    .unwrap();
    assert_eq!(results.len(), 3);
    assert_eq!(results[0].outcome, EnqueueOutcome::Accepted);
    assert_eq!(results[1].outcome, EnqueueOutcome::Accepted);
    assert_eq!(results[2].outcome, EnqueueOutcome::Replayed);
    assert_eq!(results[0].task_id, results[2].task_id);
    assert_ne!(results[0].task_id, results[1].task_id);
    let stored: (Value, String, String, Option<String>, Option<String>, i32) = sqlx::query_as(
        "SELECT task.payload, to_char(runtime.run_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \
         to_char(runtime.deadline_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), \
         task.contract_version, task.budget_name, task.priority \
         FROM workhorse.task task JOIN workhorse.task_runtime runtime ON runtime.task_id=task.id WHERE task.id=$1",
    ).bind(results[0].task_id).fetch_one(&mut *transaction).await.unwrap();
    assert_eq!(
        stored,
        (
            payload,
            run_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            deadline.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            None,
            None,
            37
        )
    );
    transaction.commit().await.unwrap();
}

fn definitions(version: &str) -> BTreeMap<String, TaskTypeContracts> {
    BTreeMap::from([(
        "contracted".into(),
        TaskTypeContracts {
            current_version: version.into(),
            versions: BTreeMap::from([(
                version.into(),
                TaskContractVersion {
                    payload_schema: json!({"type":"object", "required":["id"]}),
                    max_payload_bytes: 4096,
                    max_result_bytes: 2048,
                    sensitive_payload_keys: vec!["secret".into()],
                    sensitive_result_keys: vec!["token".into()],
                    ..Default::default()
                },
            )]),
        },
    )])
}

#[tokio::test]
async fn contracts_sync_validate_refresh_and_rollback_without_stale_handles() {
    let Some(database) = scratch_database("sqlx_contracts").await else { return };
    let mut caller = connection(&database).await;
    let observer = database.connect().await;
    let client = EnqueueClient::new("contracts");
    let mut transaction = caller.begin().await.unwrap();
    assert_send(client.sync_contracts(&mut transaction, &definitions("v1"))).await.unwrap();
    assert!(matches!(client.enqueue(&mut transaction, "contracted", &json!({}),
        EnqueueOptions::default()).await, Err(Error::ContractValidation { version, .. }) if version=="v1"));
    let task = client
        .enqueue(
            &mut transaction,
            "contracted",
            &json!({"id": 1, "secret":"hidden"}),
            EnqueueOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(
        observer
            .query_one("SELECT count(*) FROM workhorse.contract_policy", &[])
            .await
            .unwrap()
            .get::<_, i64>(0),
        0
    );
    assert_eq!(
        observer
            .query_one("SELECT count(*) FROM workhorse.task", &[])
            .await
            .unwrap()
            .get::<_, i64>(0),
        0
    );
    transaction.commit().await.unwrap();
    let row = observer
        .query_one(
            "SELECT contract_version, payload_max_bytes, result_max_bytes, \
                payload_redact_keys, result_redact_keys FROM workhorse.task WHERE id=$1",
            &[&task.task_id],
        )
        .await
        .unwrap();
    assert_eq!(row.get::<_, String>(0), "v1");
    assert_eq!(row.get::<_, i32>(1), 4096);
    assert_eq!(row.get::<_, i32>(2), 2048);
    assert_eq!(row.get::<_, Vec<String>>(3), ["secret"]);
    assert_eq!(row.get::<_, Vec<String>>(4), ["token"]);
    Queue::new(&observer, "contracts").sync_contracts(&definitions("v2")).await.unwrap();
    let mut transaction = caller.begin().await.unwrap();
    let refreshed = client
        .enqueue(&mut transaction, "contracted", &json!({"id":2}), EnqueueOptions::default())
        .await
        .unwrap();
    transaction.commit().await.unwrap();
    assert_eq!(
        observer
            .query_one(
                "SELECT contract_version FROM workhorse.task WHERE id=$1",
                &[&refreshed.task_id]
            )
            .await
            .unwrap()
            .get::<_, String>(0),
        "v2"
    );
    let mut transaction = caller.begin().await.unwrap();
    client.sync_contracts(&mut transaction, &definitions("rolled-back")).await.unwrap();
    client
        .enqueue(&mut transaction, "contracted", &json!({"id":3}), EnqueueOptions::default())
        .await
        .unwrap();
    transaction.rollback().await.unwrap();
    let fresh = EnqueueClient::new("contracts");
    let mut transaction = caller.begin().await.unwrap();
    let recovered = fresh
        .enqueue(&mut transaction, "contracted", &json!({"id":4}), EnqueueOptions::default())
        .await
        .unwrap();
    transaction.commit().await.unwrap();
    assert_eq!(
        observer
            .query_one(
                "SELECT contract_version FROM workhorse.task WHERE id=$1",
                &[&recovered.task_id]
            )
            .await
            .unwrap()
            .get::<_, String>(0),
        "v2"
    );
    assert_eq!(
        observer
            .query_one("SELECT count(*) FROM workhorse.task", &[])
            .await
            .unwrap()
            .get::<_, i64>(0),
        3
    );
}

#[tokio::test]
async fn native_idempotency_conflict_matches_existing_queue_and_aborts_until_rollback() {
    let Some(database) = scratch_database("sqlx_error_parity").await else { return };
    let observer = database.connect().await;
    let queue = Queue::new(&observer, "errors");
    let options =
        EnqueueOptions { idempotency: Some(Idempotency::new("same")), ..Default::default() };
    queue.enqueue("task", &json!({"id":1}), options.clone()).await.unwrap();
    let mut caller = connection(&database).await;
    let mut transaction = caller.begin().await.unwrap();
    let error = EnqueueClient::new("errors")
        .enqueue(&mut transaction, "task", &json!({"id":2}), options.clone())
        .await
        .unwrap_err();
    let legacy = queue.enqueue("task", &json!({"id":2}), options).await.unwrap_err();
    match (error, legacy) {
        (
            Error::EnqueueIdempotencyConflict { details: native },
            Error::EnqueueIdempotencyConflict { details: legacy },
        ) => assert_eq!(native, legacy),
        other => panic!("error parity failed: {other:?}"),
    }
    let aborted = sqlx::query("SELECT 1").execute(&mut *transaction).await.unwrap_err();
    assert_eq!(aborted.as_database_error().unwrap().code().as_deref(), Some("25P02"));
    transaction.rollback().await.unwrap();
    sqlx::query("SELECT 1").execute(&mut caller).await.unwrap();
}

#[tokio::test]
async fn native_sqlstate_detail_and_original_source_are_preserved() {
    let Some(database) = scratch_database("sqlx_diagnostics").await else { return };
    let mut caller = connection(&database).await;
    sqlx::raw_sql("CREATE FUNCTION public.refuse_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$ \
        BEGIN RAISE EXCEPTION USING ERRCODE=current_setting('test.code'), \
        MESSAGE='not parsed', DETAIL=current_setting('test.detail'); END $$; \
        CREATE TRIGGER refuse_enqueue BEFORE INSERT ON workhorse.task FOR EACH ROW EXECUTE FUNCTION public.refuse_enqueue()")
        .execute(&mut caller).await.unwrap();
    let observer = database.connect().await;
    let queue = Queue::new(&observer, "errors");
    for (code, detail) in [
        ("P1001", r#"{"ordinal":4,"conflictingFields":["payload"]}"#),
        ("P1003", r#"{"cycleTaskIds":["first","second"]}"#),
        ("P1005", r#"{"limit":"dependents","max":100}"#),
        ("P1007", r#"{"queue":"fast","feature":"dependencies","ordinal":2}"#),
        ("23514", "native diagnostic"),
    ] {
        let mut transaction = caller.begin().await.unwrap();
        sqlx::query(
            "SELECT set_config('test.code', $1, true), set_config('test.detail', $2, true)",
        )
        .bind(code)
        .bind(detail)
        .execute(&mut *transaction)
        .await
        .unwrap();
        let native = EnqueueClient::new("errors")
            .enqueue(&mut transaction, "task", &json!({}), EnqueueOptions::default())
            .await
            .unwrap_err();
        observer
            .query_one(
                "SELECT set_config('test.code', $1, false), set_config('test.detail', $2, false)",
                &[&code, &detail],
            )
            .await
            .unwrap();
        let legacy =
            queue.enqueue("task", &json!({}), EnqueueOptions::default()).await.unwrap_err();
        if code == "23514" {
            assert_eq!(native.sqlstate(), Some(code));
            assert!(native.source().unwrap().downcast_ref::<sqlx::Error>().is_some());
            assert!(
                matches!(native, Error::Database {detail: Some(ref actual), ..} if actual==detail)
            );
            assert_eq!(legacy.sqlstate(), Some(code));
        } else {
            assert_eq!(format!("{native:?}"), format!("{legacy:?}"));
        }
        transaction.rollback().await.unwrap();
    }
}

async fn blocking_fixture(database: &ScratchDatabase) {
    sqlx::raw_sql("CREATE FUNCTION public.block_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$ \
        BEGIN PERFORM pg_advisory_xact_lock(1124); RETURN NEW; END $$; \
        CREATE TRIGGER block_enqueue BEFORE INSERT ON workhorse.task FOR EACH ROW EXECUTE FUNCTION public.block_enqueue()")
        .execute(&mut connection(database).await).await.unwrap();
}

async fn wait_for_lock(observer: &mut PgConnection, pid: i32) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let waiting: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity \
                WHERE pid=$1 AND wait_event='advisory' AND state='active')",
            )
            .bind(pid)
            .fetch_one(&mut *observer)
            .await
            .unwrap();
            if waiting {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn server_cancellation_aborts_savepoint_and_caller_recovers() {
    let Some(database) = scratch_database("sqlx_cancel").await else { return };
    blocking_fixture(&database).await;
    let mut caller = connection(&database).await;
    let mut observer = connection(&database).await;
    sqlx::query("SELECT pg_advisory_lock(1124)").execute(&mut observer).await.unwrap();
    let mut outer = caller.begin().await.unwrap();
    let pid: i32 =
        sqlx::query_scalar("SELECT pg_backend_pid()").fetch_one(&mut *outer).await.unwrap();
    let mut inner = outer.begin().await.unwrap();
    let client = EnqueueClient::new("cancel");
    let cancel = async {
        wait_for_lock(&mut observer, pid).await;
        let cancelled: bool = sqlx::query_scalar("SELECT pg_cancel_backend($1)")
            .bind(pid)
            .fetch_one(&mut observer)
            .await
            .unwrap();
        assert!(cancelled);
    };
    let payload = json!({});
    let (outcome, ()) = tokio::join!(
        assert_send(client.enqueue(&mut inner, "cancelled", &payload, EnqueueOptions::default())),
        cancel
    );
    let error = outcome.unwrap_err();
    assert_eq!(error.sqlstate(), Some("57014"));
    assert!(error.source().unwrap().downcast_ref::<sqlx::Error>().is_some());
    let aborted = sqlx::query("SELECT 1").execute(&mut *inner).await.unwrap_err();
    assert_eq!(aborted.as_database_error().unwrap().code().as_deref(), Some("25P02"));
    inner.rollback().await.unwrap();
    sqlx::query("SELECT pg_advisory_unlock(1124)").execute(&mut observer).await.unwrap();
    let recovered = client
        .enqueue(&mut outer, "recovered", &json!({}), EnqueueOptions::default())
        .await
        .unwrap();
    outer.commit().await.unwrap();
    let tasks: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM workhorse.task").fetch_all(&mut observer).await.unwrap();
    assert_eq!(tasks, [recovered.task_id]);
}

#[tokio::test]
async fn dropped_send_future_releases_borrow_but_does_not_cancel_server_query() {
    let Some(database) = scratch_database("sqlx_drop").await else { return };
    blocking_fixture(&database).await;
    let mut caller = connection(&database).await;
    let mut observer = connection(&database).await;
    sqlx::query("SELECT pg_advisory_lock(1124)").execute(&mut observer).await.unwrap();
    let mut transaction = caller.begin().await.unwrap();
    let pid: i32 =
        sqlx::query_scalar("SELECT pg_backend_pid()").fetch_one(&mut *transaction).await.unwrap();
    let client = EnqueueClient::new("drop");
    let payload = json!({});
    {
        let pending = assert_send(client.enqueue(
            &mut transaction,
            "uncertain",
            &payload,
            EnqueueOptions::default(),
        ));
        tokio::pin!(pending);
        tokio::select! {
            outcome = &mut pending => panic!("query must block: {outcome:?}"),
            () = wait_for_lock(&mut observer, pid) => {},
        }
    }
    sqlx::query("SELECT pg_advisory_unlock(1124)").execute(&mut observer).await.unwrap();
    drop_scope_recovery(transaction, observer).await;
}

#[tokio::test]
async fn native_decoder_rejects_wrong_types_null_task_ids_and_stale_outcomes() {
    let Some(database) = scratch_database("sqlx_result_shapes").await else { return };
    for (columns, values, typed_error) in [
        (
            "ordinal text, task_id uuid, outcome text, reason text",
            "'1'::text, gen_random_uuid(), 'accepted'::text, NULL::text",
            true,
        ),
        (
            "ordinal integer, task_id text, outcome text, reason text",
            "1, gen_random_uuid()::text, 'accepted'::text, NULL::text",
            true,
        ),
        (
            "ordinal integer, task_id uuid, outcome text, reason text",
            "1, NULL::uuid, 'accepted'::text, NULL::text",
            false,
        ),
        (
            "ordinal integer, task_id uuid, outcome text, reason text",
            "1, gen_random_uuid(), 'stale'::text, NULL::text",
            false,
        ),
    ] {
        let mut caller = connection(&database).await;
        let mut transaction = caller.begin().await.unwrap();
        sqlx::query("ALTER FUNCTION workhorse.enqueue_many_v1(jsonb) RENAME TO original_enqueue")
            .execute(&mut *transaction)
            .await
            .unwrap();
        sqlx::raw_sql(&format!(
            "CREATE FUNCTION workhorse.enqueue_many_v1(jsonb) RETURNS TABLE ({columns}) \
            LANGUAGE sql AS $$ SELECT {values} $$"
        ))
        .execute(&mut *transaction)
        .await
        .unwrap();
        let error = EnqueueClient::new("shapes")
            .enqueue(&mut transaction, "task", &json!({}), EnqueueOptions::default())
            .await
            .unwrap_err();
        if typed_error {
            assert!(matches!(error, Error::Database { .. }));
            assert!(error.source().unwrap().downcast_ref::<sqlx::Error>().is_some());
        } else {
            assert!(matches!(error, Error::InvalidArgument(_)), "{error:?}");
        }
        transaction.rollback().await.unwrap();
    }
}

async fn drop_scope_recovery(
    mut transaction: Transaction<'_, Postgres>,
    mut observer: PgConnection,
) {
    let tasks: i64 = tokio::time::timeout(
        Duration::from_secs(10),
        sqlx::query_scalar("SELECT count(*) FROM workhorse.task").fetch_one(&mut *transaction),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(tasks, 1, "dropping the future is not server-side cancellation");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM workhorse.task")
            .fetch_one(&mut observer)
            .await
            .unwrap(),
        0
    );
    transaction.rollback().await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM workhorse.task")
            .fetch_one(&mut observer)
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn missing_schema_refusal_and_invalid_options_use_shared_owner() {
    let Some(database) = scratch_database("sqlx_compatibility").await else { return };
    let mut caller = connection(&database).await;
    let mut transaction = caller.begin().await.unwrap();
    sqlx::query("DROP SCHEMA workhorse CASCADE").execute(&mut *transaction).await.unwrap();
    let client = EnqueueClient::new("missing");
    for _attempt in 0..2 {
        assert!(matches!(
            client.assert_compatible(&mut transaction).await,
            Err(Error::Compatibility { code: CompatibilityCode::SchemaNotInstalled })
        ));
    }
    transaction.rollback().await.unwrap();
    let mut transaction = caller.begin().await.unwrap();
    let client = EnqueueClient::new("invalid");
    let options = EnqueueOptions { priority: 101, ..Default::default() };
    assert!(matches!(
        client.enqueue(&mut transaction, "task", &json!({}), options).await,
        Err(Error::InvalidArgument(_))
    ));
    assert!(client.enqueue_many(&mut transaction, vec![]).await.unwrap().is_empty());
    assert!(matches!(
        client
            .enqueue_many(
                &mut transaction,
                vec![EnqueueRequest::new("task", json!({})); workhorse::MAX_ENQUEUE_BATCH_SIZE + 1]
            )
            .await,
        Err(Error::InvalidArgument(_))
    ));
    let tasks: i64 = sqlx::query_scalar("SELECT count(*) FROM workhorse.task")
        .fetch_one(&mut *transaction)
        .await
        .unwrap();
    assert_eq!(tasks, 0);
    transaction.rollback().await.unwrap();
}
