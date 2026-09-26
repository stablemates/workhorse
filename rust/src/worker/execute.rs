//! Supervising one handler and settling its task under the claim's fence.
use std::panic::AssertUnwindSafe;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use futures_util::FutureExt;
use serde_json::{json, Value};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken as StopToken;
use tracing::Instrument;
use uuid::Uuid;

use super::handler::{ErasedHandler, HandlerResult};
use super::heartbeat::Beat;
use super::{exactly_one, lock, millis_i32, sql, Inner, OwnershipStatus};
use crate::telemetry::{self, Attribute, Counter, Histogram};
use crate::{
    CancelReason, CancellationToken, ClaimedTask, Error, Executor, HandlerContext, HandlerError,
    Operation,
};

/// How often, and for how long, an expiration PostgreSQL reports as not yet due is retried.
const EXPIRATION_RETRY: Duration = Duration::from_millis(5);
const EXPIRATION_BUDGET: Duration = Duration::from_secs(1);
/// How far past a deadline the local timer fires, so PostgreSQL's clock agrees it has passed.
const EXPIRATION_SKEW: Duration = Duration::from_millis(1);

/// The `handler.outcome` attribute, and the settlement one execution reached.
type Outcome = &'static str;

fn instant_at(at: DateTime<Utc>) -> Instant {
    Instant::now() + (at - Utc::now()).to_std().unwrap_or_default() + EXPIRATION_SKEW
}

