//! Minimal executable example for downstream Rust contributors.
//! The SDK adapter is supplied by SM-16A/B/C; this example only loads shared fixtures.

fn main() {
    let root = workhorse_conformance::repository_root();
    let manifest = workhorse_conformance::read_fixture(root, "manifest.json").expect("manifest");
    let protocol = manifest["protocolVersion"].as_u64().expect("protocol version");
    println!("Workhorse protocol/v1 fixture harness (protocol {protocol})");
}
