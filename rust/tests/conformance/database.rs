//! The translation between fixture JSON and PostgreSQL values.
//!
//! The scratch database each fixture runs in comes from the shared `support` module.

use std::error::Error as StdError;
use std::path::PathBuf;

use chrono::{DateTime, NaiveDateTime, NaiveTime, Utc};
use serde_json::{Map, Number, Value};
use tokio_postgres::types::{FromSql, ToSql, Type};
use tokio_postgres::{Row, Statement};
use uuid::Uuid;

use super::matcher::normalize_timestamp;

pub fn repository() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// Render a driver error with the database's own message when PostgreSQL produced it.
pub fn describe(error: &tokio_postgres::Error) -> String {
    match error.as_db_error() {
        Some(database) => format!("{} ({})", database.message(), database.code().code()),
        None => match error.source() {
            Some(source) => format!("{error}: {source}"),
            None => error.to_string(),
        },
    }
}

/// The error shape the fixtures compare: SQLSTATE, primary message, and JSON detail when present.
pub fn database_error(error: &tokio_postgres::Error) -> Result<Value, String> {
    let database = error
        .as_db_error()
        .ok_or_else(|| format!("expected a database error, received {}", describe(error)))?;
    let mut actual = Map::new();
    actual.insert("code".to_owned(), Value::String(database.code().code().to_owned()));
    actual.insert("message".to_owned(), Value::String(database.message().to_owned()));
    if let Some(detail) = database.detail() {
        let detail = serde_json::from_str(detail)
            .map_err(|parse| format!("error detail is not JSON ({parse}): {detail}"))?;
        actual.insert("detail".to_owned(), detail);
    }
    Ok(Value::Object(actual))
}

pub type Parameter = Box<dyn ToSql + Sync + Send>;

/// Convert a fixture parameter to the type PostgreSQL inferred for its placeholder.
pub fn parameter(value: &Value, kind: &Type) -> Result<Parameter, String> {
    let mismatch = || format!("cannot bind {value} as {kind}");
    Ok(match *kind {
        Type::JSON | Type::JSONB => match value {
            // A string bound to JSON is JSON text, as psycopg and pgx send it.
            Value::String(text) => {
                Box::new(serde_json::from_str::<Value>(text).map_err(|_| mismatch())?)
            }
            Value::Null => Box::new(None::<Value>),
            _ => Box::new(value.clone()),
        },
        _ if value.is_null() => null_of(kind).ok_or_else(mismatch)?,
        Type::BOOL => Box::new(value.as_bool().ok_or_else(mismatch)?),
        Type::INT2 => {
            Box::new(i16::try_from(value.as_i64().ok_or_else(mismatch)?).map_err(|_| mismatch())?)
        }
        Type::INT4 => {
            Box::new(i32::try_from(value.as_i64().ok_or_else(mismatch)?).map_err(|_| mismatch())?)
        }
        Type::INT8 => Box::new(value.as_i64().ok_or_else(mismatch)?),
        Type::FLOAT8 => Box::new(value.as_f64().ok_or_else(mismatch)?),
        Type::TEXT | Type::VARCHAR | Type::NAME | Type::BPCHAR | Type::UNKNOWN => {
            Box::new(value.as_str().ok_or_else(mismatch)?.to_owned())
        }
        Type::UUID => {
            Box::new(Uuid::parse_str(value.as_str().ok_or_else(mismatch)?).map_err(|_| mismatch())?)
        }
        Type::TIMESTAMPTZ => Box::new(
            DateTime::parse_from_rfc3339(value.as_str().ok_or_else(mismatch)?)
                .map_err(|_| mismatch())?
                .with_timezone(&Utc),
        ),
        Type::TIME => {
            let text = value.as_str().ok_or_else(mismatch)?;
            Box::new(
                NaiveTime::parse_from_str(text, "%H:%M:%S")
                    .or_else(|_| NaiveTime::parse_from_str(text, "%H:%M"))
                    .map_err(|_| mismatch())?,
            )
        }
        Type::TEXT_ARRAY => Box::new(
            value
                .as_array()
                .ok_or_else(mismatch)?
                .iter()
                .map(|item| item.as_str().map(str::to_owned).ok_or_else(mismatch))
                .collect::<Result<Vec<_>, _>>()?,
        ),
        _ => return Err(format!("the Rust runner cannot bind parameters of type {kind}")),
    })
}

fn null_of(kind: &Type) -> Option<Parameter> {
    Some(match *kind {
        Type::BOOL => Box::new(None::<bool>),
        Type::INT2 => Box::new(None::<i16>),
        Type::INT4 => Box::new(None::<i32>),
        Type::INT8 => Box::new(None::<i64>),
        Type::FLOAT8 => Box::new(None::<f64>),
        Type::TEXT | Type::VARCHAR | Type::NAME | Type::BPCHAR | Type::UNKNOWN => {
            Box::new(None::<String>)
        }
        Type::UUID => Box::new(None::<Uuid>),
        Type::TIMESTAMPTZ => Box::new(None::<DateTime<Utc>>),
        Type::TIME => Box::new(None::<NaiveTime>),
        Type::TEXT_ARRAY => Box::new(None::<Vec<String>>),
        _ => return None,
    })
}

/// Bind resolved fixture parameters to a prepared statement's inferred types.
pub fn parameters(statement: &Statement, values: &[Value]) -> Result<Vec<Parameter>, String> {
    if statement.params().len() != values.len() {
        return Err(format!(
            "statement takes {} parameters, fixture gives {}",
            statement.params().len(),
            values.len()
        ));
    }
    statement.params().iter().zip(values).map(|(kind, value)| parameter(value, kind)).collect()
}

