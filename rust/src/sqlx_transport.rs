use sqlx::postgres::{PgDatabaseError, PgRow};
use sqlx::{Postgres, Row, Transaction};

use crate::{
    EnqueueBind, EnqueueColumn, EnqueueColumnType, EnqueueQuery, EnqueueRow, EnqueueTransport,
    EnqueueValue, Error,
};

/// Enqueue through the caller's exact SQLx PostgreSQL transaction.
///
/// The `sqlx` feature supports SQLx 0.8.6 on Tokio. This implementation does not
/// acquire a connection or resolve the transaction. Workers still use deadpool-postgres.
/// A dropped query future does not cancel PostgreSQL; roll back an uncertain operation.
///
/// Operations are Send while borrowing the transaction, without static ownership:
///
/// ```no_run
/// use workhorse::{sqlx, EnqueueClient, EnqueueOptions};
/// fn send<T: std::future::Future + Send>(future: T) -> T { future }
/// async fn submit(transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>) {
///     let client = EnqueueClient::new("default");
///     send(client.enqueue(transaction, "task", &serde_json::json!({}),
///         EnqueueOptions::default())).await.unwrap();
/// }
/// ```
///
/// A pending enqueue holds the mutable borrow until it completes or is dropped:
///
/// ```compile_fail
/// use workhorse::{sqlx, EnqueueClient};
/// async fn overlapping(transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>) {
///     let client = EnqueueClient::new("default");
///     let pending = client.assert_compatible(transaction);
///     sqlx::query("SELECT 1").execute(&mut **transaction).await.unwrap();
///     pending.await.unwrap();
/// }
/// ```
///
/// A borrowed transaction cannot be committed while enqueue is pending:
///
/// ```compile_fail
/// use workhorse::{sqlx, EnqueueClient};
/// async fn stale(mut transaction: sqlx::Transaction<'_, sqlx::Postgres>) {
///     let client = EnqueueClient::new("default");
///     let pending = client.assert_compatible(&mut transaction);
///     transaction.commit().await.unwrap();
///     pending.await.unwrap();
/// }
/// ```
impl EnqueueTransport for Transaction<'_, Postgres> {
    async fn query(&mut self, query: EnqueueQuery<'_>) -> Result<Vec<EnqueueRow>, Error> {
        let mut statement = sqlx::query(query.statement());
        for bind in query.binds() {
            statement = match bind {
                EnqueueBind::Json(value) => statement.bind(*value),
                EnqueueBind::Text(value) => statement.bind(*value),
            };
        }
        let rows = statement.fetch_all(&mut **self).await.map_err(normalize)?;
        rows.iter()
            .map(|row| {
                query
                    .columns()
                    .iter()
                    .map(|column| decode(row, column).map(|value| (column.name.to_owned(), value)))
                    .collect()
            })
            .collect()
    }
}

fn decode(row: &PgRow, column: &EnqueueColumn) -> Result<EnqueueValue, Error> {
    let value = match column.kind {
        EnqueueColumnType::Int => {
            row.try_get::<Option<i32>, _>(column.name).map(|value| value.map(EnqueueValue::Int))
        }
        EnqueueColumnType::Text => {
            row.try_get::<Option<String>, _>(column.name).map(|value| value.map(EnqueueValue::Text))
        }
        EnqueueColumnType::TextArray => row
            .try_get::<Option<Vec<String>>, _>(column.name)
            .map(|value| value.map(EnqueueValue::TextArray)),
        EnqueueColumnType::Json => row
            .try_get::<Option<serde_json::Value>, _>(column.name)
            .map(|value| value.map(EnqueueValue::Json)),
        EnqueueColumnType::Uuid => row
            .try_get::<Option<uuid::Uuid>, _>(column.name)
            .map(|value| value.map(EnqueueValue::Uuid)),
    };
    value.map(|value| value.unwrap_or(EnqueueValue::Null)).map_err(normalize)
}

fn normalize(error: sqlx::Error) -> Error {
    let database = error
        .as_database_error()
        .and_then(|database| database.try_downcast_ref::<PgDatabaseError>());
    let code = database.map(|database| database.code().to_owned());
    let detail = database.and_then(|database| database.detail()).map(str::to_owned);
    Error::database(code.as_deref(), detail.as_deref(), error)
}
