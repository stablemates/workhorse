use serde_json::json;
use workhorse_client::EnqueueRequest;

#[test]
fn request_serializes_protocol_fields() {
    let request = EnqueueRequest::new("default", "email.send", json!({"to":"a@example.test"}));
    let value = serde_json::to_value(request).unwrap();
    assert_eq!(value["queue"], "default");
    assert_eq!(value["type"], "email.send");
    assert_eq!(value["payload"]["to"], "a@example.test");
}
