//! The reconciliation between fixture outcomes and the expected-unsupported list.
//!
//! Every fixture must pass through a Rust adapter or appear on the list with the Issue that owns
//! the gap. A listed fixture that passes also fails the run, so the list cannot outlive its fix.

use std::collections::{BTreeMap, BTreeSet};

use serde::Deserialize;

/// What one fixture did when the runner tried it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Passed,
    /// The Rust adapter ran and disagreed with the fixture.
    Failed(String),
    /// No Rust adapter can express the fixture yet.
    Unsupported(String),
    /// The runner could not reach the database the fixture needs.
    Skipped(String),
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExpectedUnsupported {
    /// `<category>/<fixture id>`, where the category is the fixture file's stem.
    pub fixture: String,
    pub issue: String,
    pub reason: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ledger {
    #[serde(rename = "$comment")]
    pub _comment: String,
    pub fixtures: Vec<ExpectedUnsupported>,
}

/// Name every disagreement between the outcomes and the list. An empty result is a clean run.
///
/// `declared` holds every fixture the protocol files define, so a list entry for a fixture that no
/// longer exists is reported too.
pub fn reconcile(
    declared: &BTreeSet<String>,
    outcomes: &BTreeMap<String, Outcome>,
    ledger: &Ledger,
) -> Vec<String> {
    let mut problems = Vec::new();
    let mut listed = BTreeMap::new();
    for entry in &ledger.fixtures {
        if !is_issue(&entry.issue) {
            problems.push(format!(
                "{} names tracking issue {:?}, not SM-<number>",
                entry.fixture, entry.issue
            ));
        }
        if entry.reason.trim().is_empty() {
            problems.push(format!("{} records no reason", entry.fixture));
        }
        if !declared.contains(&entry.fixture) {
            problems.push(format!(
                "{} is listed but no protocol/v1 fixture declares it",
                entry.fixture
            ));
        }
        if listed.insert(entry.fixture.as_str(), entry).is_some() {
            problems.push(format!("{} is listed twice", entry.fixture));
        }
    }
    for fixture in declared {
        if !outcomes.contains_key(fixture) {
            problems.push(format!("{fixture} was never executed"));
        }
    }
    for (fixture, outcome) in outcomes {
        if !declared.contains(fixture) {
            problems.push(format!("{fixture} was executed but no protocol/v1 fixture declares it"));
        }
        match (outcome, listed.get(fixture.as_str())) {
            (Outcome::Passed, Some(entry)) => problems.push(format!(
                "{fixture} now passes; remove it from the expected-unsupported list ({})",
                entry.issue
            )),
            (Outcome::Failed(reason) | Outcome::Unsupported(reason), None) => {
                problems.push(format!("{fixture} does not pass and is not listed: {reason}"))
            }
            _ => {}
        }
    }
    problems
}

fn is_issue(issue: &str) -> bool {
    issue.strip_prefix("SM-").is_some_and(|number| {
        !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())
    })
}
