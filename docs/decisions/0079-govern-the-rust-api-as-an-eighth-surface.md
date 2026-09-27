# ADR 0079: Govern the Rust API as an eighth surface

- **Status:** Accepted
- **Date:** 2026-09-27
- **Amends:** [ADR 0054](0054-define-what-1-0-0-promises.md),
  [ADR 0056](0056-set-the-1-0-0-exit-criteria.md),
  [ADR 0059](0059-assemble-the-1-0-0-specification.md)
- **Related:** [ADR 0074](0074-shape-the-rust-sdk-as-one-python-shaped-crate.md),
  SM-894,
  SM-34,
  SM-41

## Context

On 2026-09-23 the maintainer put the Rust crate on the 1.0.0 train. Until then SM-34 held the Rust
SDK out of scope for 1.0.

ADR 0054 governs seven surfaces and names the TypeScript, Python, and Go APIs among them. ADR 0059
assembles the specification from that list, and ADR 0056 holds the tag until each surface has a
mechanical check. None of the three mentions Rust. A crate that ships at 1.0.0 without a governed
API would carry a version number that promises nothing.

ADR 0074 shaped the Rust SDK as one crate, `workhorse`, with two optional features and no default
ones. `dashboard` adds the embedded dashboard backend as a public module. `opentelemetry` adds no
public item. It sends the worker's metrics to the global meter provider and continues each task's
stored trace in the handler span. The crate is published on crates.io and releases from the same
commit as the npm packages, which it follows in `release.yml`.

A Rust feature is part of what a caller writes. A caller names it in `Cargo.toml`, and a feature can
move a public item in or out of the build. So the question is not only which items are public, but
which items are public under which features.

## Decision

### The Rust API is the eighth governed surface

**8. The Rust API.** A breaking change is one that makes caller code that compiled against the
previous release stop compiling or behave differently. The surface is every public item reachable
from the root of the `workhorse` crate under any published feature, with its signature and the
traits it implements, auto traits and derived traits included. It is the same rule ADR 0054 applies
to the TypeScript, Python, and Go APIs.

Losing an auto trait counts. A type that stops being `Send` breaks every caller that moved it across
a thread, although no signature changed. Adding a variant to a `#[non_exhaustive]` enum does not
count, because the attribute already forbids the caller an exhaustive match. `workhorse::Error` is
declared that way for this reason.

Re-exported crates such as `deadpool_postgres` are governed by name only. Their own items follow
their own publisher's SemVer, so a major bump of one is a Workhorse break and needs a Workhorse
major.

### A feature's name and its items are governed

A feature name is public, because a caller's `Cargo.toml` spells it. Removing or renaming a feature
is breaking. So is moving an existing item behind a feature, because a caller that did not enable
it stops compiling. Adding a feature is not breaking, and neither is adding an item behind one.

What a feature does at run time is governed by the surface that describes it. The `opentelemetry`
feature emits the instrument, span, and attribute names that surface 7 already governs, so it adds
no public item of its own.

A feature stays additive. Enabling one never removes an item, and enabling two never adds an item
that neither adds alone. The snapshot generator refuses either case rather than describing it.

### `rust-api:check` enforces it against `api/rust.txt`

`pnpm rust-api:generate` builds the crate's rustdoc JSON on the pinned toolchain and renders every
public item as one line. It reads the crate once with no features and once per feature. Every item a
feature adds carries that feature's `cfg` as a prefix, so moving an item behind a feature changes
its line. `pnpm rust-api:check` runs in the CI `rust` job, which feeds `required`, and in
`pnpm check`.

The check fails on any drift, like `typescript-api:check` and `python-api:check`. A gone line is a
removal, a rename, a narrowing, or a move behind a feature, and the failure labels it breaking. An
arrived line is an addition, and the fix is one regeneration. An addition is not breaking, but it
still updates the snapshot, so a later removal of that item cannot pass unseen.

This adds a row to Gate 1 of ADR 0056: the Rust API, checked by `rust-api:check` against a committed
snapshot of every public item per feature.

### The Rust clock starts where the snapshot lands

Gate 2 needs six weeks and two published 0.x minors after the last non-additive change to a governed
surface. For the other surfaces the clock starts where the last `0.x-only` Issue lands. The Rust API
had no snapshot until SM-894, so before that commit nothing records whether a Rust change was
additive.

The Rust clock therefore starts at the later of two commits: the merge of SM-894, which first lands
`api/rust.txt`, and the last merge that removes a line from it. Both counted minors must publish the
crate from a commit at or after that start. Version 0.4.0 predates the snapshot and does not count.
The earliest qualifying pair is 0.5.0 and 0.6.0.

The Rust clock runs beside the others and does not replace them. The tag needs every clock to have
run out.

### The crate rides the train and floats afterwards

The Rust crate joins the one 1.0.0 release train of ADR 0054. It publishes 1.0.0 from the same source
commit as the npm packages, the Python distribution, and the Go module. After 1.0.0 its version line
floats independently, like the other three, and a Rust 2.0.0 does not move them.

## Consequences

- Gate 1 has eight checks, and the Rust API holds its one before 1.0.0.
- A change to the crate's public surface updates `api/rust.txt` in the same commit. Review reads a
  gone line as a break.
- The snapshot reads rustdoc JSON, whose format moves with the toolchain. The reader,
  `rust/tools/api-snapshot`, pins the one release that reads the pinned toolchain's format. A
  toolchain bump re-pins it in the same commit.
- Stable rustdoc writes JSON only with `RUSTC_BOOTSTRAP` set. The generator sets it for that one run
  and builds into `target/api`, so ordinary builds keep their fingerprints.
- Blanket impls are left out of the snapshot. Each follows from a bound the snapshot already lists.

## Alternatives considered

- **Diff against the published crate, as the Go check does.** `apidiff` has a published baseline to
  read. Rust would need `cargo-semver-checks` or a registry download on every check. A committed
  snapshot needs neither, and a reviewer can read it in the diff.
- **Snapshot only the all-features build.** One build is smaller, but it cannot see an item moved
  behind a feature. That is a break for every caller who did not enable the feature.
- **Leave features out of the promise.** A caller cannot build without naming them, so they are
  public whether or not a decision says so.
