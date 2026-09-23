//! Deployment-synchronized concurrency, rate limit and budget policies.
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use tokio_postgres::Row;

/// A token bucket: `limit` starts per `interval_ms`, with up to `burst` saved.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RateLimit {
    pub limit: i32,
    pub interval_ms: i32,
    pub burst: i32,
}

impl RateLimit {
    fn document(self) -> Value {
        json!({"limit": self.limit, "intervalMs": self.interval_ms, "burst": self.burst})
    }

    fn read(row: &Row, prefix: &str, limit: &str) -> Result<Option<Self>, tokio_postgres::Error> {
        let Some(limit) = row.try_get::<_, Option<i32>>(limit)? else {
            return Ok(None);
        };
        Ok(Some(Self {
            limit,
            interval_ms: row.try_get(format!("{prefix}interval_ms").as_str())?,
            burst: row.try_get(format!("{prefix}burst").as_str())?,
        }))
    }
}

/// Desired active-task limits for one queue.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConcurrencyPolicyDefinition {
    pub queue: String,
    pub max_active: i32,
    pub max_active_per_key: Option<i32>,
}

/// A concurrency policy as PostgreSQL stores it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConcurrencyPolicy {
    pub namespace: String,
    pub queue: String,
    pub max_active: i32,
    pub max_active_per_key: Option<i32>,
    pub updated_at: DateTime<Utc>,
}

/// Desired start rate for one queue, and optionally for each concurrency key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RateLimitPolicyDefinition {
    pub queue: String,
    pub rate: RateLimit,
    pub per_key: Option<RateLimit>,
}

/// A rate limit policy as PostgreSQL stores it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RateLimitPolicy {
    pub namespace: String,
    pub queue: String,
    pub rate: RateLimit,
    pub per_key: Option<RateLimit>,
    pub updated_at: DateTime<Utc>,
}

/// A named limit shared by every task that selects it, across queues.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BudgetDefinition {
    pub name: String,
    pub max_active: Option<i32>,
    pub rate: Option<RateLimit>,
}

/// A budget as PostgreSQL stores it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Budget {
    pub namespace: String,
    pub name: String,
    pub max_active: Option<i32>,
    pub rate: Option<RateLimit>,
    pub updated_at: DateTime<Utc>,
}

pub(crate) fn concurrency_document(definitions: &[ConcurrencyPolicyDefinition]) -> Value {
    definitions
        .iter()
        .map(|definition| {
            json!({
                "queue": definition.queue,
                "maxActive": definition.max_active,
                "maxActivePerKey": definition.max_active_per_key,
            })
        })
        .collect()
}

pub(crate) fn rate_limit_document(definitions: &[RateLimitPolicyDefinition]) -> Value {
    definitions
        .iter()
        .map(|definition| {
            json!({
                "queue": definition.queue,
                "rate": definition.rate.document(),
                "perKey": definition.per_key.map(RateLimit::document),
            })
        })
        .collect()
}

pub(crate) fn budget_document(definitions: &[BudgetDefinition]) -> Value {
    definitions
        .iter()
        .map(|definition| {
            json!({
                "name": definition.name,
                "maxActive": definition.max_active,
                "rate": definition.rate.map(RateLimit::document),
            })
        })
        .collect()
}

pub(crate) fn concurrency_policy(row: &Row) -> Result<ConcurrencyPolicy, tokio_postgres::Error> {
    Ok(ConcurrencyPolicy {
        namespace: row.try_get("namespace")?,
        queue: row.try_get("queue_name")?,
        max_active: row.try_get("max_active")?,
        max_active_per_key: row.try_get("max_active_per_key")?,
        updated_at: row.try_get("updated_at")?,
    })
}

pub(crate) fn rate_limit_policy(row: &Row) -> Result<RateLimitPolicy, tokio_postgres::Error> {
    Ok(RateLimitPolicy {
        namespace: row.try_get("namespace")?,
        queue: row.try_get("queue_name")?,
        rate: RateLimit {
            limit: row.try_get("rate_limit")?,
            interval_ms: row.try_get("rate_interval_ms")?,
            burst: row.try_get("rate_burst")?,
        },
        per_key: RateLimit::read(row, "per_key_", "per_key_limit")?,
        updated_at: row.try_get("updated_at")?,
    })
}

pub(crate) fn budget(row: &Row) -> Result<Budget, tokio_postgres::Error> {
    Ok(Budget {
        namespace: row.try_get("namespace")?,
        name: row.try_get("budget_name")?,
        max_active: row.try_get("max_active")?,
        rate: RateLimit::read(row, "rate_", "rate_limit")?,
        updated_at: row.try_get("updated_at")?,
    })
}
