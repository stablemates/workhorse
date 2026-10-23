//! Per-process scratch PostgreSQL databases for the Rust integration tests.
//!
//! A database test never uses the checkout's `test` database directly. It derives a scratch
//! database from `DATABASE_URL_TEST`, named after that database plus a per-process digest, installs
//! `sql/schema/current.sql` into it, and drops it when the guard goes out of scope. `pnpm db:sweep`
//! recognizes the same name shape if a teardown never runs.
//!
//! Without `DATABASE_URL_TEST` a local run skips with a visible reason. CI, or
//! `WORKHORSE_REQUIRE_DATABASE=1`, turns that skip into a failure, and a database that is set but
//! unreachable always fails.
//!
//! `WORKHORSE_NO_DATABASE=1` skips every database test, even when `DATABASE_URL_TEST` is set.
//! `pnpm rust:test:unit` sets it, so the unit scope that the pre-commit hook runs never uses
//! PostgreSQL. Library tests in `src/worker/heartbeat.rs` use this module too.

#![allow(dead_code)]

use std::collections::hash_map::DefaultHasher;
use std::env;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::time::Duration;

use tokio_postgres::config::Host;
use tokio_postgres::error::SqlState;
use tokio_postgres::{Client, Config, NoTls};

const SCHEMA: &str = include_str!("../../../sql/schema/current.sql");
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const DROP_ATTEMPTS: u32 = 40;
const DROP_RETRY: Duration = Duration::from_millis(25);

pub struct ScratchDatabase {
    name: String,
    url: String,
    admin: Config,
}

impl ScratchDatabase {
    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    pub async fn connect(&self) -> Client {
        connect(&self.url.parse().expect("scratch database URL")).await
    }

    /// The administrative connection settings, so a test can observe the scratch lifecycle.
    pub fn admin(&self) -> Config {
        self.admin.clone()
    }
}

impl Drop for ScratchDatabase {
    fn drop(&mut self) {
        let name = self.name.clone();
        let admin = self.admin.clone();
        // The test runtime is blocked inside this destructor, so the drop runs on its own runtime.
        let dropped = std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("scratch teardown runtime")
                .block_on(async move {
                    let (client, connection) = admin.connect(NoTls).await?;
                    tokio::spawn(connection);
                    drop_database(&client, &name).await
                })
        })
        .join();
        match dropped {
            Ok(Ok(())) => report(&format!("dropped scratch database {}", self.name)),
            outcome => {
                let message = format!(
                    "could not drop scratch database {}: {outcome:?}; run pnpm db:sweep",
                    self.name
                );
                if std::thread::panicking() {
                    report(&message);
                } else {
                    panic!("{message}");
                }
            }
        }
    }
}

/// Create a scratch database for `test`, or return `None` when a local run has no database.
pub async fn scratch_database(test: &str) -> Option<ScratchDatabase> {
    if set("WORKHORSE_NO_DATABASE") {
        report(&format!("SKIPPED {test}: WORKHORSE_NO_DATABASE is set"));
        return None;
    }
    let Some(source) = env::var("DATABASE_URL_TEST").ok().filter(|value| !value.is_empty()) else {
        if database_required() {
            panic!(
                "DATABASE_URL_TEST is unset, but this run requires PostgreSQL \
                 (CI or WORKHORSE_REQUIRE_DATABASE=1)"
            );
        }
        report(&format!("SKIPPED {test}: DATABASE_URL_TEST is unset"));
        return None;
    };

    let source_config: Config = source.parse().expect("DATABASE_URL_TEST must be a PostgreSQL URL");
    for host in source_config.get_hosts() {
        let loopback = match host {
            Host::Tcp(name) => matches!(name.as_str(), "localhost" | "127.0.0.1" | "::1"),
            Host::Unix(_) => true,
        };
        assert!(loopback, "Rust integration tests refuse a non-loopback database: {host:?}");
    }
    let source_name = source_config.get_dbname().expect("DATABASE_URL_TEST must name a database");
    assert!(source_name.contains("test"), "DATABASE_URL_TEST must name a test database");

    let name = scratch_name(source_name, test, std::process::id());
    let mut admin = source_config.clone();
    admin.dbname("postgres");
    let url = replace_database(&source, &name);

    let client = connect(&admin).await;
    drop_database(&client, &name)
        .await
        .unwrap_or_else(|error| panic!("drop stale scratch database {name}: {error:?}"));
    client
        .batch_execute(&format!("CREATE DATABASE {}", quote(&name)))
        .await
        .unwrap_or_else(|error| panic!("create scratch database {name}: {error:?}"));
    // Owned from here on, so a failed schema install still drops the database.
    let scratch = ScratchDatabase { name, url, admin };
    scratch
        .connect()
        .await
        .batch_execute(SCHEMA)
        .await
        .unwrap_or_else(|error| panic!("install schema into {}: {error:?}", scratch.name));
    report(&format!("{test}: running against scratch database {}", scratch.name));
    Some(scratch)
}

