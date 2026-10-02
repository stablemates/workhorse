mod support;

#[path = "../src/sql_catalogue_generated.rs"]
mod statements;

use chrono::{DateTime, Utc};
use diesel::connection::SimpleConnection;
use diesel::result::{DatabaseErrorKind, Error as DieselError};
use diesel::sql_types::{BigInt, Integer, Jsonb, Nullable, Text, Timestamptz, Uuid as SqlUuid};
use diesel::{Connection, PgConnection, QueryableByName};
use diesel_async::{AsyncConnection, AsyncPgConnection, SimpleAsyncConnection};
use serde_json::{json, Value};
use tokio_postgres::Client;
use uuid::Uuid;

#[derive(Debug, PartialEq, QueryableByName)]
struct Identity {
    #[diesel(sql_type = Integer)]
    backend: i32,
    #[diesel(sql_type = BigInt)]
    transaction: i64,
}

#[derive(Debug, QueryableByName)]
struct Outcome {
    #[diesel(sql_type = Integer)]
    ordinal: i32,
    #[diesel(sql_type = Nullable<SqlUuid>)]
    task_id: Option<Uuid>,
    #[diesel(sql_type = Text)]
    outcome: String,
    #[diesel(sql_type = Nullable<Text>)]
    reason: Option<String>,
}

#[derive(Debug, QueryableByName)]
struct StoredTask {
    #[diesel(sql_type = SqlUuid)]
    id: Uuid,
    #[diesel(sql_type = Jsonb)]
    payload: Value,
    #[diesel(sql_type = Timestamptz)]
    run_at: DateTime<Utc>,
    #[diesel(sql_type = Nullable<Text>)]
    note: Option<String>,
}

enum NativeConnection {
    Sync(PgConnection),
    Async(Box<AsyncPgConnection>),
}

impl NativeConnection {
    async fn open(url: &str, asynchronous: bool) -> Self {
        if asynchronous {
            Self::Async(Box::new(AsyncPgConnection::establish(url).await.unwrap()))
        } else {
            Self::Sync(PgConnection::establish(url).unwrap())
        }
    }

    async fn caller_sql(&mut self, sql: &str) {
        match self {
            Self::Sync(connection) => connection.batch_execute(sql).unwrap(),
            Self::Async(connection) => connection.batch_execute(sql).await.unwrap(),
        }
    }

    async fn identity(&mut self) -> Identity {
        let query =
            diesel::sql_query("SELECT pg_backend_pid() AS backend, txid_current() AS transaction");
        match self {
            Self::Sync(connection) => diesel::RunQueryDsl::get_result(query, connection).unwrap(),
            Self::Async(connection) => {
                diesel_async::RunQueryDsl::get_result(query, connection.as_mut()).await.unwrap()
            }
        }
    }

    async fn business_write(&mut self, id: Uuid, payload: &Value, note: Option<&str>) -> Identity {
        let query = diesel::sql_query(
            "INSERT INTO diesel_business(id, payload, note) VALUES ($1, $2, $3)
             RETURNING pg_backend_pid() AS backend, txid_current() AS transaction",
        )
        .bind::<SqlUuid, _>(id)
        .bind::<Jsonb, _>(payload)
        .bind::<Nullable<Text>, _>(note);
        match self {
            Self::Sync(connection) => diesel::RunQueryDsl::get_result(query, connection).unwrap(),
            Self::Async(connection) => {
                diesel_async::RunQueryDsl::get_result(query, connection.as_mut()).await.unwrap()
            }
        }
    }

    async fn batch(&mut self, requests: &Value) -> Vec<Outcome> {
        let query = diesel::sql_query(statements::ENQUEUE_MANY_V1).bind::<Jsonb, _>(requests);
        match self {
            Self::Sync(connection) => diesel::RunQueryDsl::load(query, connection).unwrap(),
            Self::Async(connection) => {
                diesel_async::RunQueryDsl::load(query, connection.as_mut()).await.unwrap()
            }
        }
    }

