//! Supervising one handler and settling its task under the claim's fence.
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use futures_util::future::BoxFuture;
use futures_util::FutureExt;
use serde_json::{json, Value};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken as StopToken;
use tracing::Instrument;

use super::handler::{ErasedHandler, HandlerResult};
use super::heartbeat::Beat;
use super::value_size::jsonb_text_bytes;
use super::{exactly_one, lock, millis_i32, sql, ActiveSlot, Inner, OwnershipStatus};
use crate::fenced_write::fenced_rows;
use crate::telemetry::{self, Attribute, Counter, Histogram};
use crate::{
    CancelReason, CancellationToken, ClaimedTask, Error, Executor, HandlerContext, HandlerError,
    Operation,
};

/// How often, and for how long, an expiration PostgreSQL reports as not yet due is retried after
/// the handler returned.
const EXPIRATION_RETRY: Duration = Duration::from_millis(5);
const EXPIRATION_BUDGET: Duration = Duration::from_secs(1);
/// The longest wait between two expiration requests while the handler runs.
const EXPIRATION_RETRY_MAXIMUM: Duration = Duration::from_secs(1);
/// How far past a deadline the local timer fires, so PostgreSQL's clock agrees it has passed.
const EXPIRATION_SKEW: Duration = Duration::from_millis(1);

/// The `handler.outcome` attribute, and the settlement one execution reached.
type Outcome = &'static str;

fn instant_at(at: DateTime<Utc>) -> Instant {
    Instant::now() + (at - Utc::now()).to_std().unwrap_or_default() + EXPIRATION_SKEW
}

/// The earlier of the task deadline and the attempt timeout, on the worker clock. It only starts a
/// question to PostgreSQL, which decides whether the expiry is due.
fn expiration(task: &ClaimedTask) -> Option<Instant> {
    [task.deadline_at, task.attempt_timeout_at].into_iter().flatten().min().map(instant_at)
}

/// Whether an `expire_owned` answer decides the attempt. `not_due` and `accepted` leave it running.
fn decides(status: OwnershipStatus) -> bool {
    !matches!(status, OwnershipStatus::NotDue | OwnershipStatus::Accepted)
}

fn cancel_reason(status: OwnershipStatus) -> CancelReason {
    match status {
        OwnershipStatus::CancelRequested => CancelReason::Requested,
        OwnershipStatus::DeadlineExceeded => CancelReason::DeadlineExceeded,
        OwnershipStatus::TimeoutExceeded => CancelReason::ExecutionTimeout,
        _ => CancelReason::LeaseLost,
    }
}

