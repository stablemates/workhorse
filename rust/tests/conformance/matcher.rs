//! The shared fixture value language, ported from the Python and Go conformance lanes.
//!
//! A fixture writes expected values as JSON. `{"$ref": name}` compares with a value an earlier step
//! captured, and `{"$type": kind}` accepts any value of that kind. Every other value must match
//! exactly, and an object must have the same keys.

use std::collections::BTreeMap;

use chrono::{DateTime, NaiveDateTime};
use serde_json::Value;
use uuid::Uuid;

pub type References = BTreeMap<String, Value>;

/// Replace every `{"$ref": name}` parameter with the captured value.
pub fn resolve(value: &Value, references: &References) -> Result<Value, String> {
    match value {
        Value::Array(items) => items
            .iter()
            .map(|item| resolve(item, references))
            .collect::<Result<_, _>>()
            .map(Value::Array),
        Value::Object(fields) => {
            if let Some(name) = single_key(fields, "$ref") {
                return references
                    .get(name)
                    .cloned()
                    .ok_or_else(|| format!("unknown reference {name}"));
            }
            fields
                .iter()
                .map(|(key, item)| Ok((key.clone(), resolve(item, references)?)))
                .collect::<Result<_, String>>()
                .map(Value::Object)
        }
        _ => Ok(value.clone()),
    }
}

/// Match `actual` against the expected fixture value, naming the first mismatch.
pub fn assert_value(
    expected: &Value,
    actual: &Value,
    references: &References,
    location: &str,
) -> Result<(), String> {
    match expected {
        Value::Object(fields) if fields.contains_key("$ref") => {
            let name =
                fields["$ref"].as_str().ok_or_else(|| format!("{location} names no reference"))?;
            let captured = references
                .get(name)
                .ok_or_else(|| format!("{location} names unknown reference {name}"))?;
            if same(captured, actual) {
                Ok(())
            } else {
                Err(format!("{location} expected reference {name} = {captured}, received {actual}"))
            }
        }
        Value::Object(fields) if fields.contains_key("$type") => {
            let kind =
                fields["$type"].as_str().ok_or_else(|| format!("{location} names no type"))?;
            assert_matcher(kind, actual, location)
        }
        Value::Object(fields) => {
            let Value::Object(actual_fields) = actual else {
                return Err(format!("{location} expected an object, received {actual}"));
            };
            let expected_keys: Vec<_> = fields.keys().collect();
            let actual_keys: Vec<_> = actual_fields.keys().collect();
            if expected_keys != actual_keys {
                return Err(format!(
                    "{location} expected keys {expected_keys:?}, received {actual_keys:?}"
                ));
            }
            for (key, value) in fields {
                assert_value(value, &actual_fields[key], references, &format!("{location}.{key}"))?;
            }
            Ok(())
        }
        Value::Array(items) => {
            let Value::Array(actual_items) = actual else {
                return Err(format!("{location} expected an array, received {actual}"));
            };
            if items.len() != actual_items.len() {
                return Err(format!(
                    "{location} expected {} items, received {}: {actual}",
                    items.len(),
                    actual_items.len()
                ));
            }
            for (index, (item, actual_item)) in items.iter().zip(actual_items).enumerate() {
                assert_value(item, actual_item, references, &format!("{location}[{index}]"))?;
            }
            Ok(())
        }
        _ if same(expected, actual) => Ok(()),
        _ => Err(format!("{location} expected {expected}, received {actual}")),
    }
}

/// Accept `actual` when it is a value of the named fixture type.
pub fn assert_matcher(kind: &str, actual: &Value, location: &str) -> Result<(), String> {
    let accepted = match kind {
        "any" => true,
        "uuid" => actual.as_str().is_some_and(is_uuid),
        "timestamp" => actual.as_str().is_some_and(is_timestamp),
        "string" => actual.is_string(),
        "integer" => actual.is_i64() || actual.is_u64(),
        "number" => actual.as_f64().is_some_and(f64::is_finite),
        "boolean" => actual.is_boolean(),
        _ => return Err(format!("{location} names unknown matcher type {kind}")),
    };
    if accepted {
        Ok(())
    } else {
        Err(format!("{location} expected {kind}, received {actual}"))
    }
}

/// Follow a dotted capture path, reading list segments as indexes.
pub fn read_pointer(value: &Value, pointer: &str) -> Result<Value, String> {
    let mut current = value;
    for segment in pointer.split('.') {
        current = match current {
            Value::Array(items) => segment.parse::<usize>().ok().and_then(|index| items.get(index)),
            Value::Object(fields) => fields.get(segment),
            _ => None,
        }
        .ok_or_else(|| format!("capture pointer {pointer} does not resolve at {segment}"))?;
    }
    Ok(current.clone())
}

/// Render a timestamp the way every lane normalizes one: UTC, trailing fractional zeros removed.
pub fn normalize_timestamp(value: DateTime<chrono::Utc>) -> Value {
    let whole = value.format("%Y-%m-%dT%H:%M:%S").to_string();
    let fraction = format!("{:09}", value.timestamp_subsec_nanos());
    let fraction = fraction.trim_end_matches('0');
    Value::String(if fraction.is_empty() {
        format!("{whole}Z")
    } else {
        format!("{whole}.{fraction}Z")
    })
}

pub fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
        && Uuid::parse_str(value).is_ok()
}

/// Accept an RFC 3339 instant with an explicit offset and at most nine fractional digits.
pub fn is_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 20 || !shape(&bytes[..19], b"dddd-dd-ddTdd:dd:dd") {
        return false;
    }
    let mut rest = &bytes[19..];
    if rest.first() == Some(&b'.') {
        let digits = rest[1..].iter().take_while(|byte| byte.is_ascii_digit()).count();
        if !(1..=9).contains(&digits) {
            return false;
        }
        rest = &rest[1 + digits..];
    }
    let offset_ok = rest == b"Z"
        || (rest.len() == 6 && matches!(rest[0], b'+' | b'-') && shape(&rest[1..], b"dd:dd"));
    offset_ok
        && DateTime::parse_from_rfc3339(value).is_ok()
        && NaiveDateTime::parse_from_str(&value[..19], "%Y-%m-%dT%H:%M:%S").is_ok()
}

fn shape(bytes: &[u8], pattern: &[u8]) -> bool {
    bytes.len() == pattern.len()
        && bytes.iter().zip(pattern).all(|(byte, expected)| match expected {
            b'd' => byte.is_ascii_digit(),
            _ => byte == expected,
        })
}

/// Compare two JSON values, treating numbers by value so `1` and `1.0` agree as they do elsewhere.
pub fn same(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => {
            if let (Some(left), Some(right)) = (left.as_i64(), right.as_i64()) {
                left == right
            } else if let (Some(left), Some(right)) = (left.as_u64(), right.as_u64()) {
                left == right
            } else {
                left.as_f64() == right.as_f64()
            }
        }
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len()
                && left.iter().zip(right).all(|(left, right)| same(left, right))
        }
        (Value::Object(left), Value::Object(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .all(|(key, value)| right.get(key).is_some_and(|other| same(value, other)))
        }
        _ => left == right,
    }
}

pub fn single_key<'a>(fields: &'a serde_json::Map<String, Value>, key: &str) -> Option<&'a str> {
    if fields.len() == 1 {
        fields.get(key).and_then(Value::as_str)
    } else {
        None
    }
}
