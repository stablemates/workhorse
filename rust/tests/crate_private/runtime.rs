//! The `runtime` fixtures whose executors read worker state that the crate keeps private.
//!
//! `heartbeat-cadence` holds a heartbeat round inside the worker, because PostgreSQL ends a held
//! statement by the deadline of its round. `subscription-recovery` reads the empty wait of the
//! dispatch loop. The protocol conformance runner records both kinds as `Outcome::InCrate`.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};
use tokio_postgres::Client;

use crate::{Worker, WorkerOptions};

use super::conformance::ledger::Outcome;
use super::conformance::runtime::{
    assert_state, bounded, check, driver, eventually, eventually_within, lease_options, millis,
    number, options, queue, record_claims, run, scratch, sql, text, unset, worker, Checked,
    CRATE_PRIVATE_KINDS,
};
use super::support::ScratchDatabase;

/// Counts the heartbeat rounds that start while one is in flight, and how many run at once.
struct RoundCounts {
    calls: AtomicUsize,
    active: AtomicUsize,
    most_active: AtomicUsize,
}

/// Ends one counted round.
struct ActiveRound(Arc<RoundCounts>);

impl Drop for ActiveRound {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Holds the first heartbeat round in the worker, so a second round could only start
/// concurrently. PostgreSQL ends a held statement by the deadline of its round, so the hold must
/// be in the worker, as the Go runner holds the round in its driver.
async fn heartbeat_cadence(database: &ScratchDatabase, fixture: &Value) -> Checked {
    let client = database.connect().await;
    let heartbeat = number(fixture, "heartbeatMs");
    let queue = queue(database, fixture).await?;
    let task_type = text(fixture, "taskType");
    let task = queue.enqueue(task_type, &json!({}), Default::default()).await.map_err(driver)?;
    let worker = worker(database, 4, lease_options(fixture))?;
    let counts = Arc::new(RoundCounts {
        calls: AtomicUsize::new(0),
        active: AtomicUsize::new(0),
        most_active: AtomicUsize::new(0),
    });
    let (release_first, first_released) = watch::channel(false);
    worker.hold_heartbeat_rounds_for_test({
        let counts = Arc::clone(&counts);
        move || {
            let (counts, mut released) = (Arc::clone(&counts), first_released.clone());
            async move {
                let call = counts.calls.fetch_add(1, Ordering::SeqCst) + 1;
                let active = counts.active.fetch_add(1, Ordering::SeqCst) + 1;
                counts.most_active.fetch_max(active, Ordering::SeqCst);
                let round = ActiveRound(counts);
                if call == 1 {
                    let _ = released.wait_for(|released| *released).await;
                }
                round
            }
        }
    });
    let (started, mut handler_started) = mpsc::unbounded_channel();
    let (release, released) = watch::channel(false);
    worker.handle(task_type, move |_: Value, _| {
        let (started, mut released) = (started.clone(), released.clone());
        async move {
            let _ = started.send(());
            let _ = released.wait_for(|released| *released).await;
            Ok(Value::Null)
        }
    });
    let running = {
        let worker = worker.clone();
        tokio::spawn(async move { worker.run_once().await })
    };
    handler_started.recv().await.ok_or("the handler never started")?;
    let calls = || counts.calls.load(Ordering::SeqCst) as i64;
    eventually("no heartbeat round started", || async { Ok(calls() >= 1) }).await?;
    tokio::time::sleep(Duration::from_millis(2 * heartbeat as u64)).await;
    let blocked = calls();
    let want_blocked = number(fixture, "expectedCallsWhileBlocked");
    check(blocked == want_blocked, || {
        format!("{blocked} heartbeat rounds started while one was blocked, want {want_blocked}")
    })?;
    let _ = release_first.send(true);
    let minimum = number(fixture, "expectedMinimumCallsBeforeSettlement");
    eventually("the heartbeat rounds did not resume", || async { Ok(calls() >= minimum) }).await?;
    let _ = release.send(true);
    let processed = running.await.map_err(|error| error.to_string())?.map_err(driver)?;
    check(processed, || "run_once() processed nothing".into())?;
    let concurrent = counts.most_active.load(Ordering::SeqCst) as i64;
    let maximum = number(fixture, "expectedMaximumOverlap");
    check(concurrent <= maximum, || {
        format!("{concurrent} heartbeat rounds ran at once, want at most {maximum}")
    })?;
    assert_state(&client, task.task_id, &json!({"state": "succeeded", "attempt": 1})).await
}

/// A TCP proxy to the test database that holds each connection while `release` is `false`.
/// While it holds a connection, the proxy accepts it but does not connect to PostgreSQL, so the
/// connect and the `LISTEN` cannot finish. After the release, the proxy connects to PostgreSQL and
/// copies the bytes in both directions. A change of `close` closes both sockets of each connection
/// that it copies, and `closed` then receives one message for each of them.
struct HoldingProxy {
    config: tokio_postgres::Config,
    release: watch::Sender<bool>,
    close: watch::Sender<u64>,
    closed: mpsc::UnboundedReceiver<()>,
}

async fn holding_proxy(database: &ScratchDatabase) -> Checked<HoldingProxy> {
    let upstream: tokio_postgres::Config = database.url().parse().map_err(sql)?;
    let tokio_postgres::config::Host::Tcp(host) = &upstream.get_hosts()[0] else {
        return Err("the test database must be reachable over TCP".into());
    };
    let address = (host.clone(), upstream.get_ports()[0]);
    let proxy =
        tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|error| error.to_string())?;
    let mut config = tokio_postgres::Config::new();
    config.host("127.0.0.1").port(proxy.local_addr().map_err(|error| error.to_string())?.port());
    config.user(upstream.get_user().ok_or("the test database URL names no user")?);
    config.dbname(upstream.get_dbname().ok_or("the test database URL names no database")?);
    if let Some(password) = upstream.get_password() {
        config.password(password);
    }
    let (release, released) = watch::channel(false);
    let (close, closing) = watch::channel(0_u64);
    let (closed_sender, closed) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        while let Ok((mut client, _)) = proxy.accept().await {
            let address = address.clone();
            let mut released = released.clone();
            let mut closing = closing.clone();
            let closed = closed_sender.clone();
            tokio::spawn(async move {
                if released.wait_for(|released| *released).await.is_err() {
                    return;
                }
                let Ok(mut server) = tokio::net::TcpStream::connect(address).await else { return };
                closing.borrow_and_update();
                tokio::select! {
                    _ = tokio::io::copy_bidirectional(&mut client, &mut server) => {}
                    Ok(()) = closing.changed() => {
                        drop((client, server));
                        let _ = closed.send(());
                    }
                }
            });
        }
    });
    Ok(HoldingProxy { config, release, close, closed })
}

