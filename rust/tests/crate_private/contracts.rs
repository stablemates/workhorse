//! The `protocol/v1` contract fixtures.
//!
//! A fixture can give its schema as the JSON text that PostgreSQL stores. The compiler of that text
//! keeps every number exact, and the crate keeps it private, so this category runs here.

use serde_json::Value;

use crate::contracts::{compile_contract_schema, compile_stored_contract_schema};

use super::conformance::database::repository;

/// The kinds of number a `serde_json::Value` cannot hold. It holds an `i64` or a `u64` exactly, so it
/// holds `exactInteger`. It reads a fraction or a larger integer as an `f64`, and it refuses an
/// integer outside the `f64` range.
const UNHELD_CONTRACT_NUMBERS: &[&str] = &["exactFraction", "exactBigInteger"];

/// A contract fixture compiles its schema the way `Queue::sync_contracts` does, then checks each
/// instance's verdict. A schema in JSON text reads the way a schema that PostgreSQL stores does.
fn run_contract(fixture: &Value) -> Result<(), String> {
    let compiled = match fixture["schemaJson"].as_str() {
        Some(text) => compile_stored_contract_schema(text),
        None => compile_contract_schema(&fixture["schema"]),
    };
    if fixture["schemaError"].as_bool() == Some(true) {
        return match compiled {
            Err(_) => Ok(()),
            Ok(_) => Err("compiled a schema the protocol rejects".to_owned()),
        };
    }
    let schema = compiled.map_err(|error| format!("rejected a valid schema: {error}"))?;
    for (index, instance) in
        fixture["instances"].as_array().ok_or("fixture lists no instances")?.iter().enumerate()
    {
        let expected = instance["valid"].as_bool().ok_or("instance states no verdict")?;
        if instance["needs"].as_str().is_some_and(|needs| UNHELD_CONTRACT_NUMBERS.contains(&needs))
        {
            continue;
        }
        let value = match instance["json"].as_str() {
            Some(text) => serde_json::from_str(text)
                .map_err(|error| format!("instance {index}: unreadable JSON: {error}"))?,
            None => instance["value"].clone(),
        };
        if schema.is_valid(&value) != expected {
            return Err(format!("instance {index}: expected valid = {expected}"));
        }
    }
    Ok(())
}

#[test]
fn every_contract_fixture_passes() {
    let path = repository().join("protocol/v1/contracts.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    let fixtures: Vec<Value> =
        serde_json::from_str(&text).expect("contracts.json is a fixture array");
    assert!(!fixtures.is_empty(), "contracts.json declares no fixture");
    let failures: Vec<String> = fixtures
        .iter()
        .filter_map(|fixture| {
            let id = fixture["id"].as_str().unwrap_or_default();
            run_contract(fixture).err().map(|reason| format!("contracts/{id}: {reason}"))
        })
        .collect();
    assert!(failures.is_empty(), "contract fixtures failed:\n  {}", failures.join("\n  "));
}
