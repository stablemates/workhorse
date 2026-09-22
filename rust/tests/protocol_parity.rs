#[test]
fn client_sql_calls_are_declared_by_protocol_manifest() {
    let manifest = include_str!("../../protocol/v1/manifest.json");
    for function in [
        "enqueue_many_v1",
        "cancel_v1",
        "sync_schedule_definitions_v2",
        "sync_concurrency_policies_v1",
        "sync_contract_definitions_v1",
    ] {
        assert!(
            manifest.contains(function),
            "missing protocol declaration: {function}"
        );
    }
}

#[test]
fn request_fixture_preserves_json_integer_semantics() {
    let fixtures = include_str!("../../protocol/v1/requests.json");
    let value: serde_json::Value = serde_json::from_str(fixtures).unwrap();
    let priority = &value[0]["postgres"]["priority"];
    assert!(priority.as_i64().is_some() || priority.as_u64().is_some());
    assert!(priority.as_f64().is_some());
}
