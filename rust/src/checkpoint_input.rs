//! The input fingerprint a checkpoint stores for one input (ADR 0098).
//!
//! Each SDK must give the same digest for the same input, so the canonical form is RFC 8785.
//! `serde_json` does not write that form: its key order is by bytes or by insertion, and its
//! numbers keep the integer or float form of the source.
use serde::Serialize;
use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};

use crate::context::finite_json;
use crate::Error;

/// Returns the input fingerprint that a checkpoint stores for `input`: the SHA-256 digest of the
/// canonical JSON form of the input (RFC 8785), as 64 lowercase hexadecimal characters.
///
/// The canonical form sorts the keys of each object by their UTF-16 code units and writes no
/// whitespace. Each number is an IEEE 754 double in the ECMAScript form, so `1`, `1.0` and `1e0`
/// give one digest. Thus two inputs that differ only in key order have the same fingerprint. The
/// input must serialize to JSON with finite numbers of at most 2^53 - 1 in magnitude. A larger
/// number can be an integer that a double does not hold exactly, so every SDK refuses it with
/// `Error::InvalidArgument` (ADR 0098).
pub fn checkpoint_input_fingerprint<T: Serialize + ?Sized>(input: &T) -> Result<String, Error> {
    let value = finite_json(input, "Checkpoint input")?;
    let mut canonical = String::new();
    write_canonical(&value, &mut canonical)?;
    let digest = Sha256::digest(canonical.as_bytes());
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn write_canonical(value: &Value, out: &mut String) -> Result<(), Error> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => out.push_str(&ecmascript_number(safe_number(number)?)?),
        Value::String(text) => write_string(text, out),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_canonical(item, out)?;
            }
            out.push(']');
        }
        Value::Object(members) => write_object(members, out)?,
    }
    Ok(())
}

fn write_object(members: &Map<String, Value>, out: &mut String) -> Result<(), Error> {
    let mut keys: Vec<&String> = members.keys().collect();
    // RFC 8785 orders keys by UTF-16 code units, which differs from byte order above U+FFFF.
    keys.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    out.push('{');
    for (index, key) in keys.into_iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        write_string(key, out);
        out.push(':');
        write_canonical(&members[key], out)?;
    }
    out.push('}');
    Ok(())
}

/// The largest number magnitude that a checkpoint input can hold. I-JSON (RFC 7493) keeps integers
/// to the range that an IEEE 754 double holds exactly.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Refuses a number above 2^53 - 1 in magnitude. A larger `i64` or `u64` rounds to a double of at
/// least 2^53, and each double of 2^53 or more is an integer, so this refuses no fraction.
fn safe_number(number: &Number) -> Result<&Number, Error> {
    match number.as_f64() {
        Some(value) if value.is_finite() && value.abs() > MAX_SAFE_INTEGER => {
            Err(Error::invalid("Checkpoint input numbers must be at most 2^53 - 1 in magnitude"))
        }
        _ => Ok(number),
    }
}

/// Writes a string as `JSON.stringify` does. A Rust string is well-formed UTF-8, so it holds no
/// lone surrogate, and `serde_json` escapes the same characters with lowercase hexadecimal.
fn write_string(text: &str, out: &mut String) {
    out.push_str(&serde_json::to_string(text).expect("a string always serializes"));
}

