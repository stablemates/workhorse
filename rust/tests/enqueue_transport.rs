//! The public enqueue seam, exercised by mutable, non-Sync transports outside the crate.
mod support;

use std::cell::Cell;
use std::collections::{BTreeMap, VecDeque};
use std::error::Error as StdError;
use std::future::{pending, Future};
use std::io;
use std::time::Duration;

use serde_json::{json, Value};
use support::scratch_database;
use tokio_postgres::types::ToSql;
use tokio_postgres::Transaction;
use uuid::Uuid;
use workhorse::compatibility::CompatibilityCode;
use workhorse::contracts::{TaskContractVersion, TaskTypeContracts};
use workhorse::{
    EnqueueBind, EnqueueClient, EnqueueColumnType, EnqueueOptions, EnqueueOutcome, EnqueueQuery,
    EnqueueRequest, EnqueueRow, EnqueueTransport, EnqueueValue, Error, Idempotency, Queue,
};

fn assert_send<T: Future + Send>(future: T) -> T {
    future
}

fn row(fields: &[(&str, EnqueueValue)]) -> EnqueueRow {
    fields.iter().map(|(name, value)| ((*name).into(), value.clone())).collect()
}

fn compatible() -> Vec<EnqueueRow> {
    vec![
        row(&[
            ("kind", EnqueueValue::Text("schema".into())),
            ("version", EnqueueValue::Int(workhorse::MIN_SCHEMA_VERSION)),
        ]),
        row(&[
            ("kind", EnqueueValue::Text("protocol".into())),
            ("version", EnqueueValue::Int(workhorse::CLIENT_PROTOCOL_VERSION)),
        ]),
    ]
}

fn result(ordinal: i32, task_id: Uuid) -> EnqueueRow {
    row(&[
        ("ordinal", EnqueueValue::Int(ordinal)),
        ("task_id", EnqueueValue::Uuid(task_id)),
        ("outcome", EnqueueValue::Text("accepted".into())),
        ("reason", EnqueueValue::Null),
    ])
}

struct Scripted {
    replies: VecDeque<Result<Vec<EnqueueRow>, Error>>,
    documents: Vec<Value>,
    calls: usize,
    mutable_only: Cell<usize>,
}

impl Scripted {
    fn new(replies: Vec<Result<Vec<EnqueueRow>, Error>>) -> Self {
        Self { replies: replies.into(), documents: vec![], calls: 0, mutable_only: Cell::new(0) }
    }
}

impl EnqueueTransport for Scripted {
    async fn query(&mut self, query: EnqueueQuery<'_>) -> Result<Vec<EnqueueRow>, Error> {
        self.calls += 1;
        self.mutable_only.set(self.calls);
        if let [EnqueueBind::Json(document)] = query.binds() {
            self.documents.push((*document).clone());
        }
        self.replies.pop_front().expect("unexpected transport query")
    }
}

#[tokio::test]
async fn mutable_non_sync_transport_restores_batch_order_and_prepares_values() {
    let client = EnqueueClient::new("mutable");
    let first = Uuid::new_v4();
    let second = Uuid::new_v4();
    let mut transport =
        Scripted::new(vec![Ok(compatible()), Ok(vec![result(2, second), result(1, first)])]);
    let results = assert_send(client.enqueue_many(
        &mut transport,
        vec![
            EnqueueRequest::new("first", json!({"nested": [null, true, "é"]})),
            EnqueueRequest::new("second", json!({})),
        ],
    ))
    .await
    .unwrap();
    assert_eq!(
        results.iter().map(|result| result.task_id).collect::<Vec<_>>(),
        vec![first, second]
    );
    assert_eq!(transport.mutable_only.get(), 2);
    assert_eq!(transport.documents[0][0]["queue"], "mutable");
    assert_eq!(transport.documents[0][0]["payload"], json!({"nested": [null, true, "é"]}));
    assert!(transport.documents[0][0]["runAt"].as_str().unwrap().ends_with('Z'));
    assert_eq!(transport.documents[0][0]["contractVersion"], Value::Null);
}

