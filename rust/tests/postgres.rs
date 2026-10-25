//! Rust client tests that run against PostgreSQL in a per-process scratch database.

mod support;

use workhorse::compatibility::{
    assert_schema_compatible, read_compatibility_state, CompatibilityCode,
};
use workhorse::{Error, Queue, CLIENT_PROTOCOL_VERSION, MAX_SCHEMA_VERSION, MIN_SCHEMA_VERSION};

#[tokio::test]
async fn postgres_client_reads_the_installed_protocol_and_schema_versions() {
    let Some(database) = support::scratch_database("postgres_client_versions").await else {
        return;
    };
    let queue = Queue::connect(database.url(), "rust-postgres").await.expect("connect Rust client");

    queue.assert_compatible().await.expect("installed schema is compatible");

    let state = read_compatibility_state(queue.executor()).await.unwrap();
    assert!(state.served_protocol_versions.contains(&CLIENT_PROTOCOL_VERSION));
    let schema_version = state.installed_schema_version.expect("an installed schema");
    assert!((MIN_SCHEMA_VERSION..=MAX_SCHEMA_VERSION).contains(&schema_version));
}

#[tokio::test]
async fn assert_schema_compatible_refuses_a_database_without_the_schema() {
    let Some(database) = support::scratch_database("postgres_startup_check").await else {
        return;
    };
    let client = database.connect().await;
    assert_schema_compatible(&client).await.expect("the installed schema is compatible");

    client.batch_execute("ALTER SCHEMA workhorse RENAME TO workhorse_hidden").await.unwrap();
    let refused = assert_schema_compatible(&client).await;
    client.batch_execute("ALTER SCHEMA workhorse_hidden RENAME TO workhorse").await.unwrap();
    assert!(
        matches!(
            refused,
            Err(Error::Compatibility { code: CompatibilityCode::SchemaNotInstalled })
        ),
        "got {refused:?}"
    );
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

#[tokio::test]
async fn postgres_scratch_database_keeps_the_sweep_lock_until_its_guard_drops() {
    let Some(database) = support::scratch_database("postgres_scratch_lease").await else {
        return;
    };
    let name = database.name().to_owned();
    let (sweep, connection) = database.admin().connect(tokio_postgres::NoTls).await.unwrap();
    tokio::spawn(connection);
    // `pnpm db:sweep` takes this lock with no wait before it drops a scratch database. No session
    // of the test is on the scratch database now, so only the lease keeps the sweep away.
    let try_lock = "SELECT pg_try_advisory_lock(hashtextextended($1, 0))";
    let unlock = "SELECT pg_advisory_unlock(hashtextextended($1, 0))";
    let locked: bool = sweep.query_one(try_lock, &[&name]).await.unwrap().get(0);
    if locked {
        sweep.execute(unlock, &[&name]).await.unwrap();
    }
    assert!(!locked, "the sweep took the lock of the live scratch database {name}");

    drop(database);

    // The lease session ends after the drop, so the lock becomes free.
    let mut freed = false;
    for _ in 0..200 {
        freed = sweep.query_one(try_lock, &[&name]).await.unwrap().get(0);
        if freed {
            sweep.execute(unlock, &[&name]).await.unwrap();
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert!(freed, "the lease of {name} outlived its guard");
}

#[tokio::test]
async fn postgres_scratch_database_commits_without_waiting_for_the_wal_flush() {
    let Some(database) = support::scratch_database("postgres_scratch_async_commit").await else {
        return;
    };
    // Each new session in the scratch database takes the setting, including the worker's pool.
    for _ in 0..2 {
        let setting: String = database
            .connect()
            .await
            .query_one("SELECT current_setting('synchronous_commit')", &[])
            .await
            .unwrap()
            .get(0);
        assert_eq!(setting, "off", "a host I/O stall would delay each commit in a test");
    }
}
