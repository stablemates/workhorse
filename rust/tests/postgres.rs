//! Rust client tests that run against PostgreSQL in a per-process scratch database.

mod support;

use workhorse::{Queue, CLIENT_PROTOCOL_VERSION, MAX_SCHEMA_VERSION, MIN_SCHEMA_VERSION};

#[tokio::test]
async fn postgres_client_reads_the_installed_protocol_and_schema_versions() {
    let Some(database) = support::scratch_database("postgres_client_versions").await else {
        return;
    };
    let queue = Queue::connect(database.url(), "rust-postgres").await.expect("connect Rust client");

    let compatibility = queue.check_compatibility().await.expect("installed schema is compatible");

    assert_eq!(compatibility.protocol_version, CLIENT_PROTOCOL_VERSION);
    assert!((MIN_SCHEMA_VERSION..=MAX_SCHEMA_VERSION).contains(&compatibility.schema_version));
}

#[tokio::test]
async fn postgres_scratch_database_is_isolated_and_dropped() {
    let Some(database) = support::scratch_database("postgres_scratch_lifecycle").await else {
        return;
    };
    let name = database.name().to_owned();
    let source = std::env::var("DATABASE_URL_TEST").unwrap();
    assert!(!source.contains(&format!("/{name}")), "scratch database must not be the source");

    let current: String =
        database.connect().await.query_one("SELECT current_database()", &[]).await.unwrap().get(0);
    assert_eq!(current, name);

    let (admin, connection) = database.admin().connect(tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(connection);
    let exists = "SELECT count(*) FROM pg_database WHERE datname = $1";
    let before: i64 = admin.query_one(exists, &[&name]).await.unwrap().get(0);
    assert_eq!(before, 1);

    drop(database);

    let after: i64 = admin.query_one(exists, &[&name]).await.unwrap().get(0);
    assert_eq!(after, 0, "scratch database {name} survived its guard");
}