impl Inner {
    /// Runs `handler` for `task` while its lease holds, then settles the task exactly once.
    ///
    /// A lost lease is recorded, not settled: lease recovery owns the task from then on.
    pub(super) async fn execute(
        self: &Arc<Self>,
        task: ClaimedTask,
        handler: ErasedHandler,
        shutdown: StopToken,
        slot: Option<&ActiveSlot>,
    ) -> Result<(), Error> {
        let started = Instant::now();
        let span = telemetry::handler_span(&task);
        tracing::debug!(
            parent: &span,
            event.name = "workhorse.handler.started",
            workhorse.worker.id = %self.worker_id,
            "Handler started"
        );
        let task = Arc::new(task);
        // The first lease window runs from the claim. Only an accepted renewal moves it: a busy
        // round leaves it as it was.
        let lease = self.options.lease_duration;
        let mut membership =
            self.register_heartbeat(task.id, task.fence_token, task.claim_sent_at + lease);
        let token = CancellationToken::default();
        let context = HandlerContext::new(
            Arc::clone(&task),
            token.clone(),
            self.pool.clone(),
            self.statement_checkout(),
            self.worker_id.clone(),
        );
        let future = AssertUnwindSafe(handler(task.payload.clone(), context.clone()))
            .catch_unwind()
            .instrument(span.clone());
        tokio::pin!(future);

        let watchdog = tokio::time::sleep_until(task.claim_sent_at + lease);
        tokio::pin!(watchdog);
        let mut watchdog_armed = true;
        let expires = expiration(&task);
        let expiry = tokio::time::sleep_until(expires.unwrap_or_else(Instant::now));
        tokio::pin!(expiry);
        let mut expired: Option<Result<OwnershipStatus, Error>> = None;
        let mut rejected: Option<OwnershipStatus> = None;
        let mut beats_open = true;
        // One expire_owned request at a time runs beside the handler, so renewals, the watchdog,
        // and heartbeat verdicts keep their effect while PostgreSQL answers. The handler is
        // cancelled only for an answer that decides the attempt.
        let mut expiring: Option<BoxFuture<'_, Result<OwnershipStatus, Error>>> = None;
        let mut expiration_retry = EXPIRATION_RETRY;
        // A stale heartbeat answer during a request can come from that expiry itself, so the
        // expiry answer decides first.
        let mut stale_beat = false;
        let result = loop {
            tokio::select! {
                result = &mut future => break result,
                () = &mut watchdog, if watchdog_armed => {
                    // No renewal was accepted within the lease, so another worker may own the task.
                    // A handler that ignores its token must not keep the lease alive.
                    watchdog_armed = false;
                    rejected.get_or_insert(OwnershipStatus::Stale);
                    token.cancel(CancelReason::LeaseLost);
                    membership.leave();
                    tracing::warn!(
                        parent: &span,
                        event.name = "workhorse.task.lease_expired",
                        workhorse.worker.id = %self.worker_id,
                        "No heartbeat was accepted within the task lease"
                    );
                }
                () = &mut expiry, if expires.is_some() && expired.is_none() && expiring.is_none()
                    && rejected.is_none() => {
                    expiring = Some(Box::pin(self.expire_owned_once(&task)));
                }
                answer = async { expiring.as_mut().expect("the guard checks it").await },
                    if expiring.is_some() => {
                    expiring = None;
                    match answer {
                        Ok(status) if decides(status) => {
                            token.cancel(cancel_reason(status));
                            membership.leave();
                            watchdog_armed = false;
                            expired = Some(Ok(status));
                        }
                        _ if stale_beat => {
                            rejected.get_or_insert(OwnershipStatus::Stale);
                            watchdog_armed = false;
                            token.cancel(CancelReason::LeaseLost);
                        }
                        answer => {
                            // not_due is the database refusing an expiry its clock has not
                            // reached, and a failed request proves nothing. The handler keeps
                            // running and renewing, and the worker asks again after a backoff.
                            if let Err(error) = answer {
                                tracing::warn!(
                                    parent: &span,
                                    workhorse.worker.id = %self.worker_id,
                                    error = %error,
                                    "Ownership expiration request failed; the worker asks again"
                                );
                            }
                            expiry.as_mut().reset(Instant::now() + expiration_retry);
                            expiration_retry = (expiration_retry * 2).min(EXPIRATION_RETRY_MAXIMUM);
                        }
                    }
                }
                beat = membership.beats.recv(), if beats_open => match beat {
                    Some(Beat::Renewed(sent_at)) => watchdog.as_mut().reset(sent_at + lease),
                    Some(Beat::Rejected(OwnershipStatus::Stale)) if expiring.is_some() => {
                        stale_beat = true;
                        membership.leave();
                    }
                    Some(Beat::Rejected(status)) => {
                        rejected.get_or_insert(status);
                        watchdog_armed = false;
                        token.cancel(cancel_reason(status));
                    }
                    None => beats_open = false,
                },
                () = shutdown.cancelled(), if !token.is_cancelled() => token.cancel(CancelReason::Shutdown),
            }
        };
        // A handler that returned while a request was in flight waits for its answer, so a
        // confirmed expiry is not settled again. An attempt whose ownership already ended drops
        // the request. Renewals continue during the wait, and the lease watchdog bounds it, so a
        // blocked request cannot hold the attempt.
        if let Some(mut request) = expiring.take().filter(|_| rejected.is_none()) {
            loop {
                tokio::select! {
                    answer = &mut request => {
                        match answer {
                            Ok(status) if decides(status) => expired = Some(Ok(status)),
                            _ if stale_beat => {
                                rejected.get_or_insert(OwnershipStatus::Stale);
                            }
                            _ => {}
                        }
                        break;
                    }
                    () = &mut watchdog, if watchdog_armed => {
                        rejected.get_or_insert(OwnershipStatus::Stale);
                        break;
                    }
                    beat = membership.beats.recv(), if beats_open => match beat {
                        Some(Beat::Renewed(sent_at)) => watchdog.as_mut().reset(sent_at + lease),
                        Some(Beat::Rejected(OwnershipStatus::Stale)) => {
                            stale_beat = true;
                            membership.leave();
                        }
                        Some(Beat::Rejected(status)) => {
                            rejected.get_or_insert(status);
                            break;
                        }
                        None => beats_open = false,
                    },
                }
            }
        }
        drop(membership);
        let result: HandlerResult = result
            .unwrap_or_else(|panic| Err(HandlerError::from_panic(&task.task_type, false, panic)));

        // A suspending call settled the task in PostgreSQL, so the handler's return is moot.
        let settled = if context.suspended() {
            Ok("suspended")
        } else {
            self.settle(&task, result, expired, rejected, token.reason(), slot).await
        };
        let settled = match settled {
            Err(Error::LeaseLost { .. }) => Ok("lease_lost"),
            other => other,
        };
        let outcome = *settled.as_ref().unwrap_or(&"unknown");
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        let attributes = [
            ("workhorse.queue.name", Attribute::Text(&task.queue)),
            ("workhorse.task.type", Attribute::Text(&task.task_type)),
            ("workhorse.handler.outcome", Attribute::Text(outcome)),
        ];
        self.metrics.add(Counter::HandlerExecutions, 1.0, &attributes);
        // The runtime counter has no outcome, so each queue and task type is one series.
        self.metrics.add(Counter::HandlerRuntime, elapsed, &attributes[..2]);
        self.metrics.record(Histogram::HandlerDuration, elapsed, &attributes);
        if outcome != "succeeded" && outcome != "unknown" {
            span.record("otel.status_code", "error");
        }
        tracing::info!(
            parent: &span,
            event.name = "workhorse.task.execution_finished",
            workhorse.worker.id = %self.worker_id,
            workhorse.handler.outcome = outcome,
            workhorse.handler.duration_ms = elapsed,
            "Task execution finished"
        );
        tracing::debug!(parent: &span, event.name = "workhorse.handler.finished", "Handler finished");
        settled.map(drop)
    }