    async fn stored_task(&mut self, id: Uuid) -> StoredTask {
        let query = diesel::sql_query(
            "SELECT task.id, task.payload, runtime.run_at, business.note
             FROM workhorse.task task JOIN workhorse.task_runtime runtime ON runtime.task_id = task.id
             CROSS JOIN diesel_business business
             WHERE task.id = $1 AND business.payload = task.payload",
        )
        .bind::<SqlUuid, _>(id);
        match self {
            Self::Sync(connection) => diesel::RunQueryDsl::get_result(query, connection).unwrap(),
            Self::Async(connection) => {
                diesel_async::RunQueryDsl::get_result(query, connection.as_mut()).await.unwrap()
            }
        }
    }

    async fn failure(&mut self, case: &FailureCase) -> DieselError {
        let query = diesel::sql_query(&case.sql).bind::<Jsonb, _>(&case.bind);
        match self {
            Self::Sync(connection) => diesel::RunQueryDsl::execute(query, connection).unwrap_err(),
            Self::Async(connection) => {
                diesel_async::RunQueryDsl::execute(query, connection.as_mut()).await.unwrap_err()
            }
        }
    }
}

fn request(payload: Value) -> Value {
    json!({"queue": "diesel-proof", "type": "diesel.accepted", "payload": payload,
        "runAt": "2026-10-02T12:34:56.789Z"})
}

async fn setup(observer: &Client) {
    observer
        .batch_execute(
            "SET TIME ZONE 'UTC';
             CREATE TABLE diesel_business(id uuid PRIMARY KEY, payload jsonb NOT NULL, note text);
             CREATE FUNCTION diesel_opaque_failure(code text) RETURNS void LANGUAGE plpgsql AS $$
             BEGIN RAISE EXCEPTION USING ERRCODE = code, MESSAGE = 'opaque failure',
                 DETAIL = '{\"same\":true}'; END $$",
        )
        .await
        .unwrap();
}

async fn counts(observer: &Client) -> (i64, i64) {
    let row = observer
        .query_one(
            "SELECT (SELECT count(*) FROM diesel_business),
                    (SELECT count(*) FROM workhorse.task)",
            &[],
        )
        .await
        .unwrap();
    (row.get(0), row.get(1))
}