pub fn borrow(parameters: &[Parameter]) -> Vec<&(dyn ToSql + Sync)> {
    parameters.iter().map(|parameter| parameter.as_ref() as &(dyn ToSql + Sync)).collect()
}

/// Decode every row into the normalized JSON the fixtures compare.
pub fn rows(rows: &[Row]) -> Result<Value, String> {
    rows.iter()
        .map(|row| {
            row.columns()
                .iter()
                .enumerate()
                .map(|(index, column)| {
                    Ok((column.name().to_owned(), cell(row, index, column.type_())?))
                })
                .collect::<Result<Map<_, _>, String>>()
                .map(Value::Object)
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Value::Array)
}

fn cell(row: &Row, index: usize, kind: &Type) -> Result<Value, String> {
    fn get<'a, T: FromSql<'a>>(row: &'a Row, index: usize) -> Result<Option<T>, String> {
        row.try_get::<_, Option<T>>(index)
            .map_err(|error| format!("decode column {index}: {error}"))
    }
    fn json<T: Into<Value>>(value: Option<T>) -> Value {
        value.map_or(Value::Null, Into::into)
    }
    Ok(match *kind {
        Type::BOOL => json(get::<bool>(row, index)?),
        Type::INT2 => json(get::<i16>(row, index)?),
        Type::INT4 => json(get::<i32>(row, index)?),
        Type::INT8 => json(get::<i64>(row, index)?),
        Type::FLOAT4 => json(get::<f32>(row, index)?),
        Type::FLOAT8 => json(get::<f64>(row, index)?),
        Type::NUMERIC => get::<Numeric>(row, index)?.map_or(Value::Null, |numeric| numeric.0),
        Type::TEXT | Type::VARCHAR | Type::NAME | Type::BPCHAR => json(get::<String>(row, index)?),
        Type::UUID => json(get::<Uuid>(row, index)?.map(|uuid| uuid.to_string())),
        Type::TIMESTAMPTZ => {
            get::<DateTime<Utc>>(row, index)?.map_or(Value::Null, normalize_timestamp)
        }
        Type::TIMESTAMP => get::<NaiveDateTime>(row, index)?.map_or(Value::Null, |local| {
            let Value::String(text) = normalize_timestamp(local.and_utc()) else { unreachable!() };
            Value::String(text.trim_end_matches('Z').to_owned())
        }),
        Type::JSON | Type::JSONB => get::<Value>(row, index)?.unwrap_or(Value::Null),
        // The fixtures record a void result as an empty string, which is how psycopg reads one.
        Type::VOID => Value::String(String::new()),
        Type::TEXT_ARRAY => json(get::<Vec<Option<String>>>(row, index)?),
        Type::INT4_ARRAY => json(get::<Vec<Option<i32>>>(row, index)?),
        Type::INT8_ARRAY => json(get::<Vec<Option<i64>>>(row, index)?),
        Type::UUID_ARRAY => json(get::<Vec<Option<Uuid>>>(row, index)?.map(|items| {
            items.into_iter().map(|item| item.map(|uuid| uuid.to_string())).collect::<Vec<_>>()
        })),
        Type::JSONB_ARRAY => json(get::<Vec<Option<Value>>>(row, index)?),
        _ => return Err(format!("the Rust runner cannot decode column type {kind}")),
    })
}

/// PostgreSQL `numeric`, normalized like the other lanes: integral values become integers.
struct Numeric(Value);

impl<'a> FromSql<'a> for Numeric {
    fn from_sql(_: &Type, raw: &'a [u8]) -> Result<Self, Box<dyn StdError + Sync + Send>> {
        let word = |index: usize| -> Result<u16, Box<dyn StdError + Sync + Send>> {
            raw.get(index * 2..index * 2 + 2)
                .map(|bytes| u16::from_be_bytes([bytes[0], bytes[1]]))
                .ok_or_else(|| "truncated numeric".into())
        };
        let digits = word(0)? as usize;
        let weight = word(1)? as i16 as i32;
        let sign = word(2)?;
        let scale = word(3)? as usize;
        if sign == 0xC000 {
            return Err("NaN numeric has no JSON form".into());
        }
        let mut integer = String::new();
        let mut fraction = String::new();
        for position in 0..digits {
            let digit = word(4 + position)?;
            let power = weight - position as i32;
            if power >= 0 {
                integer.push_str(&format!("{digit:04}"));
            } else {
                // Leading zero groups between the point and the first stored digit.
                while fraction.len() < ((-power - 1) as usize) * 4 {
                    fraction.push_str("0000");
                }
                fraction.push_str(&format!("{digit:04}"));
            }
        }
        for _ in 0..(weight + 1 - digits.min((weight + 1).max(0) as usize) as i32).max(0) {
            integer.push_str("0000");
        }
        let integer = integer.trim_start_matches('0');
        let integer = if integer.is_empty() { "0" } else { integer };
        fraction.truncate(scale.min(fraction.len()));
        let negative = if sign == 0x4000 { "-" } else { "" };
        let value = if fraction.trim_end_matches('0').is_empty() {
            format!("{negative}{integer}").parse::<i64>().map(Value::from).or_else(|_| {
                format!("{negative}{integer}")
                    .parse::<f64>()
                    .map(|float| Number::from_f64(float).map_or(Value::Null, Value::Number))
            })?
        } else {
            let float: f64 = format!("{negative}{integer}.{fraction}").parse()?;
            Number::from_f64(float).map_or(Value::Null, Value::Number)
        };
        Ok(Self(value))
    }

    fn accepts(kind: &Type) -> bool {
        *kind == Type::NUMERIC
    }
}