#[tokio::test]
async fn shared_decoder_rejects_invalid_stale_and_incomplete_shapes() {
    let valid = result(1, Uuid::new_v4());
    let mut invalid = vec![vec![], vec![valid.clone(), valid.clone()]];
    for (field, replacement) in [
        ("ordinal", Some(EnqueueValue::Int(0))),
        ("ordinal", Some(EnqueueValue::Int(2))),
        ("ordinal", Some(EnqueueValue::Text("1".into()))),
        ("task_id", Some(EnqueueValue::Null)),
        ("task_id", Some(EnqueueValue::Text(Uuid::new_v4().to_string()))),
        ("outcome", Some(EnqueueValue::Text("stale".into()))),
        ("outcome", Some(EnqueueValue::Text("non_replaceable".into()))),
        ("reason", Some(EnqueueValue::Text("future_reason".into()))),
        ("reason", None),
    ] {
        let mut changed = valid.clone();
        match replacement {
            Some(value) => {
                changed.insert(field.into(), value);
            }
            None => {
                changed.remove(field);
            }
        }
        invalid.push(vec![changed]);
    }
    invalid.push(vec![result(1, Uuid::new_v4()), result(1, Uuid::new_v4())]);
    for rows in invalid {
        let client = EnqueueClient::new("invalid");
        let mut transport = Scripted::new(vec![Ok(compatible()), Ok(rows)]);
        let outcome =
            client.enqueue(&mut transport, "task", &json!({}), EnqueueOptions::default()).await;
        assert!(matches!(outcome, Err(Error::InvalidArgument(_))), "{outcome:?}");
        assert_eq!(transport.calls, 2);
    }
}

#[tokio::test]
async fn invalid_options_and_empty_or_oversized_batches_never_touch_transport() {
    let client = EnqueueClient::new("invalid");
    let mut transport = Scripted::new(vec![]);
    assert!(client.enqueue_many(&mut transport, vec![]).await.unwrap().is_empty());
    let options = EnqueueOptions { max_attempts: -1, ..Default::default() };
    assert!(matches!(
        client.enqueue(&mut transport, "task", &json!({}), options).await,
        Err(Error::InvalidArgument(_))
    ));
    let requests =
        vec![EnqueueRequest::new("task", json!({})); workhorse::MAX_ENQUEUE_BATCH_SIZE + 1];
    assert!(matches!(
        client.enqueue_many(&mut transport, requests).await,
        Err(Error::InvalidArgument(_))
    ));
    assert_eq!(transport.calls, 0);
}

fn database_error(code: &str, detail: Option<&str>) -> Error {
    Error::database(Some(code), detail, io::Error::other("driver source, not protocol text"))
}