/// The earlier of the task deadline and the attempt timeout, with the reason each one cancels.
fn expiration(task: &ClaimedTask) -> Option<(Instant, CancelReason)> {
    let deadline = task.deadline_at.map(|at| (at, CancelReason::DeadlineExceeded));
    let timeout = task.attempt_timeout_at.map(|at| (at, CancelReason::ExecutionTimeout));
    [deadline, timeout]
        .into_iter()
        .flatten()
        .min_by_key(|(at, _)| *at)
        .map(|(at, reason)| (instant_at(at), reason))
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
        let mut beats = self.register_heartbeat(task.id, task.fence_token);
        let token = CancellationToken::default();
        let context = HandlerContext::new(
            Arc::clone(&task),
            token.clone(),
            self.pool.clone(),
            self.worker_id.clone(),
        );
        let future = AssertUnwindSafe(handler(task.payload.clone(), context.clone()))
            .catch_unwind()
            .instrument(span.clone());
        tokio::pin!(future);

        let lease = self.options.lease_duration;
        let watchdog = tokio::time::sleep_until(task.claim_sent_at + lease);
        tokio::pin!(watchdog);
        let mut watchdog_armed = true;
        let expires = expiration(&task);
        let expiry = tokio::time::sleep_until(expires.map_or_else(Instant::now, |(at, _)| at));
        tokio::pin!(expiry);
        let mut expired: Option<Result<OwnershipStatus, Error>> = None;
        let mut rejected: Option<OwnershipStatus> = None;
        let mut beats_open = true;
        let result = loop {
            tokio::select! {
                result = &mut future => break result,
                () = &mut watchdog, if watchdog_armed => {
                    // No renewal was accepted within the lease, so another worker may own the task.
                    watchdog_armed = false;
                    rejected.get_or_insert(OwnershipStatus::Stale);
                    token.cancel(CancelReason::LeaseLost);
                    tracing::warn!(
                        parent: &span,
                        event.name = "workhorse.task.lease_expired",
                        workhorse.worker.id = %self.worker_id,
                        "No heartbeat was accepted within the task lease"
                    );
                }
                () = &mut expiry, if expires.is_some() && expired.is_none() => {
                    let (_, reason) = expires.expect("guarded above");
                    token.cancel(reason);
                    self.unregister_heartbeat(task.id);
                    watchdog_armed = false;
                    expired = Some(self.expire_ownership(&task).await);
                }
                beat = beats.recv(), if beats_open => match beat {
                    Some(Beat::Renewed(sent_at)) => watchdog.as_mut().reset(sent_at + lease),
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
        self.unregister_heartbeat(task.id);
        let result: HandlerResult = result
            .unwrap_or_else(|panic| Err(HandlerError::from_panic(&task.task_type, false, panic)));

        // A suspending call settled the task in PostgreSQL, so the handler's return is moot.
        let settled = if context.suspended() {
            Ok("suspended")
        } else {
            self.settle(&task, result, expired, rejected, token.reason()).await
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
        self.metrics.add(Counter::HandlerRuntime, elapsed, &attributes);
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
        &self,
        task: &ClaimedTask,
        result: HandlerResult,
        expired: Option<Result<OwnershipStatus, Error>>,
        rejected: Option<OwnershipStatus>,
        reason: Option<CancelReason>,
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
            (Some(CancelReason::Shutdown), Err(_)) => return self.release(task, false).await,
            _ => {}
        }
        match result {
            Ok(value) => self.complete(task, value).await,
            Err(error) => self.fail_with_state(task, error).await,
        }
    }

    /// Asks PostgreSQL to expire the task's ownership, retrying briefly while it is not yet due.
    pub(super) async fn expire_ownership(
        &self,
        task: &ClaimedTask,
    ) -> Result<OwnershipStatus, Error> {
        let budget = Instant::now() + EXPIRATION_BUDGET;
        loop {
            let rows = self
                .pool
                .rows(
                    sql::EXPIRE_OWNED_TELEMETRY_V1,
                    &[&task.id, &self.worker_id, &task.fence_token],
                )
                .await?;
            let row = exactly_one(&rows, "expire_owned_telemetry_v1")?;
            let status =
                OwnershipStatus::parse(row.try_get::<_, Option<String>>("status")?.as_deref())?;
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
        let rows = self
            .pool
            .rows(sql::ACKNOWLEDGE_CANCEL_V1, &[&task.id, &self.worker_id, &task.fence_token])
            .await?;
        if accepted(&rows, "acknowledge_cancel_v1")? {
            Ok("canceled")
        } else {
            Err(Error::LeaseLost { task_id: task.id, operation: Operation::Heartbeat })
        }
    }

    /// Explains a rejected settlement: a cancellation or expiration that won, or a lost lease.
    async fn reconcile(&self, task: &ClaimedTask, operation: Operation) -> Result<Outcome, Error> {
        let rows = self
            .pool
            .rows(sql::ACKNOWLEDGE_CANCEL_V1, &[&task.id, &self.worker_id, &task.fence_token])
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

    async fn complete(&self, task: &ClaimedTask, result: Value) -> Result<Outcome, Error> {
        if let Some(version) = &task.contract_version {
            if let Err(error) = self.validate_result(task, version, &result).await {
                return self.fail_with_state(task, error).await;
            }
        }
        let accepted = if task.fast_tier {
            self.complete_fast(task, &result).await?
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
        let rows = self
            .pool
            .rows(sql::COMPLETE_V1, &[&task.id, &self.worker_id, &task.fence_token, result])
            .await?;
        accepted(&rows, "complete_v1")
    }

    /// Completes a fast-tier attempt through the batched statement, claiming nothing.
    ///
    /// A queue that left the fast tier after the claim rejects that statement, so the attempt
    /// completes through `complete_v1` instead.
    async fn complete_fast(&self, task: &ClaimedTask, result: &Value) -> Result<bool, Error> {
        let rows = self
            .pool
            .rows(
                sql::COMPLETE_MANY_AND_CLAIM_V1,
                &[
                    &self.worker_id,
                    &vec![task.id],
                    &vec![task.fence_token],
                    &vec![result.clone()],
                    &task.queue,
                    &0_i32,
                    &millis_i32(self.options.lease_duration),
                ],
            )
            .await
            .map_err(Error::translate_fast_tier);
        let rows = match rows {
            Ok(rows) => rows,
            Err(Error::FastTierUnsupported { .. }) => {
                return self.complete_full(task, result).await
            }
            Err(error) => return Err(error),
        };
        // The first row carries every accepted id; a stale fence leaves this task out of it.
        let accepted = match rows.first() {
            Some(row) => row.try_get::<_, Option<Vec<Uuid>>>("accepted")?.unwrap_or_default(),
            None => Vec::new(),
        };
        Ok(accepted.contains(&task.id))
    }

    /// Checks a result against the task's pinned contract, caching each compiled schema.
    async fn validate_result(
        &self,
        task: &ClaimedTask,
        version: &str,
        result: &Value,
    ) -> Result<(), HandlerError> {
        let key = format!("{}|{version}|result", task.task_type);
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
            .pool
            .rows(sql::GET_CONTRACT_DEFINITION_V1, &[&task.task_type, &Some(version)])
            .await?;
        let [row] = rows.as_slice() else {
            return Err(Error::ContractUnavailable {
                task_type: task.task_type.clone(),
                version: version.into(),
            });
        };
        let schema: Value = row.try_get("schema")?;
        let result = schema.get("result").cloned().unwrap_or(Value::Bool(true));
        Ok(Arc::new(crate::contracts::compile_contract_schema(&result)?))
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
        let rows = self
            .pool
            .rows(sql::RELEASE_OWNED_V1, &[&task.id, &self.worker_id, &task.fence_token])
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
        let envelope = if task.redact_error_details {
            json!({"name": "RedactedTaskError", "message": "Task handler failed; details redacted"})
        } else {
            json!({
                "name": error.name.as_deref().unwrap_or("Error"),
                "message": error.message,
                "stack": error.stack,
            })
        };
        let delay = self
            .options
            .retry_delay
            .as_ref()
            .and_then(|delay| delay(task.attempt, task))
            .map(millis_i32);
        let rows = self
            .pool
            .rows(sql::FAIL_V1, &[&task.id, &self.worker_id, &task.fence_token, &envelope, &delay])
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