    async fn settle(
        self: &Arc<Self>,
        task: &ClaimedTask,
        result: HandlerResult,
        expired: Option<Result<OwnershipStatus, Error>>,
        rejected: Option<OwnershipStatus>,
        reason: Option<CancelReason>,
        slot: Option<&ActiveSlot>,
    ) -> Result<Outcome, Error> {
        let (status, already_expired) = match expired {
            Some(Err(error)) => return Err(error),
            Some(Ok(status)) => (Some(status), true),
            None => (rejected, false),
        };
        match status {
            Some(OwnershipStatus::CancelRequested) => return self.acknowledge(task).await,
            Some(OwnershipStatus::DeadlineExceeded) if already_expired => {
                return Ok("deadline_exceeded")
            }
            Some(OwnershipStatus::TimeoutExceeded) if already_expired => return Ok("timeout"),
            Some(OwnershipStatus::DeadlineExceeded | OwnershipStatus::TimeoutExceeded) => {
                return self.settle_expiration(task).await
            }
            Some(OwnershipStatus::Stale) => return Ok("lease_lost"),
            Some(OwnershipStatus::NotDue) => {
                self.warn_not_due(task);
                return Ok("lease_lost");
            }
            Some(OwnershipStatus::Accepted) | None => {}
        }
        match (reason, &result) {
            (Some(CancelReason::Requested), _) => return self.acknowledge(task).await,
            (Some(CancelReason::DeadlineExceeded | CancelReason::ExecutionTimeout), _) => {
                return self.settle_expiration(task).await
            }
            (Some(CancelReason::LeaseLost), _) => return Ok("lease_lost"),
            // A handler that stopped for shutdown returns the task to the queue without an attempt.
            // A panic still fails the attempt.
            (Some(CancelReason::Shutdown), Err(error)) if !error.is_panic() => {
                return self.release(task, false).await
            }
            _ => {}
        }
        match result {
            Ok(value) => self.complete(task, value, slot).await,
            Err(error) => self.fail_with_state(task, error).await,
        }
    }