#[tokio::test]
async fn structured_sqlstate_detail_and_source_are_driver_neutral() {
    for (code, detail) in [
        ("P1001", r#"{"ordinal":4,"conflictingFields":["payload"]}"#),
        ("P1003", r#"{"cycleTaskIds":["first","second"]}"#),
        ("P1005", r#"{"limit":"dependents","max":100}"#),
        ("P1007", r#"{"queue":"fast","feature":"dependencies","ordinal":2}"#),
    ] {
        let client = EnqueueClient::new("errors");
        let mut transport =
            Scripted::new(vec![Ok(compatible()), Err(database_error(code, Some(detail)))]);
        let error = client
            .enqueue(&mut transport, "task", &json!({}), EnqueueOptions::default())
            .await
            .unwrap_err();
        match error {
            Error::EnqueueIdempotencyConflict { details } => {
                assert_eq!(details.ordinal, 4);
                assert_eq!(details.conflicting_fields, ["payload"]);
            }
            Error::DependencyCycle { details } => {
                assert_eq!(details.cycle_task_ids, ["first", "second"])
            }
            Error::DependencyLimitExceeded { details } => {
                assert_eq!(details.limit, "dependents");
                assert_eq!(details.max, 100);
            }
            Error::FastTierUnsupported { queue, feature, ordinal } => {
                assert_eq!(queue, "fast");
                assert_eq!(feature, "dependencies");
                assert_eq!(ordinal, Some(2));
            }
            other => panic!("not translated: {other:?}"),
        }
    }
    for code in ["P1001", "P1003", "P1005", "P1007"] {
        let client = EnqueueClient::new("malformed");
        let mut transport =
            Scripted::new(vec![Ok(compatible()), Err(database_error(code, Some("not JSON")))]);
        let error = client
            .enqueue(&mut transport, "task", &json!({}), EnqueueOptions::default())
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            Error::EnqueueIdempotencyConflict { .. }
                | Error::DependencyCycle { .. }
                | Error::DependencyLimitExceeded { .. }
                | Error::FastTierUnsupported { .. }
        ));
    }
    let client = EnqueueClient::new("unknown");
    let mut transport =
        Scripted::new(vec![Ok(compatible()), Err(database_error("23514", Some("diagnostic")))]);
    let error = client
        .enqueue(&mut transport, "task", &json!({}), EnqueueOptions::default())
        .await
        .unwrap_err();
    assert_eq!(error.sqlstate(), Some("23514"));
    assert_eq!(error.source().unwrap().to_string(), "driver source, not protocol text");
    assert!(
        matches!(error, Error::Database { detail: Some(detail), .. } if detail == "diagnostic")
    );
}

#[tokio::test]
async fn compatibility_refusals_cache_but_driver_errors_retry() {
    let client = EnqueueClient::new("compatibility");
    let mut transport = Scripted::new(vec![Err(database_error("08006", None)), Ok(compatible())]);
    assert_eq!(
        client.assert_compatible(&mut transport).await.unwrap_err().sqlstate(),
        Some("08006")
    );
    client.assert_compatible(&mut transport).await.unwrap();
    client.assert_compatible(&mut transport).await.unwrap();
    assert_eq!(transport.calls, 2);
    for code in ["42P01", "3F000"] {
        let client = EnqueueClient::new("missing");
        let mut transport = Scripted::new(vec![Err(database_error(code, None))]);
        for _attempt in 0..2 {
            assert!(matches!(
                client.assert_compatible(&mut transport).await,
                Err(Error::Compatibility { code: CompatibilityCode::SchemaNotInstalled })
            ));
        }
        assert_eq!(transport.calls, 1);
    }
}

fn mismatch(task_types: Value) -> Vec<EnqueueRow> {
    vec![row(&[
        ("ordinal", EnqueueValue::Int(0)),
        ("task_id", EnqueueValue::Null),
        ("outcome", EnqueueValue::Text("contract_mismatch".into())),
        ("reason", EnqueueValue::Text(json!({"taskTypes": task_types}).to_string())),
    ])]
}

fn contract(version: &str) -> Vec<EnqueueRow> {
    vec![row(&[
        ("schema", EnqueueValue::Json(json!({"payload": {"type":"object", "required":["id"]}}))),
        ("version", EnqueueValue::Text(version.into())),
        ("payload_max_bytes", EnqueueValue::Int(4096)),
        ("result_max_bytes", EnqueueValue::Int(2048)),
        ("payload_redact_keys", EnqueueValue::TextArray(vec!["secret".into()])),
        ("result_redact_keys", EnqueueValue::TextArray(vec![])),
    ])]
}

#[tokio::test]
async fn contracts_refresh_once_validate_and_reject_a_second_policy_change() {
    let client = EnqueueClient::new("contracts");
    let mut transport = Scripted::new(vec![
        Ok(compatible()),
        Ok(mismatch(json!(["task"]))),
        Ok(contract("v1")),
        Ok(vec![result(1, Uuid::new_v4())]),
    ]);
    client
        .enqueue(&mut transport, "task", &json!({"id": 1}), EnqueueOptions::default())
        .await
        .unwrap();
    assert_eq!(transport.documents[1][0]["contractVersion"], "v1");
    assert_eq!(transport.documents[1][0]["payloadMaxBytes"], 4096);
    assert_eq!(transport.documents[1][0]["resultMaxBytes"], 2048);
    assert_eq!(transport.documents[1][0]["sensitivePayloadKeys"], json!(["secret"]));
    assert!(
        matches!(client.enqueue(&mut transport, "task", &json!({}), EnqueueOptions::default()).await, Err(Error::ContractValidation { version, .. }) if version == "v1")
    );
    assert_eq!(transport.calls, 4);
    let client = EnqueueClient::new("changing");
    let mut transport = Scripted::new(vec![
        Ok(compatible()),
        Ok(mismatch(json!(["task"]))),
        Ok(contract("v1")),
        Ok(mismatch(json!(["task"]))),
        Ok(contract("v2")),
    ]);
    assert!(matches!(
        client.enqueue(&mut transport, "task", &json!({"id":1}), EnqueueOptions::default()).await,
        Err(Error::ContractPolicyChanged)
    ));
    assert_eq!(transport.calls, 5);
    for task_types in
        [json!([]), json!([""]), json!(null), json!(["other"]), json!(["task", "task"])]
    {
        let client = EnqueueClient::new("invalid-mismatch");
        let mut transport = Scripted::new(vec![Ok(compatible()), Ok(mismatch(task_types))]);
        assert!(matches!(
            client.enqueue(&mut transport, "task", &json!({}), EnqueueOptions::default()).await,
            Err(Error::InvalidArgument(_))
        ));
    }
}

struct PendingTransport<'a> {
    borrowed: &'a mut usize,
}

impl EnqueueTransport for PendingTransport<'_> {
    async fn query(&mut self, _query: EnqueueQuery<'_>) -> Result<Vec<EnqueueRow>, Error> {
        *self.borrowed += 1;
        pending().await
    }
}

