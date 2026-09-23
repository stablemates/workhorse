//! Runs a worker as a standalone process until the platform asks it to stop.
use super::Worker;
use crate::Error;

/// Runs `worker` until SIGINT or SIGTERM, then drains within its shutdown grace period.
///
/// The function never exits the process. A drain that outlives the grace period returns
/// [`Error::ShutdownIncomplete`], and the caller decides the exit code.
///
/// # Errors
///
/// Returns the first error the worker reports, or a signal handler installation failure.
pub async fn run_worker_process(worker: &Worker) -> Result<(), Error> {
    let signal = termination()?;
    worker.run(signal).await
}

#[cfg(unix)]
fn termination() -> Result<impl std::future::Future<Output = ()> + Send, Error> {
    use tokio::signal::unix::{signal, SignalKind};
    let install = |kind| {
        signal(kind).map_err(|error| Error::invalid(format!("install signal handler: {error}")))
    };
    let mut interrupt = install(SignalKind::interrupt())?;
    let mut terminate = install(SignalKind::terminate())?;
    Ok(async move {
        tokio::select! {
            _ = interrupt.recv() => tracing::info!("Received SIGINT; stopping claims and draining active tasks"),
            _ = terminate.recv() => tracing::info!("Received SIGTERM; stopping claims and draining active tasks"),
        }
    })
}

#[cfg(not(unix))]
fn termination() -> Result<impl std::future::Future<Output = ()> + Send, Error> {
    Ok(async {
        if tokio::signal::ctrl_c().await.is_ok() {
            tracing::info!("Received Ctrl-C; stopping claims and draining active tasks");
        }
    })
}
