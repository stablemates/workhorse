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

    // The shared vectors of typescript/core/test/checkpoint-fingerprint.test.ts. The last vector
    // orders keys by UTF-16 code units: U+1F600 encodes as D83D DE00, before U+FB33. 2^53 - 1 is
    // the largest number magnitude that an input can hold.
    #[test]
    fn the_fingerprint_gives_the_shared_vectors() {
        let vectors = [
            (json!(null), "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"),
            (json!(true), "b5bea41b6c623f7c09f1bf24dcae58ebab3c0cdd90ad966bc43a45b44867e12b"),
            (json!(0), "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9"),
            (json!(1.5), "9f29a130438b81170b92a42650f9a94291ecad60bd47af2a3886e75f7f728725"),
            (
                json!(9_007_199_254_740_991_i64),
                "f40b423c2dd95ff2b2f027e22208f438cf7242862e5e746860e697308c9add26",
            ),
            (
                json!(-9_007_199_254_740_991_i64),
                "4c933a456bb8f2e9894b2d0b26480439cd72d52fb8a27cbf8fd7f323f22c7815",
            ),
            (
                json!(9_007_199_254_740_991.0),
                "f40b423c2dd95ff2b2f027e22208f438cf7242862e5e746860e697308c9add26",
            ),
            (json!(1e-7), "5b33e02f2c5103a05d32f6ba9cb058294452bfbf393967f68bb30c1bdcbbab22"),
            (json!("é"), "f2886017e9c7abacf804b54d64787dce2b611c9544ba21f3affdd126a6e50086"),
            (json!([]), "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"),
            (json!({}), "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"),
            (
                json!({ "amountCents": 1000, "currency": "EUR" }),
                "f5e4dce1a6a38b7186257335fb274c4221391505f139b60596c5f57ce4924471",
            ),
            (
                json!({ "b": [1, { "d": 2, "c": 3 }], "a": "x" }),
                "4bc2f0faf907fa5fdaedde9cbf7002e3cbf041208b96a4ab4ce6693fbf4bea67",
            ),
            (
                json!({ "\u{1F600}": 1, "\u{FB33}": 2 }),
                "2aa3f5086e32bb90ce39c508a6f40fd72e792684f130d0f3b896ea191368f1e3",
            ),
        ];
        for (input, digest) in vectors {
            assert_eq!(checkpoint_input_fingerprint(&input).unwrap(), digest, "input {input}");
        }
    }

    #[test]
    fn key_order_and_number_form_do_not_change_the_fingerprint() {
        let charge = json!({ "amountCents": 1000, "currency": "EUR" });
        let fingerprint = checkpoint_input_fingerprint(&charge).unwrap();
        let reordered = HashMap::from([("currency", json!("EUR")), ("amountCents", json!(1000))]);
        assert_eq!(checkpoint_input_fingerprint(&reordered).unwrap(), fingerprint);
        let float = json!({ "amountCents": 1000.0, "currency": "EUR" });
        assert_eq!(checkpoint_input_fingerprint(&float).unwrap(), fingerprint);
        let discounted = json!({ "amountCents": 900, "currency": "EUR" });
        assert_ne!(checkpoint_input_fingerprint(&discounted).unwrap(), fingerprint);
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
    fn strings_use_the_json_stringify_escapes() {
        let mut out = String::new();
        write_string("a\"\\\u{8}\u{c}\n\r\t\u{1}\u{1f}\u{7f}\u{2028}é", &mut out);
        assert_eq!(out, "\"a\\\"\\\\\\b\\f\\n\\r\\t\\u0001\\u001f\u{7f}\u{2028}é\"");
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