/// Formats a number as ECMAScript `Number.prototype.toString` formats the nearest double.
///
/// The standard library writes the shortest digits that round-trip, but when two such forms are
/// equally near the exact value it can take the other one. `ryu-js` follows ECMAScript there.
///
/// With the `serde_json` feature `arbitrary_precision`, which another crate can turn on, a number
/// such as `1e309` has no finite double. Such a number is refused.
fn ecmascript_number(number: &Number) -> Result<String, Error> {
    match number.as_f64() {
        Some(value) if value.is_finite() => Ok(ryu_js::Buffer::new().format_finite(value).into()),
        _ => Err(Error::invalid("Checkpoint input value must contain only finite numbers")),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use serde_json::json;

    use super::*;

    /// `protocol/v1/checkpoint-fingerprints.json` holds the vectors that every SDK must give.
    /// `serde_json` refuses a lone surrogate escape and a number outside the double range when it
    /// decodes the text, before the fingerprint.
    #[test]
    fn the_fingerprint_gives_the_shared_vectors() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../protocol/v1/checkpoint-fingerprints.json");
        let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let vectors = fixture["vectors"].as_array().unwrap();
        assert!(!vectors.is_empty());
        for vector in vectors {
            let id = vector["id"].as_str().unwrap();
            let decoded = serde_json::from_str::<Value>(vector["input"].as_str().unwrap());
            match (vector["refusal"].as_str(), decoded) {
                (None, Ok(input)) => assert_eq!(
                    checkpoint_input_fingerprint(&input).unwrap(),
                    vector["digest"].as_str().unwrap(),
                    "vector {id}"
                ),
                (Some(refusal @ ("loneSurrogate" | "nonFinite")), Err(error)) => {
                    let cause = if refusal == "loneSurrogate" {
                        "hex escape"
                    } else {
                        "number out of range"
                    };
                    assert!(error.to_string().contains(cause), "vector {id}: {error}");
                }
                (Some(refusal @ ("unsafeNumber" | "nonFinite")), Ok(input)) => {
                    let expected = if refusal == "unsafeNumber" {
                        "Checkpoint input numbers must be at most 2^53 - 1 in magnitude"
                    } else {
                        // The `serde_json` feature `arbitrary_precision` decodes such a number.
                        "Checkpoint input value must contain only finite numbers"
                    };
                    match checkpoint_input_fingerprint(&input) {
                        Err(Error::InvalidArgument(message)) => {
                            assert_eq!(message, expected, "vector {id}")
                        }
                        other => panic!("vector {id}: expected a refusal, got {other:?}"),
                    }
                }
                (refusal, decoded) => {
                    panic!("vector {id}: refusal {refusal:?}, decoded {decoded:?}")
                }
            }
        }
    }

    #[test]
    fn a_serialize_type_has_the_fingerprint_of_its_json() {
        let charge = json!({ "amountCents": 1000, "currency": "EUR" });
        let reordered = HashMap::from([("currency", json!("EUR")), ("amountCents", json!(1000.0))]);
        assert_eq!(
            checkpoint_input_fingerprint(&reordered).unwrap(),
            checkpoint_input_fingerprint(&charge).unwrap()
        );
        assert_eq!(
            checkpoint_input_fingerprint(&-0.0).unwrap(),
            checkpoint_input_fingerprint(&0).unwrap()
        );
    }

    #[test]
    fn numbers_use_the_ecmascript_form() {
        let cases = [
            (json!(1), "1"),
            (json!(-1.5), "-1.5"),
            (json!(100), "100"),
            (json!(123456789012345680000.0), "123456789012345680000"),
            (json!(1e21), "1e+21"),
            (json!(1.25e22), "1.25e+22"),
            (json!(0.000001), "0.000001"),
            (json!(1e-7), "1e-7"),
            (json!(-2.5e-8), "-2.5e-8"),
            (json!(0.1), "0.1"),
            (json!(u64::MAX), "18446744073709552000"),
            (json!(f64::MAX), "1.7976931348623157e+308"),
            (json!(5e-324), "5e-324"),
            // The exact value ends in .25, between two shortest forms. ECMAScript takes the even
            // digit, .2.
            (json!(-1010086764207289.2), "-1010086764207289.2"),
        ];
        for (input, text) in cases {
            let Value::Number(number) = &input else { unreachable!() };
            assert_eq!(ecmascript_number(number).unwrap(), text);
        }
    }

    #[test]
    fn an_input_with_a_non_finite_number_is_refused() {
        match checkpoint_input_fingerprint(&vec![1.0, f64::NAN]) {
            Err(Error::InvalidArgument(message)) => {
                assert_eq!(message, "Checkpoint input value must contain only finite numbers");
            }
            other => panic!("expected a refusal, got {other:?}"),
        }
    }

    #[test]
    fn a_number_larger_than_2_pow_53_minus_1_in_magnitude_is_refused() {
        let inputs = [
            json!(9_007_199_254_740_992_u64),
            json!(-9_007_199_254_740_992_i64),
            json!({ "id": 9_007_199_254_740_993_u64 }),
            json!(u64::MAX),
            json!(i64::MIN),
            json!(9_007_199_254_740_992.0),
            json!([1e21]),
            json!(-f64::MAX),
        ];
        for input in inputs {
            match checkpoint_input_fingerprint(&input) {
                Err(Error::InvalidArgument(message)) => assert_eq!(
                    message, "Checkpoint input numbers must be at most 2^53 - 1 in magnitude",
                    "input {input}"
                ),
                other => panic!("expected a refusal of {input}, got {other:?}"),
            }
        }
    }

    // A Rust `String` and a `serde_json::Value` hold only valid UTF-8, so invalid text cannot
    // reach the fingerprint. The conversions into them refuse it.
    #[test]
    fn invalid_text_cannot_become_an_input() {
        assert!(String::from_utf8(vec![b'a', 0xff]).is_err());
        assert!(serde_json::from_slice::<Value>(b"\"\xff\"").is_err());
        assert!(serde_json::from_str::<Value>(r#""\ud800""#).is_err());
        assert!(serde_json::from_str::<Value>(r#"{"\ud83d": 1}"#).is_err());
    }
}
