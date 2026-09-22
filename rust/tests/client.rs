use serde_json::json;
use workhorse_client::{
    EnqueueRequest, Idempotency, CLIENT_PROTOCOL_VERSION, MAX_ENQUEUE_BATCH_SIZE,
};

#[test]
fn request_matches_protocol_fixture_shape() {
    let mut request = EnqueueRequest::new(
        "protocol-contract",
        "protocol.serialization",
        json!({"account":"acct-1", "active":true}),
    );
    request.priority = 70;
    request.concurrency_key = Some("acct-1".into());
    request.budget = Some("vendor-api".into());
    request.max_attempts = 3;
    request.idempotency = Some(Idempotency {
        scope: "protocol".into(),
        key: "serialize".into(),
        ttl_ms: 60_000,
    });
    let value = serde_json::to_value(request).unwrap();
    assert_eq!(value["type"], "protocol.serialization");
    assert_eq!(value["maxAttempts"], 3);
    assert_eq!(value["idempotency"]["ttlMs"], 60_000);
    assert!(value["maxAttempts"].is_i64() || value["maxAttempts"].is_u64());
}

#[test]
fn protocol_limits_are_explicit() {
    assert_eq!(CLIENT_PROTOCOL_VERSION, 4);
    assert_eq!(MAX_ENQUEUE_BATCH_SIZE, 1000);
}
