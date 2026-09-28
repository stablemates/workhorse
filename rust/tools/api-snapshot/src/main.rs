//! Print the public API a rustdoc JSON file describes, one item per line.
//!
//! `scripts/generate-rust-api.ts` builds the JSON once per feature set and assembles `api/rust.txt`
//! from what this prints. Blanket impls are omitted because each follows from a bound the snapshot
//! already lists. Auto-trait and derived impls stay, because losing `Send` or `Clone` breaks a
//! caller that relied on it.

use std::process::ExitCode;

fn main() -> ExitCode {
    let mut arguments = std::env::args().skip(1);
    let (Some(path), None) = (arguments.next(), arguments.next()) else {
        eprintln!("usage: workhorse-api-snapshot <rustdoc.json>");
        return ExitCode::from(2);
    };
    match public_api::Builder::from_rustdoc_json(&path).omit_blanket_impls(true).build() {
        Ok(api) => {
            for item in api.items() {
                println!("{item}");
            }
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{path}: {error}");
            ExitCode::FAILURE
        }
    }
}