async fn transactions(asynchronous: bool, name: &str) {
    let Some(database) = support::scratch_database(name).await else { return };
    let observer = database.connect().await;
    setup(&observer).await;
    let mut native = NativeConnection::open(database.url(), asynchronous).await;
    let payload = json!({"order": "O'Reilly $1 \\ Unicode 🐎", "nested": [1, null, {"ok": true}]});
    let mut accepted = request(payload.clone());
    accepted["idempotency"] = json!({"key": "retained", "scope": name, "ttlMs": 60000});

    native.caller_sql("BEGIN").await;
    let identity = native.identity().await;
    assert_eq!(native.business_write(Uuid::new_v4(), &payload, None).await, identity);
    let outcomes = native.batch(&json!([accepted.clone(), accepted, request(json!("last"))])).await;
    assert_eq!(outcomes.iter().map(|row| row.ordinal).collect::<Vec<_>>(), [1, 2, 3]);
    assert_eq!(
        outcomes.iter().map(|row| row.outcome.as_str()).collect::<Vec<_>>(),
        ["accepted", "replayed", "accepted"]
    );
    assert_eq!(outcomes[0].task_id, outcomes[1].task_id);
    assert!(outcomes.iter().all(|row| row.reason.is_none()));
    assert_eq!(native.identity().await, identity);
    let id = outcomes[0].task_id.unwrap();
    let stored = native.stored_task(id).await;
    assert_eq!(stored.id, id);
    assert_eq!(stored.payload, payload);
    assert_eq!(stored.note, None);
    assert_eq!(
        stored.run_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "2026-10-02T12:34:56.789Z"
    );
    assert_eq!(counts(&observer).await, (0, 0));
    native.caller_sql("COMMIT").await;
    assert_eq!(counts(&observer).await, (1, 2));
    assert_eq!(native.identity().await.backend, identity.backend);

    native.caller_sql("BEGIN").await;
    let rollback_identity = native.identity().await;
    assert_ne!(rollback_identity.transaction, identity.transaction);
    assert_eq!(
        native.business_write(Uuid::new_v4(), &json!("rollback"), Some("borrowed")).await,
        rollback_identity
    );
    native.batch(&json!([request(json!("rollback"))])).await;
    assert_eq!(native.identity().await, rollback_identity);
    assert_eq!(counts(&observer).await, (1, 2));
    native.caller_sql("ROLLBACK").await;
    assert_eq!(counts(&observer).await, (1, 2));

    native.caller_sql("BEGIN").await;
    let outer_identity = native.identity().await;
    native.business_write(Uuid::new_v4(), &json!("outer"), Some("survives")).await;
    native.batch(&json!([request(json!("outer"))])).await;
    native.caller_sql("SAVEPOINT caller_inner").await;
    native.business_write(Uuid::new_v4(), &json!("inner"), None).await;
    native.batch(&json!([request(json!("inner"))])).await;
    assert_eq!(native.identity().await, outer_identity);
    native.caller_sql("ROLLBACK TO SAVEPOINT caller_inner; RELEASE SAVEPOINT caller_inner").await;
    assert_eq!(native.identity().await, outer_identity);
    assert_eq!(counts(&observer).await, (1, 2));
    native.caller_sql("COMMIT").await;
    assert_eq!(counts(&observer).await, (2, 3));

    native.caller_sql("BEGIN; SAVEPOINT caller_released").await;
    native.business_write(Uuid::new_v4(), &json!("released"), None).await;
    native.batch(&json!([request(json!("released"))])).await;
    native.caller_sql("RELEASE SAVEPOINT caller_released").await;
    assert_eq!(counts(&observer).await, (2, 3));
    native.caller_sql("ROLLBACK").await;
    assert_eq!(counts(&observer).await, (2, 3));

    native.caller_sql("BEGIN").await;
    let mut debounce = request(json!({"value": "first"}));
    debounce.as_object_mut().unwrap().remove("runAt");
    debounce["debounce"] = json!({"key": "debounce", "windowMs": 60000, "schedule": "reset"});
    let mut replacement = debounce.clone();
    replacement["payload"] = json!({"value": "replacement"});
    let mut throttle = request(json!({"value": "throttled"}));
    throttle["throttle"] = json!({"key": "throttle", "windowMs": 60000});
    let coalescing =
        native.batch(&json!([debounce, replacement, throttle.clone(), throttle])).await;
    assert_eq!(coalescing.iter().map(|row| row.ordinal).collect::<Vec<_>>(), [1, 2, 3, 4]);
    assert_eq!(
        coalescing.iter().map(|row| row.outcome.as_str()).collect::<Vec<_>>(),
        ["accepted", "replaced", "accepted", "coalesced"]
    );
    assert_eq!(coalescing[0].task_id, coalescing[1].task_id);
    assert_eq!(coalescing[2].task_id, coalescing[3].task_id);
    assert!(coalescing.iter().all(|row| row.reason.is_none()));
    assert_eq!(counts(&observer).await, (2, 3));
    native.caller_sql("ROLLBACK").await;

    observer
        .execute(
            statements::SYNC_CONTRACT_DEFINITIONS_V1,
            &[&json!([{"taskType": "diesel.accepted", "currentVersion": "current",
                "versions": {"current": {"payloadSchema": true, "resultSchema": true}}}])],
        )
        .await
        .unwrap();
    let mut outdated = request(json!({}));
    outdated["contractVersion"] = json!("old");
    let mismatch = native.batch(&json!([outdated])).await;
    assert_eq!(mismatch.len(), 1);
    assert_eq!(mismatch[0].ordinal, 0);
    assert_eq!(mismatch[0].task_id, None);
    assert_eq!(mismatch[0].outcome, "contract_mismatch");
    assert_eq!(
        serde_json::from_str::<Value>(mismatch[0].reason.as_ref().unwrap()).unwrap(),
        json!({"taskTypes": ["diesel.accepted"]})
    );
    assert_eq!(counts(&observer).await, (2, 3));
    drop(native);
}

