use std::collections::BTreeSet;

use workhorse_conformance::{read_fixture, repository_root};

fn fixture(name: &str) -> serde_json::Value {
    read_fixture(repository_root(), name).unwrap_or_else(|error| panic!("{name}: {error}"))
}

fn ids(value: &serde_json::Value) -> BTreeSet<String> {
    value
        .as_array()
        .expect("fixture is an array")
        .iter()
        .map(|entry| entry["id"].as_str().expect("fixture id").to_owned())
        .collect()
}

#[test]
fn manifest_declares_every_interpreted_fixture() {
    let manifest = fixture("manifest.json");
    let interpreter = fixture("interpreter.json");
    let declared = manifest["fixtureCoverage"]["interpreter"]
        .as_array()
        .expect("manifest interpreter coverage")
        .iter()
        .map(|id| id.as_str().expect("declared fixture id").to_owned())
        .collect::<BTreeSet<_>>();
    assert_eq!(declared, ids(&interpreter));
}

#[test]
fn shared_fixture_sets_are_well_formed() {
    for name in ["compatibility.json", "contracts.json", "cron-occurrences.json", "failures.json", "requests.json", "runtime.json", "scenarios.json", "schedules.json"] {
        let value = fixture(name);
        assert!(!value.is_null(), "{name} must decode");
        if let Some(entries) = value.as_array() {
            let entry_ids = entries.iter().filter_map(|entry| entry["id"].as_str()).collect::<Vec<_>>();
            assert_eq!(entry_ids.len(), entries.len(), "{name} entries need ids");
            assert_eq!(entry_ids.iter().collect::<BTreeSet<_>>().len(), entries.len(), "{name} ids must be unique");
        }
    }
}

#[test]
fn runtime_runner_is_explicitly_waiting_for_sdk_seams() {
    // SM-16A/B/C own the concrete adapter. Keeping this assertion in the harness makes the
    // dependency visible without making an unimplemented SDK look green.
    assert!(cfg!(feature = "sdk-adapter") == false, "SDK adapter wiring belongs to SM-16A/B/C");
}