/// Drop `name`, waiting out short-lived sessions the test role does not own.
///
/// `WITH (FORCE)` signals every connected role, which the local test role cannot do. Terminate
/// only this role's sessions first, since a test's own connections cannot close while its runtime
/// is blocked in the guard's destructor. Retry while foreign sessions such as autovacuum finish.
async fn drop_database(client: &Client, name: &str) -> Result<(), tokio_postgres::Error> {
    let statement = format!("DROP DATABASE IF EXISTS {}", quote(name));
    let mut attempt = 1;
    loop {
        client
            .execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity \
                 WHERE datname = $1 AND usename = current_user AND pid <> pg_backend_pid()",
                &[&name],
            )
            .await?;
        match client.batch_execute(&statement).await {
            Err(error)
                if attempt < DROP_ATTEMPTS && error.code() == Some(&SqlState::OBJECT_IN_USE) =>
            {
                tokio::time::sleep(DROP_RETRY).await;
                attempt += 1;
            }
            outcome => return outcome,
        }
    }
}

fn database_required() -> bool {
    set("CI") || set("WORKHORSE_REQUIRE_DATABASE")
}

/// Whether the environment variable `key` is set to a value other than empty, `0`, or `false`.
fn set(key: &str) -> bool {
    env::var(key).is_ok_and(|value| !matches!(value.as_str(), "" | "0" | "false"))
}

async fn connect(config: &Config) -> Client {
    let mut config = config.clone();
    config.connect_timeout(CONNECT_TIMEOUT);
    let (client, connection) = config.connect(NoTls).await.unwrap_or_else(|error| {
        panic!("PostgreSQL is unreachable at {:?}: {error:?}", config.get_hosts())
    });
    tokio::spawn(connection);
    client
}

/// `<source>_rs_<digest>`, the scratch shape `pnpm db:sweep` recognizes, within 63 bytes.
fn scratch_name(source: &str, test: &str, process: u32) -> String {
    let mut hasher = DefaultHasher::new();
    (test, process).hash(&mut hasher);
    let digest = format!("{:016x}", hasher.finish());
    let prefix: String = source.chars().take(44).collect();
    format!("{prefix}_rs_{}", &digest[..10])
}

fn replace_database(url: &str, database: &str) -> String {
    let (base, query) =
        url.split_once('?').map_or((url, None), |(base, query)| (base, Some(query)));
    let authority = base.find("://").map_or(0, |index| index + 3);
    let path = base[authority..].find('/').map_or(base.len(), |index| authority + index);
    let mut replaced = format!("{}/{database}", &base[..path]);
    if let Some(query) = query {
        replaced.push('?');
        replaced.push_str(query);
    }
    replaced
}

fn quote(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

/// Write past the test harness's output capture, so skips and scratch names reach the log.
fn report(message: &str) {
    let _ = writeln!(std::io::stderr(), "[workhorse rust db] {message}");
}

/// A polling worker over `database` that claims from `queue`, for driving handlers with `run_once`.
pub fn worker(database: &ScratchDatabase, queue: &str) -> workhorse::Worker {
    let manager = deadpool_postgres::Manager::new(database.url().parse().unwrap(), NoTls);
    let pool = deadpool_postgres::Pool::builder(manager).max_size(6).build().unwrap();
    let options = workhorse::WorkerOptions {
        queues: vec![queue.into()],
        worker_id: Some(format!("rust-test-{}", uuid::Uuid::new_v4())),
        polling_only: true,
        poll_interval: Some(Duration::from_millis(20)),
        ..workhorse::WorkerOptions::default()
    };
    workhorse::Worker::new(pool, options).unwrap()
}

/// Connection settings for `database` through a TCP proxy that delays each chunk from the client
/// to PostgreSQL by `delay`. The chunks keep their order, and the answers of PostgreSQL pass at
/// once. Thus PostgreSQL sees an idle gap of `delay` before each statement, and each round trip
/// takes `delay` longer. The proxy runs until the test runtime ends.
pub async fn delaying_proxy(database: &ScratchDatabase, delay: Duration) -> Config {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let upstream: Config = database.url().parse().expect("scratch database URL");
    let Host::Tcp(host) = &upstream.get_hosts()[0] else {
        panic!("the test database must be reachable over TCP");
    };
    let address = (host.clone(), upstream.get_ports()[0]);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut config = Config::new();
    config.host("127.0.0.1").port(listener.local_addr().unwrap().port());
    config.user(upstream.get_user().expect("scratch database user"));
    config.dbname(upstream.get_dbname().expect("scratch database name"));
    if let Some(password) = upstream.get_password() {
        config.password(password);
    }
    tokio::spawn(async move {
        while let Ok((client, _)) = listener.accept().await {
            let address = address.clone();
            tokio::spawn(async move {
                let Ok(server) = tokio::net::TcpStream::connect(address).await else { return };
                let _ = client.set_nodelay(true);
                let _ = server.set_nodelay(true);
                let (mut client_reader, mut client_writer) = client.into_split();
                let (mut server_reader, mut server_writer) = server.into_split();
                tokio::spawn(async move {
                    let _ = tokio::io::copy(&mut server_reader, &mut client_writer).await;
                });
                let (chunks, mut delayed) =
                    tokio::sync::mpsc::unbounded_channel::<(tokio::time::Instant, Vec<u8>)>();
                tokio::spawn(async move {
                    while let Some((due, chunk)) = delayed.recv().await {
                        tokio::time::sleep_until(due).await;
                        if server_writer.write_all(&chunk).await.is_err() {
                            return;
                        }
                    }
                });
                let mut buffer = vec![0; 16 * 1024];
                loop {
                    let read = match client_reader.read(&mut buffer).await {
                        Ok(0) | Err(_) => return,
                        Ok(read) => read,
                    };
                    let due = tokio::time::Instant::now() + delay;
                    if chunks.send((due, buffer[..read].to_vec())).is_err() {
                        return;
                    }
                }
            });
        }
    });
    config
}
