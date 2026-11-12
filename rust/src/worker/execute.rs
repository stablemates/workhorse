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
use super::{exactly_one, lock, sql, ActiveSlot, Inner, OwnershipStatus};
use crate::fenced_write::fenced_rows;
use crate::queue::Rows as _;
use crate::telemetry::{self, Attribute, Counter, Histogram};
use crate::value_size::jsonb_text_bytes;
use crate::{
    CancelReason, CancellationToken, ClaimedTask, Error, HandlerContext, HandlerError, Operation,
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
                    // The request runs under the handler span, so a retry span is its child.
                    expiring =
                        Some(Box::pin(self.expire_owned_once(&task).instrument(span.clone())));
                }
                answer = async { expiring.as_mut().expect("the guard checks it").await },
                    if expiring.is_some() => {
                    expiring = None;
                    // The handler still runs, so each failed request gets its record, also when
                    // a stale heartbeat that arrived during the request ends the attempt next.
                    if let Err(error) = &answer {
                        tracing::warn!(
                            parent: &span,
                            event.name = "workhorse.worker.expiration_request_failed",
                            workhorse.task.id = %task.id,
                            workhorse.task.type = %task.task_type,
                            workhorse.task.attempt = task.attempt,
                            workhorse.queue.name = %task.queue,
                            workhorse.worker.id = %self.worker_id,
                            error.r#type = %error.type_name(),
                            error = %error,
                            "Ownership expiration request failed; the worker asks again"
                        );
                    }
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
                        _ => {
                            // not_due is the database refusing an expiry its clock has not
                            // reached, and a failed request proves nothing. The handler keeps
                            // running and renewing, and the worker asks again after a backoff.
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
            // A handler that ends with anything other than the suspension caught it. The task
            // still suspends, and the warning is the only record that the handler swallowed it
            // (SM-2016).
            if !matches!(&result, Err(error) if error.is_suspension()) {
                tracing::warn!(
                    parent: &span,
                    event.name = "workhorse.handler.signal_swallowed",
                    workhorse.task.id = %task.id,
                    workhorse.task.type = %task.task_type,
                    workhorse.task.attempt = task.attempt,
                    workhorse.queue.name = %task.queue,
                    workhorse.worker.id = %self.worker_id,
                    workhorse.handler.outcome = "suspended",
                    "Task handler swallowed its suspension signal"
                );
            }
            Ok("suspended")
        } else {
            self.settle(&task, result, expired, rejected, token.reason_at_return(), slot)
                .instrument(span.clone())
                .await
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
            // A handler that stopped for shutdown returns the task to the queue without an attempt
            // (ADR 0117). A panic still fails the attempt.
            (Some(CancelReason::Shutdown), Err(error)) if !error.is_panic() => {
                return self.release(task, false).await
            }
            _ => {}
        }
        let after_shutdown = reason == Some(CancelReason::Shutdown);
        match result {
            Ok(value) => self.complete(task, value, slot, after_shutdown).await,
            Err(error) => self.fail_with_state(task, error).await,
        }
    }

    /// Settles a result that the task cannot store. After the shutdown cancellation, the worker
    /// returns the task to its queue without an attempt, so the next attempt meets the same check
    /// (ADR 0117). Otherwise the retry policy applies.
    async fn refuse_result(
        &self,
        task: &ClaimedTask,
        error: HandlerError,
        after_shutdown: bool,
    ) -> Result<Outcome, Error> {
        if after_shutdown {
            return self.release(task, false).await;
        }
        self.fail_with_state(task, error).await
    }

    /// Asks PostgreSQL once to expire the task's ownership under its fence. If the expiry starts
    /// another attempt, `retry_state` names its state, and the worker records the `workhorse.retry`
    /// span and one `workhorse.tasks.retried` count, as the TypeScript worker does.
    async fn expire_owned_once(&self, task: &ClaimedTask) -> Result<OwnershipStatus, Error> {
        let rows = fenced_rows(
            &self.statements(),
            sql::EXPIRE_OWNED_TELEMETRY_V1,
            &[&task.id, &self.worker_id, &task.fence_token],
        )
        .await?;
        let row = exactly_one(&rows, "expire_owned_telemetry_v1")?;
        let status =
            OwnershipStatus::parse(row.try_get::<_, Option<String>>("status")?.as_deref())?;
        if let Some(retry_state) = row.try_get::<_, Option<String>>("retry_state")? {
            let span = telemetry::retry_span(task);
            span.record("workhorse.retry.outcome", retry_state.as_str());
            self.metrics.add(
                Counter::Retried,
                1.0,
                &[
                    ("workhorse.queue.name", Attribute::Text(&task.queue)),
                    ("workhorse.task.type", Attribute::Text(&task.task_type)),
                ],
            );
        }
        Ok(status)
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
        after_shutdown: bool,
    ) -> Result<Outcome, Error> {
        if let Some(version) = &task.contract_version {
            if let Err(error) = self.validate_result(task, version, &result).await {
                return self.refuse_result(task, error, after_shutdown).await;
            }
        }
        if holds_nul(&result) {
            let message = format!(
                "{} result contains a NUL character or an unpaired surrogate, which PostgreSQL \
                 jsonb cannot store",
                task.task_type
            );
            return self.refuse_result(task, HandlerError::new(message), after_shutdown).await;
        }
        if let Some(limit) = task.result_max_bytes {
            // PostgreSQL would refuse the completion, which ends the settlement rather than the
            // attempt and leaves the task active until lease recovery.
            if jsonb_text_bytes(&result) > usize::try_from(limit).unwrap_or(0) {
                let message =
                    format!("{} result exceeds its configured size limit", task.task_type);
                let error = HandlerError::named("TaskValueSizeLimitError", message);
                return self.refuse_result(task, error, after_shutdown).await;
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
                .map(retry_delay_millis)
                .transpose()?
        };
        let span = telemetry::retry_span(task);
        let state = self.write_failure(task, &envelope, delay).instrument(span.clone()).await;
        let state = match state {
            Ok(state) => state,
            Err(error) => {
                // As on the handler span, the error is the span status. The worker writes no
                // exception event.
                span.record("otel.status_code", "error");
                span.record("otel.status_message", error.to_string().as_str());
                return Err(error);
            }
        };
        drop(span);
        match state.as_str() {
            "ready" | "scheduled" => Ok("retry"),
            "failed" => Ok("failed"),
            "cancel_requested" => self.acknowledge(task).await,
            "deadline_exceeded" => Ok("deadline_exceeded"),
            "timeout_exceeded" => Ok("timeout"),
            "stale" => self.reconcile(task, Operation::Fail).await,
            _ => Err(Error::UnexpectedStatus { operation: Operation::Fail, status: state }),
        }
    }

    /// Sends one failure to `fail_v1` under the `workhorse.retry` span and returns the state that
    /// PostgreSQL settled. The span covers the write, its metrics, and its log record, as in the
    /// TypeScript worker. A cancellation acknowledgement or a reconciliation that follows is outside
    /// the span.
    async fn write_failure(
        &self,
        task: &ClaimedTask,
        envelope: &Value,
        delay: Option<i32>,
    ) -> Result<String, Error> {
        let rows = fenced_rows(
            &self.statements(),
            sql::FAIL_V2,
            &[&task.id, &self.worker_id, &task.fence_token, envelope, &delay],
        )
        .await?;
        let state: Option<String> = exactly_one(&rows, "fail_v2")?.try_get("state")?;
        let state = state.unwrap_or_default();
        tracing::Span::current().record("workhorse.retry.outcome", state.as_str());
        if !matches!(
            state.as_str(),
            "ready" | "scheduled" | "failed" | "deadline_exceeded" | "timeout_exceeded"
        ) {
            return Ok(state);
        }
        let dimensions = [
            ("workhorse.queue.name", Attribute::Text(&task.queue)),
            ("workhorse.task.type", Attribute::Text(&task.task_type)),
        ];
        self.metrics.add(
            Counter::Failed,
            1.0,
            &[dimensions[0], dimensions[1], ("workhorse.attempt.outcome", Attribute::Text(&state))],
        );
        if matches!(state.as_str(), "ready" | "scheduled") {
            self.metrics.add(Counter::Retried, 1.0, &dimensions);
        }
        tracing::info!(
            event.name = "workhorse.task.failure_processed",
            workhorse.task.id = %task.id,
            workhorse.worker.id = %self.worker_id,
            workhorse.task.state = %state,
            "Task failure processed"
        );
        Ok(state)
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

/// The failure envelope of `protocol/v1/failures.json` that `fail_v2` stores for `error`.
fn failure_envelope(error: &HandlerError, redact: bool) -> Value {
    if redact {
        return json!({"name": "RedactedTaskError", "message": "Task handler failed; details redacted"});
    }
    let name = storable_text(error.name.as_deref().unwrap_or("Error"));
    let message = storable_text(&error.message);
    let stack = error.stack.as_deref().map(storable_text);
    let bounded_name = utf8_prefix(&name, ENVELOPE_NAME_MAX_BYTES);
    let bounded_message = utf8_prefix(&message, ENVELOPE_MESSAGE_MAX_BYTES);
    let bounded_stack = stack.as_deref().map(|text| utf8_prefix(text, ENVELOPE_STACK_MAX_BYTES));
    let truncated = bounded_name.len() != name.len()
        || bounded_message.len() != message.len()
        || bounded_stack.map(str::len) != stack.as_deref().map(str::len);
    let mut envelope = json!({
        "name": bounded_name,
        "message": bounded_message,
        "stack": bounded_stack,
    });
    if truncated {
        envelope["truncated"] = Value::Bool(true);
    }
    envelope
}

// The UTF-8 byte limit of each envelope field, as `protocol/v1/failures.json` states it (SM-1983).
// `bound_error_envelope_v1` applies the same cut, so `fail_v2` does not change this envelope.
const ENVELOPE_NAME_MAX_BYTES: usize = 1024;
const ENVELOPE_MESSAGE_MAX_BYTES: usize = 16_384;
const ENVELOPE_STACK_MAX_BYTES: usize = 65_536;

/// The longest prefix of `text` whose UTF-8 form has at most `max_bytes` bytes. A Rust string is
/// UTF-8, so the cut moves back to a character boundary.
fn utf8_prefix(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut cut = max_bytes;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    &text[..cut]
}

/// Returns `text` with each NUL replaced by U+FFFD, as the JVM and .NET workers do. jsonb refuses
/// NUL, and a refused envelope would end the worker instead of recording the handler's failure. A
/// Rust string cannot hold the unpaired surrogate that those workers also replace.
fn storable_text(text: &str) -> String {
    text.replace('\0', "\u{FFFD}")
}

/// Converts a retry delay override to the milliseconds that `fail_v1` takes. The delay rounds to the
/// nearest millisecond, half up. A delay that rounds above the PostgreSQL integer maximum is an
/// error before `fail_v1`; the worker never clamps it (ADR 0111).
fn retry_delay_millis(delay: Duration) -> Result<i32, Error> {
    let millis = (delay.as_nanos() + 500_000) / 1_000_000;
    i32::try_from(millis).map_err(|_| {
        Error::invalid(format!(
            "retry_delay returned {delay:?}; it must return None or a duration from 0 through \
             2147483647 ms"
        ))
    })
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::json;

    use super::{failure_envelope, retry_delay_millis, storable_text, utf8_prefix};
    use crate::Error;
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

    // SM-1983: each field is cut at a character boundary to its UTF-8 byte limit.
    #[test]
    fn failure_envelope_cuts_each_field_without_splitting_a_character() {
        assert_eq!(utf8_prefix("a\u{e9}", 2), "a");
        assert_eq!(utf8_prefix("a\u{e9}", 3), "a\u{e9}");
        assert_eq!(utf8_prefix("\u{20ac}\u{20ac}", 5), "\u{20ac}");
        assert_eq!(utf8_prefix("a\u{1F600}", 4), "a");
        assert_eq!(utf8_prefix("a\u{1F600}", 5), "a\u{1F600}");
        let mut error =
            HandlerError::named(format!("a{}", "\u{20ac}".repeat(342)), "m".repeat(70_000));
        error.stack = Some(format!("a{}", "\u{1F600}".repeat(16_384)));
        assert_eq!(
            failure_envelope(&error, false),
            json!({
                "name": format!("a{}", "\u{20ac}".repeat(341)),
                "message": "m".repeat(16_384),
                "stack": format!("a{}", "\u{1F600}".repeat(16_383)),
                "truncated": true,
            })
        );
    }

    // fail_v1 takes an integer, so the override range ends at 2147483647 ms (SM-1668 PAR-06).
    #[test]
    fn retry_delay_millis_rounds_half_up_and_refuses_values_above_the_limit() {
        let limit = Duration::from_millis(2_147_483_647);
        assert_eq!(retry_delay_millis(limit).unwrap(), 2_147_483_647);
        assert_eq!(retry_delay_millis(limit + Duration::from_micros(499)).unwrap(), 2_147_483_647);
        assert_eq!(retry_delay_millis(Duration::ZERO).unwrap(), 0);
        assert_eq!(retry_delay_millis(Duration::from_micros(1_400)).unwrap(), 1);
        assert_eq!(retry_delay_millis(Duration::from_micros(1_500)).unwrap(), 2);
        for refused in [
            Duration::from_millis(2_147_483_648),
            limit + Duration::from_micros(500),
            Duration::MAX,
        ] {
            assert!(
                matches!(retry_delay_millis(refused), Err(Error::InvalidArgument(message)) if message.contains("retry_delay")),
                "{refused:?} must be refused"
            );
        }
    }
}
