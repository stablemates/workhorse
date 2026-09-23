//! The `LISTEN workhorse_tasks` connection that wakes an idle worker early.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use tokio::sync::Notify;
use tokio_postgres::{AsyncMessage, NoTls};
use tokio_util::sync::CancellationToken;

const LISTEN: &str = "LISTEN workhorse_tasks";
const UNLISTEN: &str = "UNLISTEN workhorse_tasks";
const RECONNECT_INITIAL: Duration = Duration::from_millis(100);
const RECONNECT_MAXIMUM: Duration = Duration::from_secs(5);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(1);

/// Listens until `stop` fires, waking the worker for a matching queue or the `*` wildcard.
///
/// A pool cannot hand out a connection's notification stream, so the listener opens its own
/// connection from `config`. It reconnects with a doubling delay after a failure.
pub(super) async fn listen(
    config: tokio_postgres::Config,
    queues: Vec<String>,
    wake: Arc<Notify>,
    listening: Arc<AtomicBool>,
    stop: CancellationToken,
) {
    let mut delay = RECONNECT_INITIAL;
    while !stop.is_cancelled() {
        let error = match config.connect(NoTls).await {
            Err(error) => error.to_string(),
            Ok((client, mut connection)) => {
                let (sender, mut received) = tokio::sync::mpsc::unbounded_channel();
                let driver = tokio::spawn(async move {
                    let mut messages = futures_util::stream::poll_fn(move |context| {
                        connection.poll_message(context)
                    });
                    while let Some(message) = messages.next().await {
                        match message {
                            Ok(AsyncMessage::Notification(notification)) => {
                                let _ = sender.send(Ok(notification.payload().to_owned()));
                            }
                            Ok(_) => {}
                            Err(error) => {
                                let _ = sender.send(Err(error.to_string()));
                                return;
                            }
                        }
                    }
                    let _ = sender.send(Err("notification connection closed".into()));
                });
                let error = match client.batch_execute(LISTEN).await {
                    Err(error) => error.to_string(),
                    Ok(()) => {
                        listening.store(true, Ordering::SeqCst);
                        delay = RECONNECT_INITIAL;
                        wake.notify_one();
                        loop {
                            tokio::select! {
                                () = stop.cancelled() => break String::new(),
                                message = received.recv() => match message {
                                    Some(Ok(payload)) if payload == "*" || queues.contains(&payload) => wake.notify_one(),
                                    Some(Ok(_)) => {}
                                    Some(Err(error)) => break error,
                                    None => break "notification connection closed".into(),
                                },
                            }
                        }
                    }
                };
                listening.store(false, Ordering::SeqCst);
                if stop.is_cancelled() {
                    if let Ok(Err(error)) =
                        tokio::time::timeout(CLEANUP_TIMEOUT, client.batch_execute(UNLISTEN)).await
                    {
                        tracing::warn!(error = %error, "task notification listener stopped");
                    }
                }
                driver.abort();
                error
            }
        };
        if stop.is_cancelled() {
            return;
        }
        tracing::warn!(error = %error, "task notification listener stopped");
        tokio::select! {
            () = stop.cancelled() => return,
            () = tokio::time::sleep(delay) => {}
        }
        delay = (delay * 2).min(RECONNECT_MAXIMUM);
    }
}
