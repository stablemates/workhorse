#[test]
fn lifecycle_adapter_has_canonical_sql_functions() {
    let schema = include_str!("../../../sql/schema/current.sql");
    for function in [
        "claim_many_v1",
        "heartbeat_v1",
        "complete_v1",
        "fail_v1",
        "register_worker_v1",
        "run_maintenance_v1",
        "deregister_worker_v1",
    ] {
        assert!(schema.contains(&format!("workhorse.{function}")), "missing {function}");
    }
    let adapter = include_str!("../src/lib.rs");
    for function in [
        "claim_many_v1",
        "heartbeat_v1",
        "complete_v1",
        "fail_v1",
        "register_worker_v1",
        "run_maintenance_v1",
    ] {
        assert!(adapter.contains(function), "adapter does not call {function}");
    }
}