    /// Asks PostgreSQL once to expire the task's ownership under its fence.
    async fn expire_owned_once(&self, task: &ClaimedTask) -> Result<OwnershipStatus, Error> {
        let rows = fenced_rows(
            &self.statements(),
            sql::EXPIRE_OWNED_TELEMETRY_V1,
            &[&task.id, &self.worker_id, &task.fence_token],
        )
        .await?;
        let row = exactly_one(&rows, "expire_owned_telemetry_v1")?;
        OwnershipStatus::parse(row.try_get::<_, Option<String>>("status")?.as_deref())
    }

    /// Asks PostgreSQL to expire the task's ownership after the handler returned, retrying briefly
    /// while it is not yet due.
    pub(super) async fn expire_ownership(
        &self,
        task: &ClaimedTask,
    ) -> Result<OwnershipStatus, Error> {
        let budget = Instant::now() + EXPIRATION_BUDGET;
        loop {
            let status = self.expire_owned_once(task).await?;
            if status != OwnershipStatus::NotDue || Instant::now() + EXPIRATION_RETRY > budget {
                return Ok(status);
            }
            tokio::time::sleep(EXPIRATION_RETRY).await;
        }
    }

    fn warn_not_due(&self, task: &ClaimedTask) {
        tracing::warn!(
            workhorse.task.id = %task.id,
            workhorse.worker.id = %self.worker_id,
            "PostgreSQL did not accept ownership expiration before the retry budget elapsed"
        );
    }

    async fn settle_expiration(&self, task: &ClaimedTask) -> Result<Outcome, Error> {
        match self.expire_ownership(task).await? {
            OwnershipStatus::CancelRequested => self.acknowledge(task).await,
            OwnershipStatus::DeadlineExceeded => Ok("deadline_exceeded"),
            OwnershipStatus::TimeoutExceeded => Ok("timeout"),
            OwnershipStatus::NotDue => {
                self.warn_not_due(task);
                Ok("lease_lost")
            }
            OwnershipStatus::Stale | OwnershipStatus::Accepted => {
                Err(Error::LeaseLost { task_id: task.id, operation: Operation::Heartbeat })
            }
        }
    }

    async fn acknowledge(&self, task: &ClaimedTask) -> Result<Outcome, Error> {
        let rows = fenced_rows(
            &self.statements(),
            sql::ACKNOWLEDGE_CANCEL_V1,
            &[&task.id, &self.worker_id, &task.fence_token],
        )
        .await?;
        if accepted(&rows, "acknowledge_cancel_v1")? {
            Ok("canceled")
        } else {
            Err(Error::LeaseLost { task_id: task.id, operation: Operation::Heartbeat })
        }
    }

    /// Explains a rejected settlement: a cancellation or expiration that won, or a lost lease.
    async fn reconcile(&self, task: &ClaimedTask, operation: Operation) -> Result<Outcome, Error> {
        let rows = fenced_rows(
            &self.statements(),
            sql::ACKNOWLEDGE_CANCEL_V1,
            &[&task.id, &self.worker_id, &task.fence_token],
        )
        .await?;
        if accepted(&rows, "acknowledge_cancel_v1")? {
            return Ok("canceled");
        }
        match self.expire_ownership(task).await? {
            OwnershipStatus::CancelRequested => self.acknowledge(task).await,
            OwnershipStatus::DeadlineExceeded => Ok("deadline_exceeded"),
            OwnershipStatus::TimeoutExceeded => Ok("timeout"),
            _ => Err(Error::LeaseLost { task_id: task.id, operation }),
        }
    }