/// The time from `earlier` to `later`, in microseconds from a shared origin.
fn gap(earlier: i64, later: i64) -> Duration {
    Duration::from_micros(u64::try_from(later - earlier).unwrap_or(0))
}

/// The shortest wait at the notification base: 5 s less its jitter of 10 %.
const NOTIFICATION_WAIT_MINIMUM: Duration = Duration::from_millis(4_500);

/// The end of the empty wait that `worker` has installed, in microseconds from the Unix epoch, if a
/// notification can end that wait. PostgreSQL runs on the clock of this host, so the value compares
/// with the times that PostgreSQL records.
fn wakeable_wait_end(worker: &Worker) -> Option<i64> {
    let (deadline, wakeable) = worker.empty_wait_for_test()?;
    if !wakeable {
        return None;
    }
    // The wall clock is read first, so a pause between the two reads makes the end earlier, not
    // later. An earlier end can only make the checks stricter.
    let wall = SystemTime::now();
    let now = std::time::Instant::now();
    let end = if deadline >= now { wall + (deadline - now) } else { wall - (now - deadline) };
    i64::try_from(end.duration_since(UNIX_EPOCH).ok()?.as_micros()).ok()
}

/// The bounds after the loss start at events that the runner controls, not at the moment the
/// runner sees them. A loaded runner sees an event late, and the worker's backoff grows in that
/// time. A late observation would thus charge the runner's delay to the worker.
async fn subscription_recovery(database: &ScratchDatabase, fixture: &Value) -> Checked {
    let client = database.connect().await;
    record_claims(&client, false).await?;
    let queue = queue(database, fixture).await?;
    let task_type = text(fixture, "taskType");
    // The worker can listen, but the proxy holds its LISTEN until the test releases it. Until
    // then the worker has no live subscription.
    let HoldingProxy { config: listen_config, release, close, mut closed } =
        holding_proxy(database).await?;
    // The pool has more than one connection and the worker has a listen_config, so the worker
    // expects a listener. The worker has no explicit poll interval.
    let worker = worker(
        database,
        8,
        WorkerOptions {
            concurrency: 1,
            polling_only: false,
            poll_interval: None,
            listen_config: Some(listen_config),
            ..options(fixture)
        },
    )?;
    let (ran, mut handled) = mpsc::unbounded_channel();
    worker.handle(task_type, move |payload: Value, _| {
        let _ = ran.send(payload["task"].as_str().unwrap_or_default().to_owned());
        async { Ok(Value::Null) }
    });
    let (stop, running) = run(&worker);
    let observed = async {
        eventually("the worker made no empty claim before the first enqueue", || async {
            let row = client
                .query_one(
                    "SELECT count(*) FROM workhorse.runtime_poll_claims WHERE NOT found",
                    &[],
                )
                .await
                .map_err(sql)?;
            Ok(row.get::<_, i64>(0) > 0)
        })
        .await?;
        for (task, timeout) in [("first", 5), ("second", 7)] {
            if task == "second" {
                let _ = release.send(true);
                eventually("the listener did not run LISTEN", || async {
                    let row = client
                        .query_one(
                            "SELECT count(*) FROM pg_stat_activity
                              WHERE datname = current_database()
                                AND query = 'LISTEN workhorse_tasks' AND state = 'idle'",
                            &[],
                        )
                        .await
                        .map_err(sql)?;
                    Ok(row.get::<_, i64>(0) > 0)
                })
                .await?;
            }
            queue
                .enqueue(task_type, &json!({ "task": task }), Default::default())
                .await
                .map_err(driver)?;
            let ran = tokio::time::timeout(Duration::from_secs(timeout), handled.recv())
                .await
                .map_err(|_| format!("the worker did not run the {task} task"))?
                .ok_or("the handler channel closed")?;
            check(ran == task, || format!("the worker ran task {ran}, want {task}"))?;
        }
        tokio::time::sleep(millis(fixture, "observeAfterRecoveryMs")).await;
        // The claims recorded until now belong to the live period. Each time is in microseconds
        // on the clock of PostgreSQL, which records the claims.
        let now = "(extract(epoch FROM clock_timestamp()) * 1000000)::bigint";
        let recovery_end: i64 =
            client.query_one(&format!("SELECT {now}"), &[]).await.map_err(sql)?.get(0);

        // The next empty claim starts a new wait at the notification base. Then the proxy closes
        // the live listener connection and holds the next one, so the subscription is lost. The
        // runner first waits until the worker has installed that wait. A loss before that moment
        // gives the polling base without a wake.
        eventually_within(
            Duration::from_secs(7),
            "the worker made no empty claim after the second task",
            || async {
                let row = client
                    .query_one(
                        "SELECT count(*) FROM workhorse.runtime_poll_claims
                          WHERE NOT found
                            AND (extract(epoch FROM finished) * 1000000)::bigint > $1",
                        &[&recovery_end],
                    )
                    .await
                    .map_err(sql)?;
                Ok(row.get::<_, i64>(0) > 0)
            },
        )
        .await?;
        let empty_end: i64 = client
            .query_one(
                "SELECT (extract(epoch FROM finished) * 1000000)::bigint
                   FROM workhorse.runtime_poll_claims
                  WHERE NOT found AND (extract(epoch FROM finished) * 1000000)::bigint > $1
                  ORDER BY finished LIMIT 1",
                &[&recovery_end],
            )
            .await
            .map_err(sql)?
            .get(0);
        let notification_wait =
            i64::try_from(NOTIFICATION_WAIT_MINIMUM.as_micros()).unwrap_or(i64::MAX);
        eventually_within(
            Duration::from_secs(7),
            "the worker did not wait at the notification base after the second task",
            || async {
                Ok(wakeable_wait_end(&worker)
                    .is_some_and(|end| end - empty_end >= notification_wait))
            },
        )
        .await?;
        let _ = release.send(false);
        // The loss starts when the proxy closes the connection. From that moment the wrapper holds
        // each empty claim. The first one is the claim that the loss wakes, so the worker cannot
        // advance its backoff before the runner enqueues the third task.
        let wait_end = wakeable_wait_end(&worker);
        let lost_at: i64 = client
            .query_one(
                &format!(
                    "UPDATE workhorse.runtime_poll_control SET hold_claims = true RETURNING {now}"
                ),
                &[],
            )
            .await
            .map_err(sql)?
            .get(0);
        close.send_modify(|generation| *generation += 1);
        tokio::time::timeout(Duration::from_secs(7), closed.recv())
            .await
            .map_err(|_| "the proxy did not close the listener connection")?
            .ok_or("the proxy stopped")?;
        eventually_within(
            Duration::from_secs(7),
            "the worker made no claim after the subscription was lost",
            || async {
                let row = client
                    .query_one("SELECT is_called FROM workhorse.runtime_poll_reached", &[])
                    .await
                    .map_err(sql)?;
                Ok(row.get::<_, bool>(0))
            },
        )
        .await?;
        let enqueued_after_loss: i64 =
            client.query_one(&format!("SELECT {now}"), &[]).await.map_err(sql)?.get(0);
        queue
            .enqueue(task_type, &json!({ "task": "third" }), Default::default())
            .await
            .map_err(driver)?;
        release_claims(&client).await?;
        let ran = tokio::time::timeout(Duration::from_secs(7), handled.recv())
            .await
            .map_err(|_| "the worker did not run the third task")?
            .ok_or("the handler channel closed")?;
        check(ran == "third", || format!("the worker ran task {ran}, want third"))?;
        // Each claim's start and end, in microseconds, and whether it found a task.
        let rows = client
            .query(
                "SELECT (extract(epoch FROM started) * 1000000)::bigint,
                        (extract(epoch FROM finished) * 1000000)::bigint,
                        found
                   FROM workhorse.runtime_poll_claims ORDER BY started",
                &[],
            )
            .await
            .map_err(sql)?;
        let claims = rows
            .iter()
            .map(|row| (row.get::<_, i64>(0), row.get::<_, i64>(1), row.get::<_, bool>(2)))
            .collect::<Vec<_>>();
        Ok::<_, String>((claims, recovery_end, lost_at, wait_end, enqueued_after_loss))
    }
    .await;
    // A failure above must not leave the LISTEN or a claim held, or the worker running.
    let _ = release.send(true);
    let _ = release_claims(&client).await;
    let _ = stop.send(());
    let stopped = running.await.map_err(|error| error.to_string());
    let (claims, recovery_end, lost_at, wait_end, enqueued_after_loss) = observed?;
    stopped?.map_err(driver)?;

    let found: Vec<usize> = (0..claims.len()).filter(|&index| claims[index].2).collect();
    check(found.len() == 3, || format!("{} claims found a task, want 3", found.len()))?;
    let (first, third) = (found[0], found[2]);
    check(first > 0, || "no empty claim came before the claim that found the first task".into())?;
    // Without a live subscription, the worker polls at the polling-only base.
    let waited = gap(claims[first - 1].1, claims[first].0);
    let maximum = millis(fixture, "expectedMaximumClaimDelayMs");
    check(waited <= maximum, || {
        format!("the claim that found the first task waited {waited:?} without a live subscription, want at most {maximum:?}")
    })?;
    // With a live subscription, the worker waits the notification base after an empty claim.
    // Only the claims recorded before the loss count, from the last one that found a task.
    let recovered: Vec<_> = claims.iter().filter(|claim| claim.1 <= recovery_end).collect();
    let second = recovered.iter().rposition(|claim| claim.2).unwrap_or(0);
    let empty = recovered[second..].iter().filter(|claim| !claim.2).count() as i64;
    let maximum = number(fixture, "expectedMaximumEmptyClaimsAfterRecovery");
    check(empty <= maximum, || {
        format!("{empty} empty claims after the second task with a live subscription, want at most {maximum}")
    })?;
    // After the loss, the worker claims at once and then polls at the polling-only base again.
    let maximum = millis(fixture, "expectedMaximumClaimDelayAfterLossMs");
    let woken = claims
        .iter()
        .position(|claim| claim.0 >= lost_at)
        .ok_or("no claim started after the subscription was lost")?;
    check(woken > 0, || "no claim after the subscription was lost had a claim before it".into())?;
    let waited = gap(lost_at, claims[woken].0);
    check(waited <= maximum, || {
        format!("the first claim after the subscription was lost waited {waited:?}, want at most {maximum:?}")
    })?;
    // When the runner ended the session, the claim before the woken one had installed a wait at
    // the notification base. The woken claim started before that wait ended, so the loss started it.
    let before = claims[woken - 1];
    let wait_end = wait_end.ok_or("the worker had no empty-claim wait when the session ended")?;
    check(gap(before.1, wait_end) >= NOTIFICATION_WAIT_MINIMUM, || {
        "the claim before the loss did not install a wait at the notification base".into()
    })?;
    check(claims[woken].0 < wait_end, || {
        "the first claim after the subscription was lost started when the wait ended, so the wait, not the loss, started it".into()
    })?;
    let waited = gap(enqueued_after_loss, claims[third].0);
    check(waited <= maximum, || {
        format!("the claim that found the third task waited {waited:?} after the subscription was lost, want at most {maximum:?}")
    })?;
    Ok(())
}

