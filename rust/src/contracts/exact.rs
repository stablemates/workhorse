//! Exact numbers in a contract schema.
//!
//! A contract compares the decimal of each number exactly. A `serde_json::Value` reads a fraction,
//! and an integer outside `i64` and `u64`, as an `f64`, but PostgreSQL keeps every digit of a
//! schema number that another SDK synchronized. [`parse`] reads the stored jsonb text and keeps
//! each number token. The keywords here replace the jsonschema-rs bound, `multipleOf`, `const`,
//! `enum`, and `uniqueItems` keywords, which compare binary values.
use std::cmp::Ordering;
use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use jsonschema::paths::Location;
use jsonschema::{Keyword, ValidationError, ValidationOptions};
use serde_json::{Map, Number, Value};

use super::{SCHEMA_ARRAYS, SCHEMA_MAPS, SCHEMA_VALUES};

/// The key that carries a schema object's exact keyword values to the keyword factories. The
/// profile check runs on the schema without it, and it refuses the key in an application schema.
const EXACT_KEY: &str = "$workhorse.exact";
const EXACT_KEYWORDS: &[&str] =
    &["const", "enum", "exclusiveMaximum", "exclusiveMinimum", "maximum", "minimum", "multipleOf"];
/// serde_json refuses a document that nests deeper than this, so a stored schema does too.
const MAX_DEPTH: usize = 128;

/// The exact keyword values of each schema object that has one, by its `EXACT_KEY` index.
pub(super) type ExactValues = Arc<Vec<BTreeMap<String, Canonical>>>;

/// A JSON value from stored jsonb text, with each number as its token.
pub(super) enum Exact {
    Null,
    Bool(bool),
    Number(String),
    String(String),
    Array(Vec<Exact>),
    Object(Vec<(String, Exact)>),
}

impl Exact {
    /// The member `name` of an object.
    pub(super) fn member(&self, name: &str) -> Option<&Exact> {
        let Exact::Object(members) = self else { return None };
        members.iter().rev().find(|(key, _)| key == name).map(|(_, value)| value)
    }

    /// The value as a `serde_json::Value`, which holds the nearest `f64` for a number that it
    /// cannot hold, as `nearest_number` chooses it.
    pub(super) fn to_value(&self) -> Value {
        match self {
            Exact::Null => Value::Null,
            Exact::Bool(value) => Value::Bool(*value),
            Exact::Number(token) => Value::Number(nearest_number(token)),
            Exact::String(value) => Value::String(value.clone()),
            Exact::Array(items) => Value::Array(items.iter().map(Exact::to_value).collect()),
            Exact::Object(members) => Value::Object(
                members.iter().map(|(key, value)| (key.clone(), value.to_value())).collect(),
            ),
        }
    }

    /// True when `to_value` keeps the decimal of every number in the value.
    fn is_held(&self) -> bool {
        match self {
            Exact::Number(token) => {
                Decimal::parse(token) == Some(Decimal::of(&nearest_number(token)))
            }
            Exact::Array(items) => items.iter().all(Exact::is_held),
            Exact::Object(members) => members.iter().all(|(_, value)| value.is_held()),
            Exact::Null | Exact::Bool(_) | Exact::String(_) => true,
        }
    }
}

/// jsonschema-rs checks the schema against the meta-schema, so the nearest number keeps the sign
/// of the token and stays non-zero: a number outside the `f64` range becomes the largest finite
/// `f64`, and a non-zero number below it becomes the smallest positive `f64`.
fn nearest_number(token: &str) -> Number {
    let sign = if token.starts_with('-') { -1.0 } else { 1.0 };
    let nearest = serde_json::from_str::<Number>(token)
        .unwrap_or_else(|_| Number::from_f64(sign * f64::MAX).expect("the largest f64 is finite"));
    let rounded_to_zero = nearest.as_f64() == Some(0.0)
        && Decimal::parse(token).is_some_and(|decimal| !decimal.is_zero());
    if rounded_to_zero {
        let smallest = sign * f64::from_bits(1);
        return Number::from_f64(smallest).expect("the smallest f64 is finite");
    }
    nearest
}

