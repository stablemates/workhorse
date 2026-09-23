//! The startup schema compatibility check every SDK runs before its first mutation.
use std::fmt;

use crate::queue::Executor;
use crate::sql_catalogue_generated as sql;
use crate::Error;

/// Why PostgreSQL and this client cannot work together.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CompatibilityCode {
    SchemaNotInstalled,
    SchemaTooOld,
    SchemaTooNew,
    ClientProtocolTooOld,
    ClientProtocolTooNew,
}

impl CompatibilityCode {
    /// The protocol's stable refusal code, for example `schema-too-old`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SchemaNotInstalled => "schema-not-installed",
            Self::SchemaTooOld => "schema-too-old",
            Self::SchemaTooNew => "schema-too-new",
            Self::ClientProtocolTooOld => "client-protocol-too-old",
            Self::ClientProtocolTooNew => "client-protocol-too-new",
        }
    }
}

impl fmt::Display for CompatibilityCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// The installed schema version and the protocol versions PostgreSQL serves.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CompatibilityState {
    /// `None` when the schema is absent or its version table is ambiguous.
    pub installed_schema_version: Option<i32>,
    pub served_protocol_versions: Vec<i32>,
}

/// Decides compatibility from observed state without touching PostgreSQL.
pub fn check_compatibility(
    installed_schema_version: Option<i32>,
    client_protocol_version: i32,
    served_protocol_versions: &[i32],
) -> Result<(), CompatibilityCode> {
    let Some(installed) = installed_schema_version else {
        return Err(CompatibilityCode::SchemaNotInstalled);
    };
    if installed < sql::MINIMUM_SCHEMA_VERSION {
        return Err(CompatibilityCode::SchemaTooOld);
    }
    if client_protocol_version < sql::MINIMUM_PROTOCOL_VERSION {
        return Err(CompatibilityCode::ClientProtocolTooOld);
    }
    if client_protocol_version > sql::MAXIMUM_PROTOCOL_VERSION {
        return Err(CompatibilityCode::ClientProtocolTooNew);
    }
    if served_protocol_versions.is_empty()
        || served_protocol_versions.contains(&client_protocol_version)
    {
        return Ok(());
    }
    let oldest = served_protocol_versions.iter().copied().min().unwrap_or(0);
    Err(if client_protocol_version < oldest {
        CompatibilityCode::SchemaTooNew
    } else {
        CompatibilityCode::SchemaTooOld
    })
}

/// Reads the compatibility state; a missing schema reads as not installed.
pub async fn read_compatibility_state<E: Executor>(
    executor: &E,
) -> Result<CompatibilityState, Error> {
    let rows = match executor.rows(sql::COMPATIBILITY_STATE, &[]).await {
        Ok(rows) => rows,
        Err(error) if matches!(error.sqlstate(), Some("42P01" | "3F000")) => {
            return Ok(CompatibilityState::default());
        }
        Err(error) => return Err(error),
    };
    let mut schema = Vec::new();
    let mut state = CompatibilityState::default();
    for row in rows {
        let version: i32 = row.try_get("version")?;
        match row.try_get::<_, &str>("kind")? {
            "schema" => schema.push(version),
            "protocol" => state.served_protocol_versions.push(version),
            _ => {}
        }
    }
    if let [version] = schema[..] {
        state.installed_schema_version = Some(version);
    }
    Ok(state)
}

/// Refuses with [`Error::Compatibility`] unless this client can use the installed schema.
pub async fn assert_schema_compatible<E: Executor>(executor: &E) -> Result<(), Error> {
    let state = read_compatibility_state(executor).await?;
    check_compatibility(
        state.installed_schema_version,
        sql::CLIENT_PROTOCOL_VERSION,
        &state.served_protocol_versions,
    )
    .map_err(|code| Error::Compatibility { code })
}
