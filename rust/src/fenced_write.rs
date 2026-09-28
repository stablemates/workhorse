//! Sends a fenced write again when PostgreSQL chose it as a deadlock victim.
//!
//! Settling a task resolves its dependents inside the same statement, and the resolver locks each
//! level of that cascade only when it reaches it. Two settlements whose cascades meet at different
//! levels can therefore wait on each other, and PostgreSQL then raises 40P01 in one of them.
use std::future::Future;

use tokio_postgres::types::ToSql;
use tokio_postgres::Row;

use crate::{Error, Executor};

/// How many times a fenced write is sent in total when PostgreSQL keeps choosing it as a deadlock
/// victim.
///
/// The concurrency policy sync is sent through the same helper. Its prune can deadlock with a
/// release over several capped queues, and a resend writes the same complete desired set.
const FENCED_WRITE_DEADLOCK_ATTEMPTS: usize = 3;

const DEADLOCK_DETECTED: &str = "40P01";
const IN_FAILED_SQL_TRANSACTION: &str = "25P02";

/// Sends a fenced write, and sends it again after a deadlock.
///
/// PostgreSQL rolls back the whole statement, so nothing in it committed, and the fence decides
/// again whether a resend may still act. A caller-owned transaction is aborted by the deadlock, so
/// a resend there fails with 25P02, and the caller gets the original deadlock instead.
pub(crate) async fn fenced_rows<E: Executor + ?Sized>(
    executor: &E,
    statement: &str,
    params: &[&(dyn ToSql + Sync)],
) -> Result<Vec<Row>, Error> {
    resend_deadlocks(|| executor.rows(statement, params), Error::sqlstate).await
}

async fn resend_deadlocks<T, Er, F, Fut>(
    mut send: F,
    sqlstate: impl Fn(&Er) -> Option<&str>,
) -> Result<T, Er>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, Er>>,
{
    let mut deadlock = None;
    for attempt in 1.. {
        let error = match send().await {
            Ok(value) => return Ok(value),
            Err(error) => error,
        };
        let code = sqlstate(&error);
        if let Some(deadlock) = deadlock.take().filter(|_| code == Some(IN_FAILED_SQL_TRANSACTION))
        {
            return Err(deadlock);
        }
        if attempt >= FENCED_WRITE_DEADLOCK_ATTEMPTS || code != Some(DEADLOCK_DETECTED) {
            return Err(error);
        }
        deadlock = Some(error);
    }
    unreachable!("the attempt counter is unbounded")
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::VecDeque;

    use super::*;

    /// Runs the retry against scripted outcomes, each an error SQLSTATE or `None` for success,
    /// and returns the result and how many statements were sent.
    async fn script(outcomes: &[Option<&'static str>]) -> (Result<(), String>, usize) {
        let pending = RefCell::new(outcomes.iter().copied().collect::<VecDeque<_>>());
        let sent = RefCell::new(0);
        let result = resend_deadlocks(
            || {
                *sent.borrow_mut() += 1;
                let outcome = pending.borrow_mut().pop_front().expect("scripted outcome");
                let attempt = *sent.borrow();
                async move {
                    match outcome {
                        None => Ok(()),
                        Some(code) => Err(format!("{code}#{attempt}")),
                    }
                }
            },
            |error: &String| error.split('#').next(),
        )
        .await;
        let sent = *sent.borrow();
        (result, sent)
    }

    #[tokio::test]
    async fn resends_a_deadlock_victim_until_it_succeeds() {
        let (result, sent) = script(&[Some("40P01"), Some("40P01"), None]).await;
        assert_eq!(result, Ok(()));
        assert_eq!(sent, FENCED_WRITE_DEADLOCK_ATTEMPTS);
    }

    #[tokio::test]
    async fn returns_the_last_deadlock_after_every_attempt() {
        let (result, sent) = script(&[Some("40P01"), Some("40P01"), Some("40P01")]).await;
        assert_eq!(result, Err("40P01#3".to_owned()));
        assert_eq!(sent, FENCED_WRITE_DEADLOCK_ATTEMPTS);
    }

    #[tokio::test]
    async fn returns_the_original_deadlock_when_the_transaction_aborted() {
        let (result, sent) = script(&[Some("40P01"), Some("25P02")]).await;
        assert_eq!(result, Err("40P01#1".to_owned()));
        assert_eq!(sent, 2);
    }

    #[tokio::test]
    async fn sends_any_other_error_once() {
        for code in ["40001", "25P02", "P1007"] {
            let (result, sent) = script(&[Some(code)]).await;
            assert_eq!(result, Err(format!("{code}#1")));
            assert_eq!(sent, 1);
        }
    }
}