/// Turns the hold of `record_claims` off and releases a held claim.
async fn release_claims(client: &Client) -> Checked {
    client
        .batch_execute(
            "UPDATE workhorse.runtime_poll_control SET hold_claims = false;
             SELECT nextval('workhorse.runtime_poll_released');",
        )
        .await
        .map_err(sql)
}

/// Runs one fixture of a kind in `CRATE_PRIVATE_KINDS`.
async fn run_crate_private(fixture: &Value) -> Outcome {
    let kind = text(fixture, "kind");
    let name = format!("runtime_{}", text(fixture, "id"));
    let Some(database) = scratch(&name).await else { return unset() };
    let database = &database;
    let executor = async move {
        match kind {
            "heartbeat-cadence" => heartbeat_cadence(database, fixture).await,
            "subscription-recovery" => subscription_recovery(database, fixture).await,
            other => Err(format!("runtime kind {other} does not read private worker state")),
        }
    };
    bounded(&name, executor).await
}

#[tokio::test(flavor = "multi_thread")]
async fn every_runtime_fixture_that_reads_private_worker_state_passes() {
    let path = super::conformance::database::repository().join("protocol/v1/runtime.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    let fixtures: Vec<Value> =
        serde_json::from_str(&text).expect("runtime.json is a fixture array");
    let mut ran = Vec::new();
    let mut problems = Vec::new();
    for fixture in &fixtures {
        let kind = fixture["kind"].as_str().unwrap_or_default();
        if !CRATE_PRIVATE_KINDS.contains(&kind) {
            continue;
        }
        let id = fixture["id"].as_str().unwrap_or_default();
        ran.push(kind);
        match run_crate_private(fixture).await {
            Outcome::Passed | Outcome::Skipped(_) => {}
            outcome => problems.push(format!("runtime/{id}: {outcome:?}")),
        }
    }
    for kind in CRATE_PRIVATE_KINDS {
        if !ran.contains(kind) {
            problems.push(format!("runtime.json declares no fixture of kind {kind}"));
        }
    }
    assert!(problems.is_empty(), "runtime fixtures failed:\n  {}", problems.join("\n  "));
}