    async fn complete(
        self: &Arc<Self>,
        task: &ClaimedTask,
        result: Value,
        slot: Option<&ActiveSlot>,
    ) -> Result<Outcome, Error> {
        if let Some(version) = &task.contract_version {
            if let Err(error) = self.validate_result(task, version, &result).await {
                return self.fail_with_state(task, error).await;
            }
        }
        if holds_nul(&result) {
            let message = format!(
                "{} result contains a NUL character or an unpaired surrogate, which PostgreSQL \
                 jsonb cannot store",
                task.task_type
            );
            return self.fail_with_state(task, HandlerError::new(message)).await;
        }
        if let Some(limit) = task.result_max_bytes {
            // PostgreSQL would refuse the completion, which ends the settlement rather than the
            // attempt and leaves the task active until lease recovery.
            if jsonb_text_bytes(&result) > usize::try_from(limit).unwrap_or(0) {
                let message =
                    format!("{} result exceeds its configured size limit", task.task_type);
                let error = HandlerError::named("TaskValueSizeLimitError", message);
                return self.fail_with_state(task, error).await;
            }
        }
        let accepted = if task.fast_tier {
            self.complete_fast(task, result, slot).await?
        } else {
            self.complete_full(task, &result).await?
        };
        if !accepted {
            return self.reconcile(task, Operation::Complete).await;
        }
        self.metrics.add(
            Counter::Completed,
            1.0,
            &[
                ("workhorse.queue.name", Attribute::Text(&task.queue)),
                ("workhorse.task.type", Attribute::Text(&task.task_type)),
            ],
        );
        tracing::info!(
            event.name = "workhorse.task.completed",
            workhorse.task.id = %task.id,
            workhorse.worker.id = %self.worker_id,
            "Task completed"
        );
        Ok("succeeded")
    }

    async fn complete_full(&self, task: &ClaimedTask, result: &Value) -> Result<bool, Error> {
        let rows = fenced_rows(
            &self.statements(),
            sql::COMPLETE_V1,
            &[&task.id, &self.worker_id, &task.fence_token, result],
        )
        .await?;
        accepted(&rows, "complete_v1")
    }

    /// Completes a fast-tier attempt through the batched statement, which may also claim the
    /// successors this task's slot and its cohort's free slots can run (ADR 0076, rules 3, 12
    /// and 14).
    ///
    /// A queue that left the fast tier after the claim rejects that statement, so the attempt
    /// completes through `complete_v1` instead and claims nothing.
    async fn complete_fast(
        self: &Arc<Self>,
        task: &ClaimedTask,
        result: Value,
        slot: Option<&ActiveSlot>,
    ) -> Result<bool, Error> {
        let reservation = slot.and_then(|slot| slot.ticket.reserve());
        let (limit, cohort) = reservation
            .as_ref()
            .map_or((0, 0), |reservation| (reservation.limit(), reservation.cohort()));
        match self.complete_batched(task, result.clone(), limit, cohort).await {
            Ok((accepted, claimed)) => {
                if let (Some(reservation), Some(slot)) = (reservation, slot) {
                    if reservation.settle(Some(claimed)) {
                        slot.hand_over();
                    }
                }
                Ok(accepted)
            }
            Err(Error::FastTierUnsupported { .. }) => {
                // The fused claim never ran, so it hands nothing over and backs nothing off.
                drop(reservation);
                self.complete_full(task, &result).await
            }
            Err(error) => Err(error),
        }
    }

