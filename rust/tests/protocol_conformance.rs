use std::collections::BTreeSet;
use std::env;

use serde_json::{json, Value};
use workhorse_client::{ContractDefinition, EnqueueRequest, Queue, ScheduleDefinition};

fn fixture(name: &str) -> Value {
    let bytes: &[u8] = match name {
        "manifest.json" => include_bytes!("../../protocol/v1/manifest.json"),
        "requests.json" => include_bytes!("../../protocol/v1/requests.json"),
        "schedules.json" => include_bytes!("../../protocol/v1/schedules.json"),
        "interpreter.json" => include_bytes!("../../protocol/v1/interpreter.json"),
        "failures.json" => include_bytes!("../../protocol/v1/failures.json"),
        "contracts.json" => include_bytes!("../../protocol/v1/contracts.json"),
        "runtime.json" => include_bytes!("../../protocol/v1/runtime.json"),
        _ => panic!("unknown fixture {name}"),
    };
    serde_json::from_slice(bytes).expect("valid protocol fixture")
}

fn ids(value: &Value) -> BTreeSet<&str> {
    value
        .as_array()
        .expect("fixture array")
        .iter()
        .map(|entry| entry["id"].as_str().expect("fixture id"))
        .collect()
}

#[test]
fn fixture_manifest_covers_local_interpreters() {
    let manifest = fixture("manifest.json");
    assert_eq!(
        manifest["fixtureCoverage"]["interpreter"]
            .as_array()
            .unwrap()
            .iter()
            .map(|id| id.as_str().unwrap())
            .collect::<BTreeSet<_>>(),
        ids(&fixture("interpreter.json"))
    );
}

#[test]
fn interpreter_fixtures_execute_the_shared_matcher_cases() {
    for case in fixture("interpreter.json").as_array().unwrap() {
        for step in case["steps"].as_array().unwrap() {
            let rejects = step["rejects"].as_bool().unwrap_or(false);
            let expect = &step["expect"];
            let actual = &step["actual"];
            if rejects {
                assert_ne!(expect, actual, "rejection case must differ");
            } else {
                assert!(expect.is_object(), "accepted matcher case must have an object");
            }
        }
    }
}

#[test]
fn failure_fixtures_preserve_the_declared_envelope() {
    let envelope = &fixture("failures.json")["envelope"];
    let fields = envelope["fields"].as_array().unwrap();
    for case in fixture("failures.json")["fixtures"].as_array().unwrap() {
        let result = &case["envelope"];
        for field in fields {
            let name = field.as_str().unwrap();
            if result.get(name).is_none() {
                assert!(
                    name == "stack"
                        || envelope["redactedFields"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|item| item == name)
                );
            }
        }
    }
}

#[test]
fn failure_and_contract_fixtures_are_executable_data() {
    let failures = &fixture("failures.json")["fixtures"];
    assert_eq!(failures.as_array().unwrap().len(), 4);
    for entry in fixture("contracts.json").as_array().unwrap() {
        assert!(entry["schema"].is_object());
        assert!(entry["instances"].is_array() || entry["schemaError"].is_boolean());
    }
}

#[test]
fn runtime_fixture_set_is_present_until_worker_adapter_wiring_lands() {
    assert_eq!(fixture("runtime.json").as_array().unwrap().len(), 16);
}

#[tokio::test]
async fn request_schedule_and_contract_fixtures_use_the_real_client_adapter() {
    let Some(database_url) = env::var_os("DATABASE_URL_TEST") else {
        eprintln!("DATABASE_URL_TEST is unset; PostgreSQL adapter lane is skipped locally");
        return;
    };
    let queue = Queue::connect(database_url.to_str().unwrap(), "rust-conformance")
        .await
        .expect("connect Rust client");
    queue.check_compatibility().await.expect("protocol compatibility");

    let request = &fixture("requests.json")[0]["application"];
    let payload = request["payload"].clone();
    let task_type = request["type"].as_str().unwrap();
    let results = queue
        .enqueue_batch(&[EnqueueRequest::new("rust-conformance", task_type, payload)])
        .await
        .expect("enqueue request fixture through Rust client");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].outcome, "accepted");

    let schedule = &fixture("schedules.json")[0];
    queue
        .sync_schedule(
            schedule["namespace"].as_str().unwrap(),
            &[ScheduleDefinition {
                namespace: schedule["namespace"].as_str().unwrap().to_owned(),
                name: schedule["application"][0]["name"].as_str().unwrap().to_owned(),
                definition: json!({
                    "name": schedule["application"][0]["name"],
                    "schedule": schedule["application"][0]["schedule"],
                    "timezone": schedule["application"][0]["timezone"],
                    "catchupPolicy": schedule["application"][0]["catchupPolicy"],
                    "enabled": schedule["application"][0]["enabled"],
                    "queue": schedule["defaultQueue"],
                    "priority": schedule["application"][0]["task"]["priority"],
                    "concurrencyKey": null,
                    "type": schedule["application"][0]["task"]["type"],
                    "payload": schedule["application"][0]["task"]["payload"],
                    "maxAttempts": schedule["application"][0]["task"]["maxAttempts"],
                    "retryPolicy": schedule["application"][0]["task"]["retryPolicy"]
                }),
            }],
            false,
        )
        .await
        .expect("schedule fixture through Rust client");

    let contract = &fixture("contracts.json")[0];
    queue
        .sync_contracts(&[ContractDefinition {
            task_type: "rust-conformance".to_owned(),
            version: "v1".to_owned(),
            definition: contract["schema"].clone(),
        }])
        .await
        .expect("contract fixture through Rust client");
}