/// The schema as a `serde_json::Value` for jsonschema-rs, with the exact keyword values that the
/// `Value` cannot hold. Each schema object that has one gets an `EXACT_KEY` index into `exact`.
/// The walk visits the schema positions that the profile check visits, so a `const` value or a
/// property name never gets the key.
pub(super) fn schema_value(schema: &Exact, exact: &mut Vec<BTreeMap<String, Canonical>>) -> Value {
    let Exact::Object(members) = schema else { return schema.to_value() };
    let mut document = Map::new();
    let mut values = BTreeMap::new();
    for (keyword, value) in members {
        let converted = match value {
            _ if SCHEMA_VALUES.contains(&keyword.as_str()) => schema_value(value, exact),
            Exact::Array(children) if SCHEMA_ARRAYS.contains(&keyword.as_str()) => {
                Value::Array(children.iter().map(|child| schema_value(child, exact)).collect())
            }
            Exact::Object(children) if SCHEMA_MAPS.contains(&keyword.as_str()) => Value::Object(
                children
                    .iter()
                    .map(|(name, child)| (name.clone(), schema_value(child, exact)))
                    .collect(),
            ),
            _ => value.to_value(),
        };
        if EXACT_KEYWORDS.contains(&keyword.as_str()) && !value.is_held() {
            values.insert(keyword.clone(), Canonical::from(value));
        }
        document.insert(keyword.clone(), converted);
    }
    if !values.is_empty() {
        document.insert(EXACT_KEY.to_owned(), Value::from(exact.len()));
        exact.push(values);
    }
    Value::Object(document)
}

/// Reads JSON text and keeps each number token.
pub(super) fn parse(text: &str) -> Result<Exact, String> {
    let mut parser = Parser { text, at: 0, depth: 0 };
    let value = parser.value()?;
    parser.skip_space();
    if parser.at != text.len() {
        return Err(format!("unexpected text at byte {}", parser.at));
    }
    Ok(value)
}

struct Parser<'a> {
    text: &'a str,
    at: usize,
    depth: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.text.as_bytes().get(self.at).copied()
    }

    fn skip_space(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn expect(&mut self, byte: u8) -> Result<(), String> {
        self.skip_space();
        if self.peek() != Some(byte) {
            return Err(format!("expected '{}' at byte {}", byte as char, self.at));
        }
        self.at += 1;
        Ok(())
    }

    fn value(&mut self) -> Result<Exact, String> {
        self.skip_space();
        match self.peek() {
            Some(b'{') => self.nested(Self::object),
            Some(b'[') => self.nested(Self::array),
            Some(b'"') => self.string().map(Exact::String),
            Some(b't') => self.literal("true", Exact::Bool(true)),
            Some(b'f') => self.literal("false", Exact::Bool(false)),
            Some(b'n') => self.literal("null", Exact::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err(format!("expected a JSON value at byte {}", self.at)),
        }
    }

    fn nested(&mut self, read: fn(&mut Self) -> Result<Exact, String>) -> Result<Exact, String> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(format!("JSON nests deeper than {MAX_DEPTH} levels"));
        }
        let value = read(self);
        self.depth -= 1;
        value
    }

    fn object(&mut self) -> Result<Exact, String> {
        self.expect(b'{')?;
        let mut members = Vec::new();
        self.skip_space();
        if self.peek() == Some(b'}') {
            self.at += 1;
            return Ok(Exact::Object(members));
        }
        loop {
            self.skip_space();
            let key = self.string()?;
            self.expect(b':')?;
            members.push((key, self.value()?));
            self.skip_space();
            match self.peek() {
                Some(b',') => self.at += 1,
                Some(b'}') => {
                    self.at += 1;
                    return Ok(Exact::Object(members));
                }
                _ => return Err(format!("expected ',' or '}}' at byte {}", self.at)),
            }
        }
    }

    fn array(&mut self) -> Result<Exact, String> {
        self.expect(b'[')?;
        let mut items = Vec::new();
        self.skip_space();
        if self.peek() == Some(b']') {
            self.at += 1;
            return Ok(Exact::Array(items));
        }
        loop {
            items.push(self.value()?);
            self.skip_space();
            match self.peek() {
                Some(b',') => self.at += 1,
                Some(b']') => {
                    self.at += 1;
                    return Ok(Exact::Array(items));
                }
                _ => return Err(format!("expected ',' or ']' at byte {}", self.at)),
            }
        }
    }

    /// Finds the end of a string token, and lets serde_json decode its escapes.
    fn string(&mut self) -> Result<String, String> {
        let start = self.at;
        if self.peek() != Some(b'"') {
            return Err(format!("expected a string at byte {start}"));
        }
        self.at += 1;
        loop {
            match self.peek() {
                None => return Err(format!("unterminated string at byte {start}")),
                Some(b'\\') => self.at += 2,
                Some(b'"') => break,
                Some(_) => self.at += 1,
            }
        }
        self.at += 1;
        let token = self.text.get(start..self.at).ok_or("a string ends inside a character")?;
        serde_json::from_str(token)
            .map_err(|error| format!("invalid string at byte {start}: {error}"))
    }

    fn number(&mut self) -> Result<Exact, String> {
        let start = self.at;
        while matches!(self.peek(), Some(b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E')) {
            self.at += 1;
        }
        let token = &self.text[start..self.at];
        if Decimal::parse(token).is_none() {
            return Err(format!("invalid number at byte {start}"));
        }
        Ok(Exact::Number(token.to_owned()))
    }

    fn literal(&mut self, word: &str, value: Exact) -> Result<Exact, String> {
        if !self.text[self.at..].starts_with(word) {
            return Err(format!("expected a JSON value at byte {}", self.at));
        }
        self.at += word.len();
        Ok(value)
    }
}