    /// Checks a result against the task's pinned contract, caching each compiled schema.
    async fn validate_result(
        &self,
        task: &ClaimedTask,
        version: &str,
        result: &Value,
    ) -> Result<(), HandlerError> {
        // A joined string would let a separator inside a type or version collide with another pair.
        let key = (task.task_type.clone(), version.to_owned());
        let cached = lock(&self.contracts).get(&key).cloned();
        let schema = match cached {
            Some(schema) => schema,
            None => {
                let schema = self.load_result_schema(task, version).await.map_err(|error| {
                    HandlerError::named("ContractUnavailable", error.to_string())
                })?;
                lock(&self.contracts).insert(key, Arc::clone(&schema));
                schema
            }
        };
        if schema.is_valid(result) {
            return Ok(());
        }
        Err(HandlerError::named(
            "ContractValidationError",
            format!("result does not match contract {}@{version}", task.task_type),
        ))
    }

    async fn load_result_schema(
        &self,
        task: &ClaimedTask,
        version: &str,
    ) -> Result<Arc<crate::contracts::ContractSchema>, Error> {
        let rows = self
            .statements()
            .rows(&crate::contracts::CONTRACT_DEFINITION_TEXT, &[&task.task_type, &Some(version)])
            .await?;
        let [row] = rows.as_slice() else {
            return Err(Error::ContractUnavailable {
                task_type: task.task_type.clone(),
                version: version.into(),
            });
        };
        let schema: String = row.try_get("schema")?;
        let result = crate::contracts::compile_stored_member(&schema, "result")?;
        match result {
            Some(result) => Ok(Arc::new(result)),
            None => Ok(Arc::new(crate::contracts::compile_contract_schema(&Value::Bool(true))?)),
        }
    }

    /// Returns an owned task to its queue without consuming an attempt.
    pub(super) async fn release(
        &self,
        task: &ClaimedTask,
        missing: bool,
    ) -> Result<Outcome, Error> {
        if missing {
            tracing::warn!(
                event.name = "workhorse.handler.missing",
                workhorse.task.id = %task.id,
                workhorse.task.type = %task.task_type,
                workhorse.worker.id = %self.worker_id,
                "No handler registered for the claimed task type"
            );
        }
        let rows = fenced_rows(
            &self.statements(),
            sql::RELEASE_OWNED_V1,
            &[&task.id, &self.worker_id, &task.fence_token],
        )
        .await?;
        let status: Option<String> = exactly_one(&rows, "release_owned_v1")?.try_get("status")?;
        let outcome = match status.as_deref() {
            Some("released") => "released",
            Some("cancel_requested") => return self.acknowledge(task).await,
            Some("deadline_exceeded") => "deadline_exceeded",
            Some("timeout_exceeded") => "timeout",
            Some("stale") => return self.reconcile(task, Operation::Release).await,
            Some("not_due") => "lease_lost",
            other => {
                return Err(Error::UnexpectedStatus {
                    operation: Operation::Release,
                    status: other.unwrap_or_default().into(),
                })
            }
        };
        tracing::info!(
            event.name = "workhorse.task.release_processed",
            workhorse.task.id = %task.id,
            workhorse.worker.id = %self.worker_id,
            workhorse.release.status = outcome,
            "Owned task release processed"
        );
        Ok(outcome)
    }

