//! Measures a handler result the way PostgreSQL enforces its size limit.
//!
//! The completion statements refuse a result whose `octet_length(result::jsonb::text)` exceeds the
//! task's `result_max_bytes`. That refusal is a database error, which would end the settlement
//! rather than the attempt, so the worker measures the same text first and fails the attempt
//! through the task's retry policy instead.
use serde_json::{Number, Value};

/// Returns the UTF-8 length of PostgreSQL's jsonb text for `value`.
///
/// That text puts a space after each `:` and `,`, escapes only `"`, `\` and control characters,
/// and writes numbers in plain decimal notation. A `Value` object already holds one entry per key,
/// as jsonb does.
pub(super) fn jsonb_text_bytes(value: &Value) -> usize {
    let mut total = 0;
    let mut pending = vec![value];
    while let Some(item) = pending.pop() {
        total += match item {
            Value::Null | Value::Bool(true) => 4,
            Value::Bool(false) => 5,
            Value::Number(number) => numeric_text_bytes(number),
            Value::String(text) => string_bytes(text),
            Value::Array(items) => {
                pending.extend(items);
                2 + items.len().saturating_sub(1) * 2
            }
            Value::Object(entries) => {
                let mut bytes = 2 + entries.len().saturating_sub(1) * 2;
                for (key, entry) in entries {
                    bytes += string_bytes(key) + 2;
                    pending.push(entry);
                }
                bytes
            }
        };
    }
    total
}

/// Measures a string as PostgreSQL's `escape_json` writes it: two-character escapes for `"`, `\`
/// and `\b \f \n \r \t`, a `\u00XX` escape for any other control character, and every other
/// character as raw UTF-8.
fn string_bytes(text: &str) -> usize {
    2 + text
        .chars()
        .map(|character| match character {
            '"' | '\\' | '\u{8}' | '\u{c}' | '\n' | '\r' | '\t' => 2,
            '\0'..='\u{1f}' => 6,
            other => other.len_utf8(),
        })
        .sum::<usize>()
}

/// Measures `numeric_out` for the token serde_json sends, which may use exponent notation.
/// `numeric_out` writes the integer part without leading zeros and as many fraction digits as the
/// token had after its decimal point, less the exponent. Zero has no sign.
fn numeric_text_bytes(number: &Number) -> usize {
    // An integer prints its digits as they are, so only a float needs its token.
    if let Some(value) = number.as_u64() {
        return digits(value);
    }
    if let Some(value) = number.as_i64() {
        return 1 + digits(value.unsigned_abs());
    }
    let token = number.to_string().to_ascii_lowercase();
    let (mantissa, exponent) = match token.split_once('e') {
        Some((mantissa, exponent)) => match exponent.trim_start_matches('+').parse::<i64>() {
            Ok(exponent) => (mantissa, exponent),
            // PostgreSQL refuses an exponent this large, so the database reports the value.
            Err(_) => return token.len(),
        },
        None => (token.as_str(), 0),
    };
    let (negative, mantissa) = match mantissa.strip_prefix('-') {
        Some(unsigned) => (true, unsigned),
        None => (false, mantissa),
    };
    let (integer_digits, fraction_digits) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = format!("{integer_digits}{fraction_digits}");
    let point = integer_digits.len() as i64 + exponent;
    let mut integer_length = 1;
    if point > 0 {
        let available = point.min(digits.len() as i64) as usize;
        let leading_zeros = digits[..available].bytes().take_while(|digit| *digit == b'0').count();
        if leading_zeros < available {
            integer_length = point as usize - leading_zeros;
        }
    }
    let scale = (fraction_digits.len() as i64 - exponent).max(0) as usize;
    let mut bytes = integer_length;
    if scale > 0 {
        bytes += 1 + scale;
    }
    if negative && digits.bytes().any(|digit| digit != b'0') {
        bytes += 1;
    }
    bytes
}

fn digits(value: u64) -> usize {
    value.checked_ilog10().map_or(1, |log| log as usize + 1)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::jsonb_text_bytes;

    #[test]
    fn measures_the_text_postgresql_prints() {
        // Each expectation is octet_length(value::jsonb::text) from PostgreSQL.
        let cases = [
            (json!(null), 4),
            (json!(true), 4),
            (json!(false), 5),
            (json!(0), 1),
            (json!(-17), 3),
            (json!(9_007_199_254_740_991_u64), 16),
            (json!(u64::MAX), 20),
            (json!(i64::MIN), 20),
            (json!(10), 2),
            (json!(1.5), 3),
            (json!(-0.0), 3),
            (json!(1e21), 22),
            (json!(1.2e-7), 10),
            (json!(-2.5e-3), 7),
            (json!(""), 2),
            (json!("quote \" backslash \\ newline \n"), 34),
            (json!("\u{1}"), 8),
            (json!("é日🐎"), 11),
            (json!([]), 2),
            (json!({}), 2),
            (json!([0, 0, 0]), 9),
            (json!({"a": 1, "b": [true, null]}), 27),
        ];
        for (value, expected) in cases {
            assert_eq!(jsonb_text_bytes(&value), expected, "{value}");
        }
    }
}
