//! Integration tests that read worker state that the `workhorse` crate keeps private.
//!
//! Cargo compiles each file in `rust/tests` as a separate crate that sees only the published API.
//! The crate compiles this module into its own unit tests instead (`rust/src/lib.rs`), so these
//! tests can call the crate-private observations of a worker. No published item or feature gives a
//! caller that access.
//!
//! The module reuses the scratch databases of `tests/support` (through `worker::scratch`) and the
//! executors of `tests/conformance`. The protocol conformance runner records each fixture that runs
//! here as `Outcome::InCrate`.

use crate::worker::scratch as support;

// The crate compiles the shared executors here only for the helpers that `runtime` uses. Outside
// the crate a `#[non_exhaustive]` type needs a fallback arm and a value built from its default.
// Inside the crate the arm is unreachable, and clippy prefers a struct literal.
#[allow(dead_code, unreachable_patterns, clippy::field_reassign_with_default)]
#[path = "../conformance/mod.rs"]
mod conformance;

mod contracts;
mod runtime;
mod worker_pause;