struct FailureCase {
    name: &'static str,
    sql: String,
    bind: Value,
    code: &'static str,
    detail: Option<Value>,
    kind: DatabaseErrorKind,
}

fn batch_failure(
    name: &'static str,
    bind: Value,
    code: &'static str,
    detail: Option<Value>,
) -> FailureCase {
    FailureCase {
        name,
        sql: statements::ENQUEUE_MANY_V1.into(),
        bind,
        code,
        detail,
        kind: DatabaseErrorKind::Unknown,
    }
}

async fn failure_cases(observer: &Client) -> Vec<FailureCase> {
    let mut retained = request(json!({"value": "stored"}));
    retained["idempotency"] = json!({"key": "conflict", "scope": "diesel-errors", "ttlMs": 60000});
    observer.query(statements::ENQUEUE_MANY_V1, &[&json!([retained.clone()])]).await.unwrap();
    retained["payload"] = json!({"value": "rejected"});
    let root: Uuid = observer
        .query_one(statements::ENQUEUE_MANY_V1, &[&json!([request(json!("root"))])])
        .await
        .unwrap()
        .get("task_id");
    let dependents: Vec<_> = (0..101)
        .map(|index| {
            let mut dependent = request(json!({"dependent": index}));
            dependent["prerequisiteTaskId"] = json!(root);
            dependent
        })
        .collect();
    let graph_root: Uuid = observer
        .query_one(statements::ENQUEUE_MANY_V1, &[&json!([request(json!("graph root"))])])
        .await
        .unwrap()
        .get("task_id");
    let mut child = request(json!("child"));
    child["prerequisiteTaskId"] = json!(graph_root);
    let children = observer
        .query(statements::ENQUEUE_MANY_V1, &[&json!([child.clone(), child])])
        .await
        .unwrap();
    let children: Vec<Uuid> = children.iter().map(|row| row.get("task_id")).collect();
    let leaves: Vec<_> = (0..98)
        .map(|index| {
            let mut leaf = request(json!({"leaf": index}));
            leaf["prerequisiteTaskId"] = json!(children[index / 49]);
            leaf
        })
        .collect();
    let leaf_rows = observer.query(statements::ENQUEUE_MANY_V1, &[&json!(leaves)]).await.unwrap();
    let prerequisites: Vec<Uuid> = std::iter::once(graph_root)
        .chain(children.iter().copied())
        .chain(leaf_rows.iter().map(|row| row.get("task_id")))
        .collect();
    let mut transitive = request(json!("over transitive bound"));
    transitive["prerequisiteTaskId"] = json!(children[0]);
    observer
        .query(
            "SELECT workhorse.set_queue_tier_v1($1, 'fast', 'diesel-proof', 'feasibility')",
            &[&"diesel-fast"],
        )
        .await
        .unwrap();
    let mut fast = request(json!({}));
    fast["queue"] = json!("diesel-fast");
    fast["debounce"] = json!({"key": "fast", "windowMs": 1000});
    let mut invalid_uuid = request(json!({}));
    invalid_uuid["prerequisiteTaskId"] = json!("not-a-uuid");
    let business = Uuid::new_v4();
    observer
        .execute("INSERT INTO diesel_business(id, payload) VALUES ($1, '{}')", &[&business])
        .await
        .unwrap();
    vec![
        batch_failure("idempotency", json!([request(json!("atomic prefix")), retained]), "P1001",
            Some(json!({"ordinal": 2, "scope": "diesel-errors", "conflictingFields": ["payload"]}))),
        FailureCase { name: "cycle", sql: "INSERT INTO workhorse.task_dependency
            (dependent_task_id, prerequisite_task_id, on_success, on_failure, on_cancellation)
            SELECT ($1::jsonb->>'root')::uuid, ($1::jsonb->>'root')::uuid, 'release', 'fail', 'cancel'".into(),
            bind: json!({"root": root}), code: "P1003",
            detail: Some(json!({"dependentTaskId": root, "prerequisiteTaskId": root,
                "cycleTaskIds": [root, root], "truncated": false})), kind: DatabaseErrorKind::Unknown },
        batch_failure("dependency bound", json!(dependents), "P1005",
            Some(json!({"taskId": root, "limit": "dependents", "max": 100}))),
        FailureCase { name: "prerequisite bound", sql: "INSERT INTO workhorse.task_dependency
            (dependent_task_id, prerequisite_task_id, on_success, on_failure, on_cancellation)
            SELECT ($1::jsonb->>'dependent')::uuid, prerequisite::uuid, 'release', 'fail', 'cancel'
            FROM jsonb_array_elements_text($1::jsonb->'prerequisites') prerequisite".into(),
            bind: json!({"dependent": root, "prerequisites": prerequisites}), code: "P1005",
            detail: Some(json!({"taskId": root, "limit": "prerequisites", "max": 100})),
            kind: DatabaseErrorKind::Unknown },
        batch_failure("transitive bound", json!([transitive]), "P1005",
            Some(json!({"taskId": graph_root, "limit": "unresolved_dependents", "max": 100}))),
        FailureCase { name: "graph cycle", sql: "INSERT INTO workhorse.task_dependency
            (dependent_task_id, prerequisite_task_id, on_success, on_failure, on_cancellation)
            SELECT ($1::jsonb->>'root')::uuid, ($1::jsonb->>'child')::uuid, 'release', 'fail', 'cancel'".into(),
            bind: json!({"root": graph_root, "child": children[0]}), code: "P1003",
            detail: Some(json!({"truncated": false})), kind: DatabaseErrorKind::Unknown },
        batch_failure("fast tier", json!([fast]), "P1007",
            Some(json!({"queue": "diesel-fast", "feature": "debounce", "ordinal": 1}))),
        batch_failure("invalid batch", json!({}), "P0001", None),
        batch_failure("invalid UUID", json!([invalid_uuid]), "22P02", None),
        FailureCase { name: "missing relation", sql: "SELECT $1::jsonb FROM diesel_missing".into(),
            bind: json!({}), code: "42P01", detail: None, kind: DatabaseErrorKind::Unknown },
        FailureCase { name: "business unique violation", sql: "INSERT INTO diesel_business(id, payload)
            SELECT ($1::jsonb->>'id')::uuid, '{}'::jsonb".into(), bind: json!({"id": business}),
            code: "23505", detail: None, kind: DatabaseErrorKind::UniqueViolation },
    ]
}