/// A number as digits times ten to the power of `exponent`. `digits` holds ASCII digits without a
/// leading or a trailing zero, so zero has no digits and each value has one form.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct Decimal {
    negative: bool,
    digits: Vec<u8>,
    exponent: i64,
}

impl Decimal {
    /// The exact value of a JSON number token, or `None` for text outside the JSON grammar.
    fn parse(token: &str) -> Option<Decimal> {
        let (negative, unsigned) = match token.strip_prefix('-') {
            Some(rest) => (true, rest),
            None => (false, token),
        };
        let (mantissa, exponent) = match unsigned.find(['e', 'E']) {
            Some(index) => {
                let text = &unsigned[index + 1..];
                let digits = text.strip_prefix(['+', '-']).unwrap_or(text);
                if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
                    return None;
                }
                (&unsigned[..index], text.parse::<i64>().ok()?)
            }
            None => (unsigned, 0),
        };
        let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
        let valid_whole = whole == "0"
            || (whole.starts_with(|first: char| matches!(first, '1'..='9'))
                && whole.bytes().all(|byte| byte.is_ascii_digit()));
        let valid_fraction = !mantissa.contains('.')
            || (!fraction.is_empty() && fraction.bytes().all(|byte| byte.is_ascii_digit()));
        if !valid_whole || !valid_fraction {
            return None;
        }
        let digits: Vec<u8> = whole.bytes().chain(fraction.bytes()).collect();
        let exponent = exponent.checked_sub(i64::try_from(fraction.len()).ok()?)?;
        Some(Decimal::normalized(negative, digits, exponent))
    }

    fn normalized(negative: bool, mut digits: Vec<u8>, mut exponent: i64) -> Decimal {
        let leading = digits.iter().take_while(|&&digit| digit == b'0').count();
        digits.drain(..leading);
        while digits.last() == Some(&b'0') {
            digits.pop();
            exponent += 1;
        }
        if digits.is_empty() {
            return Decimal { negative: false, digits, exponent: 0 };
        }
        Decimal { negative, digits, exponent }
    }

    /// The decimal of a `serde_json` number: the integer, or the shortest decimal that reads back
    /// as the same `f64`, which serde_json writes to PostgreSQL.
    fn of(number: &Number) -> Decimal {
        Decimal::parse(&number.to_string()).expect("serde_json writes a JSON number")
    }

    fn is_zero(&self) -> bool {
        self.digits.is_empty()
    }

    fn magnitude(&self, other: &Decimal) -> Ordering {
        // The position of the leading digit decides first; the digits decide when it is equal.
        let position =
            |decimal: &Decimal| decimal.digits.len() as i128 + i128::from(decimal.exponent);
        position(self).cmp(&position(other)).then_with(|| self.digits.cmp(&other.digits))
    }

    /// True when `self` is an integer multiple of a positive `unit`.
    fn is_multiple_of(&self, unit: &Decimal) -> bool {
        if unit.is_zero() || unit.negative {
            return false;
        }
        if self.is_zero() {
            return true;
        }
        // digits have no trailing zero, so a smaller exponent leaves a fraction.
        let Ok(shift) = u64::try_from(self.exponent - unit.exponent) else { return false };
        let zeros = std::iter::repeat_n(b'0', usize::try_from(shift).unwrap_or(usize::MAX));
        let mut digits = self.digits.iter().copied().chain(zeros);
        if unit.digits.len() <= 36 {
            let divisor =
                unit.digits.iter().fold(0u128, |sum, digit| sum * 10 + u128::from(digit - b'0'));
            let mut remainder = 0u128;
            for digit in digits.by_ref().take(self.digits.len()) {
                remainder = (remainder * 10 + u128::from(digit - b'0')) % divisor;
            }
            for _ in 0..shift {
                if remainder == 0 {
                    return true;
                }
                remainder = remainder * 10 % divisor;
            }
            return remainder == 0;
        }
        let mut remainder: Vec<u8> = Vec::new();
        for (index, digit) in digits.enumerate() {
            if index >= self.digits.len() && remainder.is_empty() {
                return true;
            }
            remainder_step(&mut remainder, digit, &unit.digits);
        }
        remainder.is_empty()
    }
}