#[tokio::test]
async fn dropping_a_send_future_releases_the_mutable_borrow_and_uncached_check() {
    let client = EnqueueClient::new("cancelled");
    let mut count = 0;
    let mut transport = PendingTransport { borrowed: &mut count };
    assert!(tokio::time::timeout(
        Duration::from_millis(10),
        assert_send(client.assert_compatible(&mut transport))
    )
    .await
    .is_err());
    *transport.borrowed += 1;
    assert_eq!(*transport.borrowed, 2);
    let mut retry = Scripted::new(vec![Ok(compatible())]);
    client.assert_compatible(&mut retry).await.unwrap();
}

struct MutableTransaction<'borrow, 'connection> {
    transaction: &'borrow mut Transaction<'connection>,
    identities: Vec<(i32, i64)>,
    mutable_only: Cell<usize>,
}

impl<'borrow, 'connection> MutableTransaction<'borrow, 'connection> {
    fn new(transaction: &'borrow mut Transaction<'connection>) -> Self {
        Self { transaction, identities: vec![], mutable_only: Cell::new(0) }
    }
}

fn normalize(error: tokio_postgres::Error) -> Error {
    let code = error.code().map(|code| code.code().to_owned());
    let detail = error.as_db_error().and_then(|database| database.detail()).map(str::to_owned);
    Error::database(code.as_deref(), detail.as_deref(), error)
}

impl EnqueueTransport for MutableTransaction<'_, '_> {
    async fn query(&mut self, query: EnqueueQuery<'_>) -> Result<Vec<EnqueueRow>, Error> {
        assert!(query.statement().starts_with("SELECT"), "no lifecycle takeover");
        self.mutable_only.set(self.mutable_only.get() + 1);
        let identity = self
            .transaction
            .query_one("SELECT pg_backend_pid(), txid_current()", &[])
            .await
            .map_err(normalize)?;
        self.identities.push((identity.get(0), identity.get(1)));
        let binds: Vec<&(dyn ToSql + Sync)> = query
            .binds()
            .iter()
            .map(|bind| match bind {
                EnqueueBind::Json(value) => *value as &(dyn ToSql + Sync),
                EnqueueBind::Text(value) => value as &(dyn ToSql + Sync),
            })
            .collect();
        let rows = self.transaction.query(query.statement(), &binds).await.map_err(normalize)?;
        rows.iter()
            .map(|native| {
                query
                    .columns()
                    .iter()
                    .map(|column| {
                        let value = match column.kind {
                            EnqueueColumnType::Int => native
                                .try_get::<_, Option<i32>>(column.name)
                                .map(|value| value.map(EnqueueValue::Int)),
                            EnqueueColumnType::Text => native
                                .try_get::<_, Option<String>>(column.name)
                                .map(|value| value.map(EnqueueValue::Text)),
                            EnqueueColumnType::TextArray => native
                                .try_get::<_, Option<Vec<String>>>(column.name)
                                .map(|value| value.map(EnqueueValue::TextArray)),
                            EnqueueColumnType::Json => native
                                .try_get::<_, Option<Value>>(column.name)
                                .map(|value| value.map(EnqueueValue::Json)),
                            EnqueueColumnType::Uuid => native
                                .try_get::<_, Option<Uuid>>(column.name)
                                .map(|value| value.map(EnqueueValue::Uuid)),
                        }
                        .map_err(normalize)?
                        .unwrap_or(EnqueueValue::Null);
                        Ok((column.name.into(), value))
                    })
                    .collect()
            })
            .collect()
    }
}

async fn counts(observer: &tokio_postgres::Client) -> (i64, i64) {
    let row = observer
        .query_one(
            "SELECT (SELECT count(*) FROM business), (SELECT count(*) FROM workhorse.task)",
            &[],
        )
        .await
        .unwrap();
    (row.get(0), row.get(1))
}

