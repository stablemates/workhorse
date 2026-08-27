# ADR 0039: Payload and result contracts use a restricted JSON Schema profile

- **Status:** Accepted
- **Date:** 2026-08-22
- **Related:** [ADR 0020](0020-database-authoritative-configuration.md), [ADR 0023](0023-language-sdks-and-http-boundaries.md)

## Context

Payload and result validators were TypeScript closures. Go and Python could preserve contract
metadata, but they could not execute the contract that accepted a job.

Ajv, python-jsonschema, santhosh-tekuri/jsonschema, and jsonschema-rs all support Draft 2020-12.
Their full feature sets still differ in ways that affect portable contracts. Format assertions are
configurable, remote reference retrieval has different defaults and security consequences, and
dynamic or unevaluated applicators have produced compatibility failures across implementations.
Bowtie exposes those differences, so a library's draft support claim is not a sufficient protocol.

## Decision

Workhorse contracts are JSON Schema Draft 2020-12 documents restricted to the keywords listed by
`protocol/v1/contracts.json`. The profile includes the core, applicator, validation, and metadata
keywords needed for ordinary JSON documents. `format` is annotation-only.

References must start with `#` and resolve inside the same compound document. Workhorse rejects
remote references, custom keywords and vocabularies, `$dynamicRef`, `$dynamicAnchor`,
`unevaluatedProperties`, and `unevaluatedItems` before a language library compiles the schema.
That rejection prevents network access and removes the features with material cross-library
differences from the contract surface.

PostgreSQL stores each `(job_type, version)` document in `contract_definition`. Rows are immutable.
`contract_policy` separately records the application seed and any operator override for the version
assigned to new jobs, following ADR 0020.

The TypeScript SDK uses Ajv, Python uses python-jsonschema, and Go uses
santhosh-tekuri/jsonschema. Every implementation runs `protocol/v1/contracts.json`. A future Rust
SDK should use jsonschema-rs with format validation and external retrieval disabled, then run the
same table before claiming parity.

## Consequences

One contract document now produces the same validity decision in every shipped SDK. Applications
must publish a new version to change a schema because mutating an existing document would make
worker caches and rolling deployments disagree.

The restricted profile intentionally omits valid Draft 2020-12 features. A feature can enter the
profile only after the shared fixture demonstrates identical behavior in every supported runtime.

## Research

- [Ajv JSON Schema support](https://ajv.js.org/json-schema.html)
- [python-jsonschema referencing](https://python-jsonschema.readthedocs.io/en/stable/referencing/)
- [santhosh-tekuri/jsonschema](https://github.com/santhosh-tekuri/jsonschema)
- [jsonschema-rs](https://docs.rs/jsonschema/latest/jsonschema/)
- [Bowtie implementation reports](https://bowtie.report/)