/// `remainder = (remainder * 10 + digit) mod divisor` on ASCII digit strings without leading zeros.
fn remainder_step(remainder: &mut Vec<u8>, digit: u8, divisor: &[u8]) {
    if !remainder.is_empty() || digit != b'0' {
        remainder.push(digit);
    }
    while remainder.len() > divisor.len()
        || (remainder.len() == divisor.len() && remainder.as_slice() >= divisor)
    {
        let offset = remainder.len() - divisor.len();
        let mut borrow = 0u8;
        for index in (0..remainder.len()).rev() {
            let subtrahend =
                if index >= offset { divisor[index - offset] - b'0' } else { 0 } + borrow;
            let digit = remainder[index] - b'0';
            if digit >= subtrahend {
                remainder[index] = b'0' + digit - subtrahend;
                borrow = 0;
            } else {
                remainder[index] = b'0' + digit + 10 - subtrahend;
                borrow = 1;
            }
        }
        let leading = remainder.iter().take_while(|&&digit| digit == b'0').count();
        remainder.drain(..leading);
    }
}

impl Ord for Decimal {
    fn cmp(&self, other: &Decimal) -> Ordering {
        match (self.is_zero(), other.is_zero()) {
            (true, true) => return Ordering::Equal,
            (true, false) => {
                return if other.negative { Ordering::Greater } else { Ordering::Less }
            }
            (false, true) => return if self.negative { Ordering::Less } else { Ordering::Greater },
            (false, false) => {}
        }
        match (self.negative, other.negative) {
            (false, true) => Ordering::Greater,
            (true, false) => Ordering::Less,
            (false, false) => self.magnitude(other),
            (true, true) => other.magnitude(self),
        }
    }
}

impl PartialOrd for Decimal {
    fn partial_cmp(&self, other: &Decimal) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// A JSON value under contract equality: 1 equals 1.0, and two numbers are equal when their
/// decimals are equal.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) enum Canonical {
    Null,
    Bool(bool),
    Number(Decimal),
    String(String),
    Array(Vec<Canonical>),
    Object(BTreeMap<String, Canonical>),
}

impl From<&Value> for Canonical {
    fn from(value: &Value) -> Canonical {
        match value {
            Value::Null => Canonical::Null,
            Value::Bool(value) => Canonical::Bool(*value),
            Value::Number(number) => Canonical::Number(Decimal::of(number)),
            Value::String(value) => Canonical::String(value.clone()),
            Value::Array(items) => Canonical::Array(items.iter().map(Canonical::from).collect()),
            Value::Object(members) => Canonical::Object(
                members.iter().map(|(key, value)| (key.clone(), Canonical::from(value))).collect(),
            ),
        }
    }
}

impl From<&Exact> for Canonical {
    fn from(value: &Exact) -> Canonical {
        match value {
            Exact::Null => Canonical::Null,
            Exact::Bool(value) => Canonical::Bool(*value),
            Exact::Number(token) => {
                Canonical::Number(Decimal::parse(token).expect("the parser checked the token"))
            }
            Exact::String(value) => Canonical::String(value.clone()),
            Exact::Array(items) => Canonical::Array(items.iter().map(Canonical::from).collect()),
            Exact::Object(members) => Canonical::Object(
                members.iter().map(|(key, value)| (key.clone(), Canonical::from(value))).collect(),
            ),
        }
    }
}