#[tokio::test]
async fn borrowed_transport_preserves_identity_joint_commit_rollback_and_savepoints() {
    let Some(database) = scratch_database("mutable_transport_lifecycle").await else { return };
    let observer = database.connect().await;
    observer.batch_execute("CREATE TABLE business (id integer PRIMARY KEY)").await.unwrap();
    let mut caller = database.connect().await;
    let client = EnqueueClient::new("borrowed");
    let mut transaction = caller.transaction().await.unwrap();
    transaction.execute("INSERT INTO business VALUES (1)", &[]).await.unwrap();
    let identity =
        transaction.query_one("SELECT pg_backend_pid(), txid_current()", &[]).await.unwrap();
    let expected = (identity.get::<_, i32>(0), identity.get::<_, i64>(1));
    {
        let mut transport = MutableTransaction::new(&mut transaction);
        assert_send(client.enqueue_many(
            &mut transport,
            vec![
                EnqueueRequest::new("first", json!({"id":1})),
                EnqueueRequest::new("second", json!({"id":2})),
            ],
        ))
        .await
        .unwrap();
        assert!(transport.identities.iter().all(|identity| *identity == expected));
        assert_eq!(transport.mutable_only.get(), 2);
    }
    assert_eq!(counts(&observer).await, (0, 0));
    transaction.commit().await.unwrap();
    assert_eq!(counts(&observer).await, (1, 2));

    let mut transaction = caller.transaction().await.unwrap();
    transaction.execute("INSERT INTO business VALUES (2)", &[]).await.unwrap();
    client
        .enqueue(
            &mut MutableTransaction::new(&mut transaction),
            "rolled-back",
            &json!({}),
            EnqueueOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(counts(&observer).await, (1, 2));
    transaction.rollback().await.unwrap();
    assert_eq!(counts(&observer).await, (1, 2));

    let mut transaction = caller.transaction().await.unwrap();
    transaction.execute("INSERT INTO business VALUES (3)", &[]).await.unwrap();
    {
        let mut savepoint = transaction.savepoint("enqueue_savepoint").await.unwrap();
        savepoint.execute("INSERT INTO business VALUES (4)", &[]).await.unwrap();
        client
            .enqueue(
                &mut MutableTransaction::new(&mut savepoint),
                "savepoint",
                &json!({}),
                EnqueueOptions::default(),
            )
            .await
            .unwrap();
        savepoint.rollback().await.unwrap();
    }
    client
        .enqueue(
            &mut MutableTransaction::new(&mut transaction),
            "outside-savepoint",
            &json!({}),
            EnqueueOptions::default(),
        )
        .await
        .unwrap();
    assert_eq!(counts(&observer).await, (1, 2));
    transaction.commit().await.unwrap();
    assert_eq!(counts(&observer).await, (2, 3));
    assert_eq!(
        observer
            .query_one("SELECT count(*) FROM business WHERE id = 4", &[])
            .await
            .unwrap()
            .get::<_, i64>(0),
        0
    );
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
                    ..Default::default()
                },
            )]),
        },
    )])
}

#[tokio::test]
async fn native_contract_refresh_and_structured_error_match_queue() {
    let Some(database) = scratch_database("mutable_transport_contracts").await else { return };
    let observer = database.connect().await;
    let queue = Queue::new(&observer, "contracts");
    queue.sync_contracts(&definitions("v1")).await.unwrap();
    let client = EnqueueClient::new("contracts");
    let mut caller = database.connect().await;
    let mut transaction = caller.transaction().await.unwrap();
    {
        let mut transport = MutableTransaction::new(&mut transaction);
        assert!(
            matches!(client.enqueue(&mut transport, "contracted", &json!({}), EnqueueOptions::default()).await, Err(Error::ContractValidation { version, .. }) if version == "v1")
        );
        let result = client
            .enqueue(&mut transport, "contracted", &json!({"id":1}), EnqueueOptions::default())
            .await
            .unwrap();
        assert_eq!(result.outcome, EnqueueOutcome::Accepted);
    }
    transaction.commit().await.unwrap();
    queue.sync_contracts(&definitions("v2")).await.unwrap();
    let mut transaction = caller.transaction().await.unwrap();
    {
        let mut transport = MutableTransaction::new(&mut transaction);
        client
            .enqueue(&mut transport, "contracted", &json!({"id":2}), EnqueueOptions::default())
            .await
            .unwrap();
        assert_eq!(
            transport.mutable_only.get(),
            3,
            "enqueue, contract refresh, retry on one borrowed transaction"
        );
    }
    transaction.commit().await.unwrap();
    let rows = observer
        .query("SELECT contract_version FROM workhorse.task ORDER BY contract_version", &[])
        .await
        .unwrap();
    assert_eq!(rows.iter().map(|row| row.get::<_, String>(0)).collect::<Vec<_>>(), ["v1", "v2"]);

    let options =
        EnqueueOptions { idempotency: Some(Idempotency::new("same")), ..Default::default() };
    queue.enqueue("idempotent", &json!({"id":1}), options.clone()).await.unwrap();
    let mut transaction = caller.transaction().await.unwrap();
    let seam = client
        .enqueue(
            &mut MutableTransaction::new(&mut transaction),
            "idempotent",
            &json!({"id":2}),
            options.clone(),
        )
        .await
        .unwrap_err();
    assert!(matches!(seam, Error::EnqueueIdempotencyConflict { .. }));
    transaction.rollback().await.unwrap();
    let legacy = queue.enqueue("idempotent", &json!({"id":2}), options).await.unwrap_err();
    match (seam, legacy) {
        (
            Error::EnqueueIdempotencyConflict { details: seam },
            Error::EnqueueIdempotencyConflict { details: legacy },
        ) => assert_eq!(seam, legacy),
        other => panic!("error parity failed: {other:?}"),
    }
}

