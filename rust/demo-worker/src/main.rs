use tokio::sync::watch;
use workhorse_demo_worker::{
    build_worker, connection_pool, poll_interval, wait_for_schema, waits_for_schema, worker_id,
};

/// Resolves once SIGINT or SIGTERM arrives, for as many waiters as subscribe.
fn termination() -> std::io::Result<watch::Receiver<bool>> {
    use tokio::signal::unix::{signal, SignalKind};
    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut terminate = signal(SignalKind::terminate())?;
    let (sender, receiver) = watch::channel(false);
    tokio::spawn(async move {
        tokio::select! {
            _ = interrupt.recv() => tracing::info!("Received SIGINT; stopping claims and draining active tasks"),
            _ = terminate.recv() => tracing::info!("Received SIGTERM; stopping claims and draining active tasks"),
        }
        let _ = sender.send(true);
    });
    Ok(receiver)
}

async fn signalled(mut receiver: watch::Receiver<bool>) {
    let _ = receiver.wait_for(|stopped| *stopped).await;
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt().with_ansi(false).with_target(false).init();
    let stop = termination()?;

    let url = std::env::var("DATABASE_URL_PRIMARY")
        .ok()
        .filter(|value| !value.is_empty())
        .ok_or("DATABASE_URL_PRIMARY is required")?;
    let poll = poll_interval(std::env::var("WORKHORSE_WORKER_POLL_MS").ok().as_deref())?;
    let waits = waits_for_schema(std::env::var("WORKHORSE_DEMO_MODE").ok().as_deref())?;
    let pool = connection_pool(&url)?;
    let worker = build_worker(pool.clone(), worker_id(), poll, Some(url.parse()?))?;

    if waits && !wait_for_schema(&pool, signalled(stop.clone())).await? {
        return Ok(());
    }
    worker.run(signalled(stop)).await?;
    Ok(())
}