/// Replaces the keywords that compare numbers with keywords that compare exact decimals.
pub(super) fn with_exact_keywords<'a>(
    options: ValidationOptions<'a>,
    exact: &ExactValues,
) -> ValidationOptions<'a> {
    let bounds: [(&'static str, Holds); 4] = [
        ("minimum", Ordering::is_ge),
        ("maximum", Ordering::is_le),
        ("exclusiveMinimum", Ordering::is_gt),
        ("exclusiveMaximum", Ordering::is_lt),
    ];
    let mut options = options;
    for (keyword, holds) in bounds {
        let exact = Arc::clone(exact);
        options = options.with_keyword(
            keyword,
            move |parent: &Map<String, Value>, value: &Value, _: Location| {
                let Canonical::Number(limit) = exact_value(&exact, parent, keyword, value) else {
                    return Err(ValidationError::custom(format!("{keyword} must be a number")));
                };
                Ok(Box::new(Bound { keyword, limit, holds }) as Box<dyn for<'i> Keyword<'i>>)
            },
        );
    }
    let multiple = Arc::clone(exact);
    options = options.with_keyword(
        "multipleOf",
        move |parent: &Map<String, Value>, value: &Value, _: Location| {
            let Canonical::Number(unit) = exact_value(&multiple, parent, "multipleOf", value)
            else {
                return Err(ValidationError::custom("multipleOf must be a number"));
            };
            Ok(Box::new(MultipleOf(unit)) as Box<dyn for<'i> Keyword<'i>>)
        },
    );
    let constant = Arc::clone(exact);
    options = options.with_keyword(
        "const",
        move |parent: &Map<String, Value>, value: &Value, _: Location| {
            let expected = exact_value(&constant, parent, "const", value);
            Ok(Box::new(Const(expected)) as Box<dyn for<'i> Keyword<'i>>)
        },
    );
    let candidates = Arc::clone(exact);
    options = options.with_keyword(
        "enum",
        move |parent: &Map<String, Value>, value: &Value, _: Location| {
            let Canonical::Array(values) = exact_value(&candidates, parent, "enum", value) else {
                return Err(ValidationError::custom("enum must be an array"));
            };
            Ok(Box::new(Enum(values.into_iter().collect())) as Box<dyn for<'i> Keyword<'i>>)
        },
    );
    options.with_keyword(
        "uniqueItems",
        |_parent: &Map<String, Value>, value: &Value, _: Location| {
            Ok(Box::new(UniqueItems(value.as_bool() == Some(true))) as Box<dyn for<'i> Keyword<'i>>)
        },
    )
}

fn exact_value(
    exact: &ExactValues,
    parent: &Map<String, Value>,
    keyword: &str,
    value: &Value,
) -> Canonical {
    parent
        .get(EXACT_KEY)
        .and_then(Value::as_u64)
        .and_then(|index| exact.get(usize::try_from(index).ok()?))
        .and_then(|values| values.get(keyword))
        .cloned()
        .unwrap_or_else(|| Canonical::from(value))
}

fn refused<'i>(keyword: &str, instance: &Value) -> ValidationError<'i> {
    ValidationError::custom(format!("{instance} does not match {keyword}"))
}

/// Whether the ordering of an instance against a bound satisfies the bound.
type Holds = fn(Ordering) -> bool;

struct Bound {
    keyword: &'static str,
    limit: Decimal,
    holds: Holds,
}