#[tokio::test]
async fn contract_sync_uses_the_borrowed_transaction_and_rolls_back_with_it() {
    let Some(database) = scratch_database("mutable_transport_sync").await else { return };
    let observer = database.connect().await;
    let mut caller = database.connect().await;
    let client = EnqueueClient::new("contracts");
    let mut transaction = caller.transaction().await.unwrap();
    {
        let mut transport = MutableTransaction::new(&mut transaction);
        assert_send(client.sync_contracts(&mut transport, &definitions("v1"))).await.unwrap();
        assert!(
            matches!(client.enqueue(&mut transport, "contracted", &json!({}), EnqueueOptions::default()).await, Err(Error::ContractValidation { version, .. }) if version == "v1")
        );
        client
            .enqueue(&mut transport, "contracted", &json!({"id":1}), EnqueueOptions::default())
            .await
            .unwrap();
    }
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
    transaction.rollback().await.unwrap();
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
}

#[tokio::test]
async fn caller_cancels_the_server_statement_and_owns_transaction_recovery() {
    let Some(database) = scratch_database("mutable_transport_cancel").await else { return };
    let observer = database.connect().await;
    observer.batch_execute("CREATE TABLE business (id integer PRIMARY KEY)").await.unwrap();
    let mut caller = database.connect().await;
    let cancel = caller.cancel_token();
    let client = EnqueueClient::new("cancelled");
    let mut transaction = caller.transaction().await.unwrap();
    transaction.execute("INSERT INTO business VALUES (1)", &[]).await.unwrap();
    let backend: i32 = transaction.query_one("SELECT pg_backend_pid()", &[]).await.unwrap().get(0);
    client.assert_compatible(&mut MutableTransaction::new(&mut transaction)).await.unwrap();
    let mut blocker_connection = database.connect().await;
    let blocker = blocker_connection.transaction().await.unwrap();
    blocker.batch_execute("LOCK TABLE workhorse.task IN ACCESS EXCLUSIVE MODE").await.unwrap();
    {
        let mut transport = MutableTransaction::new(&mut transaction);
        let payload = json!({});
        let operation = assert_send(client.enqueue(
            &mut transport,
            "blocked",
            &payload,
            EnqueueOptions::default(),
        ));
        tokio::pin!(operation);
        tokio::select! {
            result = &mut operation => panic!("statement was not blocked: {result:?}"),
            () = async {
                tokio::time::timeout(Duration::from_secs(5), async {
                    loop {
                        let waiting: bool = observer.query_one(
                            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock')",
                            &[&backend],
                        ).await.unwrap().get(0);
                        if waiting { break; }
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                }).await.expect("enqueue reached a server-side lock wait");
                cancel.cancel_query(tokio_postgres::NoTls).await.unwrap();
            } => {}
        }
        let error =
            tokio::time::timeout(Duration::from_secs(5), operation).await.unwrap().unwrap_err();
        assert_eq!(error.sqlstate(), Some("57014"));
        assert!(error.source().is_some());
    }
    let aborted = transaction.query_one("SELECT 1", &[]).await.unwrap_err();
    assert_eq!(aborted.code().unwrap().code(), "25P02", "the transport did not take over recovery");
    transaction.rollback().await.unwrap();
    blocker.rollback().await.unwrap();
    assert_eq!(counts(&observer).await, (0, 0));
    assert_eq!(caller.query_one("SELECT 1", &[]).await.unwrap().get::<_, i32>(0), 1);
}