    /// Submits a failure; PostgreSQL applies the retry policy and returns the resulting state.
    pub(super) async fn fail_with_state(
        &self,
        task: &ClaimedTask,
        error: HandlerError,
    ) -> Result<Outcome, Error> {
        let envelope = failure_envelope(&error, task.redact_error_details);
        let delay = if error.is_conflict() {
            Some(-1)
        } else {
            self.options
                .retry_delay
                .as_ref()
                .and_then(|delay| delay(task.attempt, task))
                .map(millis_i32)
        };
        let rows = fenced_rows(
            &self.statements(),
            sql::FAIL_V1,
            &[&task.id, &self.worker_id, &task.fence_token, &envelope, &delay],
        )
        .await?;
        let state: Option<String> = exactly_one(&rows, "fail_v1")?.try_get("state")?;
        let state = state.unwrap_or_default();
        let dimensions = [
            ("workhorse.queue.name", Attribute::Text(&task.queue)),
            ("workhorse.task.type", Attribute::Text(&task.task_type)),
        ];
        let outcome = match state.as_str() {
            "ready" | "scheduled" => "retry",
            "failed" => "failed",
            "cancel_requested" => return self.acknowledge(task).await,
            "deadline_exceeded" => "deadline_exceeded",
            "timeout_exceeded" => "timeout",
            "stale" => return self.reconcile(task, Operation::Fail).await,
            _ => return Err(Error::UnexpectedStatus { operation: Operation::Fail, status: state }),
        };
        self.metrics.add(
            Counter::Failed,
            1.0,
            &[dimensions[0], dimensions[1], ("workhorse.attempt.outcome", Attribute::Text(&state))],
        );
        if outcome == "retry" {
            self.metrics.add(Counter::Retried, 1.0, &dimensions);
        }
        tracing::info!(
            event.name = "workhorse.task.failure_processed",
            workhorse.task.id = %task.id,
            workhorse.worker.id = %self.worker_id,
            workhorse.task.state = %state,
            "Task failure processed"
        );
        Ok(outcome)
    }
}

fn accepted(rows: &[tokio_postgres::Row], function: &str) -> Result<bool, Error> {
    Ok(exactly_one(rows, function)?.try_get::<_, Option<bool>>("accepted")?.unwrap_or(false))
}

/// Reports a string or key holding NUL, which jsonb refuses with SQLSTATE 22P05. A Rust string
/// cannot hold an unpaired surrogate, so NUL is the one character a result can carry that jsonb
/// cannot store.
fn holds_nul(value: &Value) -> bool {
    match value {
        Value::String(text) => text.contains('\0'),
        Value::Array(items) => items.iter().any(holds_nul),
        Value::Object(entries) => {
            entries.iter().any(|(key, entry)| key.contains('\0') || holds_nul(entry))
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => false,
    }
}

/// The failure envelope of `protocol/v1/failures.json` that `fail_v1` stores for `error`.
fn failure_envelope(error: &HandlerError, redact: bool) -> Value {
    if redact {
        return json!({"name": "RedactedTaskError", "message": "Task handler failed; details redacted"});
    }
    json!({
        "name": storable_text(error.name.as_deref().unwrap_or("Error")),
        "message": storable_text(&error.message),
        "stack": error.stack.as_deref().map(storable_text),
    })
}

/// Returns `text` with each NUL replaced by U+FFFD, as the JVM and .NET workers do. jsonb refuses
/// NUL, and a refused envelope would end the worker instead of recording the handler's failure. A
/// Rust string cannot hold the unpaired surrogate that those workers also replace.
fn storable_text(text: &str) -> String {
    text.replace('\0', "\u{FFFD}")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{failure_envelope, storable_text};
    use crate::HandlerError;

    #[test]
    fn storable_text_replaces_only_nul() {
        assert_eq!(storable_text("a\0b \u{1F600} \u{FFFD}"), "a\u{FFFD}b \u{1F600} \u{FFFD}");
        assert_eq!(storable_text("plain"), "plain");
    }

    // A handler names its own error, so the name is cleaned too (SM-1650).
    #[test]
    fn failure_envelope_cleans_every_field() {
        let mut error = HandlerError::named("Payment\0Declined", "card\0declined");
        error.stack = Some("at\0fixture".into());
        assert_eq!(
            failure_envelope(&error, false),
            json!({
                "name": "Payment\u{FFFD}Declined",
                "message": "card\u{FFFD}declined",
                "stack": "at\u{FFFD}fixture",
            })
        );
        assert_eq!(
            failure_envelope(&error, true),
            json!({"name": "RedactedTaskError", "message": "Task handler failed; details redacted"})
        );
    }
}
