# Rust integration harness

This crate owns shared integration only. It validates the checked-in `protocol/v1` fixtures and
provides `ProtocolClient` and `RuntimeFixtureAdapter` seams for the Rust SDK.

The client implementation belongs to SM-16A, worker lifecycle to SM-16B, and durable handler
context to SM-16C. Until those issues land, the harness runs fixture-shape and generated-evidence
checks only; it does not claim runtime conformance.

Run from the repository root:

```sh
cargo test --manifest-path rust/Cargo.toml
cargo run --manifest-path rust/Cargo.toml --example fixture_runner
```