fn public_information(error: &DieselError) -> (DatabaseErrorKind, Vec<Option<String>>) {
    let DieselError::DatabaseError(kind, information) = error else { panic!("{error:?}") };
    assert!(std::error::Error::source(error).is_none(), "no recoverable driver source");
    (
        *kind,
        vec![
            Some(information.message().into()),
            information.details().map(str::to_owned),
            information.hint().map(str::to_owned),
            information.table_name().map(str::to_owned),
            information.column_name().map(str::to_owned),
            information.constraint_name().map(str::to_owned),
            information.statement_position().map(|position| position.to_string()),
        ],
    )
}

async fn errors(asynchronous: bool, name: &str) {
    let Some(database) = support::scratch_database(name).await else { return };
    let observer = database.connect().await;
    setup(&observer).await;
    let cases = failure_cases(&observer).await;
    let before = counts(&observer).await;
    let mut native = NativeConnection::open(database.url(), asynchronous).await;
    for case in &cases {
        let control = observer.execute(&case.sql, &[&case.bind]).await.unwrap_err();
        let diagnostic = control.as_db_error().unwrap();
        assert_eq!(diagnostic.code().code(), case.code, "{}", case.name);
        if let Some(expected) = &case.detail {
            let actual: Value = serde_json::from_str(diagnostic.detail().unwrap()).unwrap();
            for (field, value) in expected.as_object().unwrap() {
                assert_eq!(&actual[field], value, "{} DETAIL {field}", case.name);
            }
        }
        native.caller_sql("BEGIN; SAVEPOINT caller_failure").await;
        let error = native.failure(case).await;
        let (kind, fields) = public_information(&error);
        assert_eq!(kind, case.kind, "{} loses SQLSTATE {}", case.name, case.code);
        assert_eq!(fields[1].as_deref(), diagnostic.detail(), "{} retains DETAIL", case.name);
        let aborted = FailureCase {
            name: "aborted transaction",
            sql: "SELECT $1::jsonb".into(),
            bind: json!({}),
            code: "25P02",
            detail: None,
            kind: DatabaseErrorKind::Unknown,
        };
        observer.batch_execute("BEGIN").await.unwrap();
        observer.execute(&case.sql, &[&case.bind]).await.unwrap_err();
        assert_eq!(
            observer
                .execute(&aborted.sql, &[&aborted.bind])
                .await
                .unwrap_err()
                .code()
                .unwrap()
                .code(),
            aborted.code
        );
        observer.batch_execute("ROLLBACK").await.unwrap();
        assert_eq!(
            public_information(&native.failure(&aborted).await).0,
            DatabaseErrorKind::Unknown
        );
        native
            .caller_sql("ROLLBACK TO SAVEPOINT caller_failure; RELEASE SAVEPOINT caller_failure")
            .await;
        native.identity().await;
        native.caller_sql("ROLLBACK").await;
        assert_eq!(counts(&observer).await, before, "{} remains atomic", case.name);
        eprintln!(
            "{name}: {} native SQLSTATE={} -> {kind:?}; DETAIL retained; caller recovered",
            case.name, case.code
        );
    }

    let opaque = |code| FailureCase {
        name: "indistinguishable diagnostics",
        sql: "SELECT diesel_opaque_failure($1::jsonb->>'code')".into(),
        bind: json!({"code": code}),
        code: "",
        detail: None,
        kind: DatabaseErrorKind::Unknown,
    };
    let first = public_information(&native.failure(&opaque("P1001")).await);
    let second = public_information(&native.failure(&opaque("P1007")).await);
    assert_eq!(first, second, "distinct SQLSTATEs have identical entire public diagnostics");
    assert_eq!(first.0, DatabaseErrorKind::Unknown);

    let timeout = FailureCase {
        name: "statement cancellation",
        sql: "SELECT pg_sleep(($1::jsonb->>'seconds')::double precision)".into(),
        bind: json!({"seconds": 1}),
        code: "57014",
        detail: None,
        kind: DatabaseErrorKind::Unknown,
    };
    observer.batch_execute("SET statement_timeout = '20ms'").await.unwrap();
    assert_eq!(
        observer.execute(&timeout.sql, &[&timeout.bind]).await.unwrap_err().code().unwrap().code(),
        "57014"
    );
    observer.batch_execute("RESET statement_timeout").await.unwrap();
    native.caller_sql("BEGIN; SET LOCAL statement_timeout = '20ms'").await;
    assert_eq!(public_information(&native.failure(&timeout).await).0, DatabaseErrorKind::Unknown);
    native.caller_sql("ROLLBACK").await;
    native.identity().await;
    assert_eq!(counts(&observer).await, before);
    drop(native);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sync_caller_owns_connection_transaction_and_savepoints() {
    transactions(false, "diesel_sync_transactions").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn async_caller_owns_connection_transaction_and_savepoints() {
    transactions(true, "diesel_async_transactions").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sync_native_errors_retain_detail_but_lose_sqlstate() {
    errors(false, "diesel_sync_errors").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn async_native_errors_retain_detail_but_lose_sqlstate() {
    errors(true, "diesel_async_errors").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sync_native_transaction_callbacks_use_caller_savepoints() {
    let Some(database) = support::scratch_database("diesel_sync_callbacks").await else { return };
    let observer = database.connect().await;
    setup(&observer).await;
    let mut connection = PgConnection::establish(database.url()).unwrap();
    connection
        .transaction::<(), DieselError, _>(|connection| {
            let identity: Identity = diesel::RunQueryDsl::get_result(
                diesel::sql_query(
                    "SELECT pg_backend_pid() AS backend, txid_current() AS transaction",
                ),
                connection,
            )?;
            let outer: Vec<Outcome> = diesel::RunQueryDsl::load(
                diesel::sql_query(statements::ENQUEUE_MANY_V1)
                    .bind::<Jsonb, _>(json!([request(json!("callback outer"))])),
                connection,
            )?;
            assert_eq!(outer[0].outcome, "accepted");
            let inner = connection.transaction::<(), DieselError, _>(|connection| {
                let _rows: Vec<Outcome> = diesel::RunQueryDsl::load(
                    diesel::sql_query(statements::ENQUEUE_MANY_V1)
                        .bind::<Jsonb, _>(json!([request(json!("callback inner"))])),
                    connection,
                )?;
                Err(DieselError::RollbackTransaction)
            });
            assert!(matches!(inner, Err(DieselError::RollbackTransaction)));
            let after: Identity = diesel::RunQueryDsl::get_result(
                diesel::sql_query(
                    "SELECT pg_backend_pid() AS backend, txid_current() AS transaction",
                ),
                connection,
            )?;
            assert_eq!(after, identity);
            Ok(())
        })
        .unwrap();
    assert_eq!(counts(&observer).await, (0, 1));
    let rollback = connection.transaction::<(), DieselError, _>(|connection| {
        connection.transaction::<(), DieselError, _>(|connection| {
            let _rows: Vec<Outcome> = diesel::RunQueryDsl::load(
                diesel::sql_query(statements::ENQUEUE_MANY_V1)
                    .bind::<Jsonb, _>(json!([request(json!("callback released"))])),
                connection,
            )?;
            Ok(())
        })?;
        Err(DieselError::RollbackTransaction)
    });
    assert!(matches!(rollback, Err(DieselError::RollbackTransaction)));
    assert_eq!(counts(&observer).await, (0, 1));
    drop(connection);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn async_native_transaction_callbacks_use_caller_savepoints() {
    let Some(database) = support::scratch_database("diesel_async_callbacks").await else { return };
    let observer = database.connect().await;
    setup(&observer).await;
    let mut connection = AsyncPgConnection::establish(database.url()).await.unwrap();
    connection
        .transaction::<(), DieselError, _>(async |connection| {
            let identity: Identity = diesel_async::RunQueryDsl::get_result(
                diesel::sql_query(
                    "SELECT pg_backend_pid() AS backend, txid_current() AS transaction",
                ),
                connection,
            )
            .await?;
            let outer: Vec<Outcome> = diesel_async::RunQueryDsl::load(
                diesel::sql_query(statements::ENQUEUE_MANY_V1)
                    .bind::<Jsonb, _>(json!([request(json!("callback outer"))])),
                connection,
            )
            .await?;
            assert_eq!(outer[0].outcome, "accepted");
            let inner = connection
                .transaction::<(), DieselError, _>(async |connection| {
                    let _rows: Vec<Outcome> = diesel_async::RunQueryDsl::load(
                        diesel::sql_query(statements::ENQUEUE_MANY_V1)
                            .bind::<Jsonb, _>(json!([request(json!("callback inner"))])),
                        connection,
                    )
                    .await?;
                    Err(DieselError::RollbackTransaction)
                })
                .await;
            assert!(matches!(inner, Err(DieselError::RollbackTransaction)));
            let after: Identity = diesel_async::RunQueryDsl::get_result(
                diesel::sql_query(
                    "SELECT pg_backend_pid() AS backend, txid_current() AS transaction",
                ),
                connection,
            )
            .await?;
            assert_eq!(after, identity);
            assert_eq!(counts(&observer).await, (0, 0));
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(counts(&observer).await, (0, 1));
    let rollback = connection
        .transaction::<(), DieselError, _>(async |connection| {
            connection
                .transaction::<(), DieselError, _>(async |connection| {
                    let _rows: Vec<Outcome> = diesel_async::RunQueryDsl::load(
                        diesel::sql_query(statements::ENQUEUE_MANY_V1)
                            .bind::<Jsonb, _>(json!([request(json!("callback released"))])),
                        connection,
                    )
                    .await?;
                    Ok(())
                })
                .await?;
            assert_eq!(counts(&observer).await, (0, 1));
            Err(DieselError::RollbackTransaction)
        })
        .await;
    assert!(matches!(rollback, Err(DieselError::RollbackTransaction)));
    assert_eq!(counts(&observer).await, (0, 1));
    drop(connection);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn async_native_cancel_token_leaves_recovery_with_caller() {
    let Some(database) = support::scratch_database("diesel_async_cancel").await else { return };
    let observer = database.connect().await;
    let mut connection = AsyncPgConnection::establish(database.url()).await.unwrap();
    connection.batch_execute("BEGIN").await.unwrap();
    let identity: Identity = diesel_async::RunQueryDsl::get_result(
        diesel::sql_query("SELECT pg_backend_pid() AS backend, txid_current() AS transaction"),
        &mut connection,
    )
    .await
    .unwrap();
    let cancel = connection.cancel_token();
    let pending = diesel_async::RunQueryDsl::execute(
        diesel::sql_query("SELECT pg_sleep(10)"),
        &mut connection,
    );
    fn require_send<T: Send>(_: &T) {}
    require_send(&pending);
    let cancel_when_running = async {
        for _attempt in 0..100 {
            let sleeping: bool = observer
                .query_one(
                    "SELECT EXISTS(SELECT 1 FROM pg_stat_activity
                 WHERE pid = $1 AND wait_event = 'PgSleep')",
                    &[&identity.backend],
                )
                .await
                .unwrap()
                .get(0);
            if sleeping {
                cancel.cancel_query(tokio_postgres::NoTls).await.unwrap();
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("native query never reached PostgreSQL's sleep");
    };
    let (cancelled, ()) = tokio::join!(pending, cancel_when_running);
    assert_eq!(public_information(&cancelled.unwrap_err()).0, DatabaseErrorKind::Unknown);
    let aborted =
        diesel_async::RunQueryDsl::execute(diesel::sql_query("SELECT 1"), &mut connection)
            .await
            .unwrap_err();
    assert_eq!(public_information(&aborted).0, DatabaseErrorKind::Unknown);
    connection.batch_execute("ROLLBACK").await.unwrap();
    let recovered: Identity = diesel_async::RunQueryDsl::get_result(
        diesel::sql_query("SELECT pg_backend_pid() AS backend, txid_current() AS transaction"),
        &mut connection,
    )
    .await
    .unwrap();
    assert_eq!(recovered.backend, identity.backend);
    assert_ne!(recovered.transaction, identity.transaction);
    drop(connection);
}
