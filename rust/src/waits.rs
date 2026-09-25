//! Durable timers, signal waits and human waits. Each one either returns or suspends the task.
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::context::{status, validate_name};
use crate::sql_catalogue_generated as sql;
use crate::{Error, HandlerContext, Operation};

const MAX_SLEEP: Duration = Duration::from_secs(365 * 24 * 60 * 60);
const MAX_WAIT_TIMEOUT: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const MAX_HUMAN_CONTEXT_BYTES: usize = 65_536;

/// The payload a delivered signal carried.
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq)]
pub struct SignalOutcome<T> {
    pub payload: T,
}

/// The result a person completed a human wait with.
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq)]
pub struct HumanOutcome<T> {
    pub result: T,
}

impl HandlerContext {
    /// Returns once `duration` has elapsed since the first attempt that reached this wait.
    ///
    /// Until then PostgreSQL releases the task and the handler stops with a suspension.
    pub async fn sleep(&self, name: &str, duration: Duration) -> Result<(), Error> {
        self.fast_tier_guard("durable waits")?;
        validate_name(name, "wait")?;
        let millis = whole_millis(duration, MAX_SLEEP, "sleep duration")?;
        let key = format!("wait:{name}");
        self.shared(Operation::Sleep, &key, format!("duration:{millis}"), || async {
            self.schedule(name, Some(millis), None).await
        })
        .await
        .map(drop)
    }

    /// Returns once `wake_at` has passed; a time already past returns without suspending.
    pub async fn sleep_until(&self, name: &str, wake_at: DateTime<Utc>) -> Result<(), Error> {
        self.fast_tier_guard("durable waits")?;
        validate_name(name, "wait")?;
        if (wake_at - Utc::now()).to_std().is_ok_and(|ahead| ahead > MAX_SLEEP) {
            return Err(Error::invalid("sleep_until wake time must be at most 365 days ahead"));
        }
        let key = format!("wait:{name}");
        let request = format!("until:{}", wake_at.timestamp_micros());
        self.shared(Operation::Sleep, &key, request, || async {
            self.schedule(name, None, Some(wake_at)).await
        })
        .await
        .map(drop)
    }

    async fn schedule(
        &self,
        name: &str,
        millis: Option<i64>,
        wake_at: Option<DateTime<Utc>>,
    ) -> Result<Value, Error> {
        self.check(Operation::Sleep)?;
        let row = self
            .call(sql::SCHEDULE_WAIT_V1, "schedule_wait_v1", &[&name, &millis, &wake_at])
            .await?;
        match status(&row)?.as_str() {
            "elapsed" => Ok(Value::Null),
            "scheduled" => Err(self.suspend()),
            other => Err(self.refusal(Operation::Sleep, name, other)),
        }
    }

    /// Returns the payload of the signal delivered under `name`, suspending until one arrives.
    ///
    /// A timeout bounds the task's deadline, so an undelivered signal ends the task.
    pub async fn wait_for_signal<T: DeserializeOwned>(
        &self,
        name: &str,
        timeout: Option<Duration>,
    ) -> Result<SignalOutcome<T>, Error> {
        self.fast_tier_guard("signal waits")?;
        validate_wait_name(name, "signal")?;
        let timeout = wait_timeout(timeout)?;
        let key = format!("signal:{name}");
        let value = self
            .shared(Operation::WaitForSignal, &key, format!("{timeout:?}"), || async {
                self.check(Operation::WaitForSignal)?;
                let row = self
                    .call(sql::WAIT_FOR_SIGNAL_V1, "wait_for_signal_v1", &[&name, &timeout])
                    .await?;
                match status(&row)?.as_str() {
                    "delivered" => {
                        Ok(row.try_get::<_, Option<Value>>("payload")?.unwrap_or_default())
                    }
                    "waiting" => Err(self.suspend()),
                    other => Err(self.refusal(Operation::WaitForSignal, name, other)),
                }
            })
            .await?;
        Ok(SignalOutcome { payload: serde_json::from_value(value)? })
    }

    /// Shows `context` to a person and returns their result, suspending until they complete it.
    ///
    /// A timeout bounds the task's deadline, so an uncompleted wait ends the task.
    pub async fn wait_for_human<C: Serialize, T: DeserializeOwned>(
        &self,
        name: &str,
        context: &C,
        timeout: Option<Duration>,
    ) -> Result<HumanOutcome<T>, Error> {
        self.fast_tier_guard("human waits")?;
        validate_wait_name(name, "human wait")?;
        let timeout = wait_timeout(timeout)?;
        let context = serde_json::to_value(context)?;
        let encoded = context.to_string();
        if encoded.len() > MAX_HUMAN_CONTEXT_BYTES {
            return Err(Error::invalid("human wait context must encode to at most 65536 bytes"));
        }
        let key = format!("human:{name}");
        let request = format!("{timeout:?}:{encoded}");
        let value = self
            .shared(Operation::WaitForHuman, &key, request, || async {
                self.check(Operation::WaitForHuman)?;
                let row = self
                    .call(sql::WAIT_FOR_HUMAN_V1, "wait_for_human_v1", &[&name, &context, &timeout])
                    .await?;
                match status(&row)?.as_str() {
                    "completed" => {
                        Ok(row.try_get::<_, Option<Value>>("result")?.unwrap_or_default())
                    }
                    "waiting" => Err(self.suspend()),
                    other => Err(self.refusal(Operation::WaitForHuman, name, other)),
                }
            })
            .await?;
        Ok(HumanOutcome { result: serde_json::from_value(value)? })
    }
}

/// Signal and human wait names, which PostgreSQL also refuses with surrounding spaces.
fn validate_wait_name(name: &str, label: &str) -> Result<(), Error> {
    validate_name(name, label)?;
    if name.trim_matches(' ') == name {
        Ok(())
    } else {
        Err(Error::invalid(format!("{label} name must not start or end with a space")))
    }
}

fn wait_timeout(timeout: Option<Duration>) -> Result<Option<i64>, Error> {
    timeout.map(|timeout| whole_millis(timeout, MAX_WAIT_TIMEOUT, "wait timeout")).transpose()
}

fn whole_millis(duration: Duration, max: Duration, label: &str) -> Result<i64, Error> {
    if duration.subsec_nanos() % 1_000_000 != 0 || duration.is_zero() || duration > max {
        return Err(Error::invalid(format!(
            "{label} must be whole milliseconds between 1ms and {max:?}"
        )));
    }
    i64::try_from(duration.as_millis()).map_err(|_| Error::invalid(format!("{label} is too long")))
}