impl<'i> Keyword<'i> for Bound {
    fn validate(&self, instance: &'i Value) -> Result<(), ValidationError<'i>> {
        if self.is_valid(instance) {
            Ok(())
        } else {
            Err(refused(self.keyword, instance))
        }
    }

    fn is_valid(&self, instance: &'i Value) -> bool {
        match instance {
            Value::Number(number) => (self.holds)(Decimal::of(number).cmp(&self.limit)),
            _ => true,
        }
    }
}

struct MultipleOf(Decimal);

impl<'i> Keyword<'i> for MultipleOf {
    fn validate(&self, instance: &'i Value) -> Result<(), ValidationError<'i>> {
        if self.is_valid(instance) {
            Ok(())
        } else {
            Err(refused("multipleOf", instance))
        }
    }

    fn is_valid(&self, instance: &'i Value) -> bool {
        match instance {
            Value::Number(number) => Decimal::of(number).is_multiple_of(&self.0),
            _ => true,
        }
    }
}

struct Const(Canonical);

impl<'i> Keyword<'i> for Const {
    fn validate(&self, instance: &'i Value) -> Result<(), ValidationError<'i>> {
        if self.is_valid(instance) {
            Ok(())
        } else {
            Err(refused("const", instance))
        }
    }

    fn is_valid(&self, instance: &'i Value) -> bool {
        Canonical::from(instance) == self.0
    }
}

struct Enum(HashSet<Canonical>);

impl<'i> Keyword<'i> for Enum {
    fn validate(&self, instance: &'i Value) -> Result<(), ValidationError<'i>> {
        if self.is_valid(instance) {
            Ok(())
        } else {
            Err(refused("enum", instance))
        }
    }

    fn is_valid(&self, instance: &'i Value) -> bool {
        self.0.contains(&Canonical::from(instance))
    }
}

struct UniqueItems(bool);

impl<'i> Keyword<'i> for UniqueItems {
    fn validate(&self, instance: &'i Value) -> Result<(), ValidationError<'i>> {
        if self.is_valid(instance) {
            Ok(())
        } else {
            Err(refused("uniqueItems", instance))
        }
    }

    fn is_valid(&self, instance: &'i Value) -> bool {
        let Value::Array(items) = instance else { return true };
        let mut seen = HashSet::with_capacity(items.len());
        !self.0 || items.iter().all(|item| seen.insert(Canonical::from(item)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decimal(token: &str) -> Decimal {
        Decimal::parse(token).expect("a JSON number")
    }

    #[test]
    fn reads_each_number_form_as_one_decimal() {
        assert_eq!(decimal("1.0"), decimal("1"));
        assert_eq!(decimal("1E2"), decimal("100"));
        assert_eq!(decimal("-0.0"), decimal("0"));
        assert_eq!(decimal("0.10"), decimal("1e-1"));
        for invalid in ["01", "1.", ".5", "+1", "1e", "--1", "1e+"] {
            assert!(Decimal::parse(invalid).is_none(), "{invalid}");
        }
    }

    #[test]
    fn orders_decimals_by_value() {
        let ordered = [
            "-2",
            "-0.30000000000000000001",
            "-0.3",
            "0",
            "0.1",
            "0.10000000000000000001",
            "9007199254740995",
            "18446744073709551617",
        ];
        for pair in ordered.windows(2) {
            assert!(decimal(pair[0]) < decimal(pair[1]), "{} < {}", pair[0], pair[1]);
        }
    }

    #[test]
    fn divides_decimals_exactly() {
        assert!(decimal("1.15").is_multiple_of(&decimal("0.01")));
        assert!(!decimal("1").is_multiple_of(&decimal("0.01000000000000000001")));
        assert!(
            decimal("0.02000000000000000002").is_multiple_of(&decimal("0.01000000000000000001"))
        );
        assert!(!decimal("1e300").is_multiple_of(&decimal("7e-5")));
        let wide = "1234567890123456789012345678901234567891";
        let product = format!("{wide}000");
        assert!(decimal(&product).is_multiple_of(&decimal(wide)));
        assert!(!decimal(&format!("{wide}001")).is_multiple_of(&decimal(wide)));
        assert!(decimal("2e50").is_multiple_of(&decimal(&format!("2{}", "0".repeat(40)))));
    }

    #[test]
    fn keeps_each_number_token_of_stored_text() {
        let Ok(value) = parse(r#"{"a": [0.30000000000000000001, -1E2, "x\"yé"], "b": null}"#)
        else {
            panic!("the text is valid JSON");
        };
        let Some(Exact::Array(items)) = value.member("a") else { panic!("a is an array") };
        assert!(matches!(&items[0], Exact::Number(token) if token == "0.30000000000000000001"));
        assert!(matches!(&items[2], Exact::String(text) if text == "x\"y\u{e9}"));
        assert!(!value.is_held());
        for invalid in ["{", "[1,]", "{\"a\" 1}", "01", "nul", "1 2", "\"a"] {
            assert!(parse(invalid).is_err(), "{invalid}");
        }
        assert!(parse(&format!("{}{}", "[".repeat(129), "]".repeat(129))).is_err());
    }
}
