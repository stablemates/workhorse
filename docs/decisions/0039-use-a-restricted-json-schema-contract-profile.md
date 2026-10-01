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

## Amendment: patterns cannot use backreferences (2026-10-01)

**Superseded** by the amendment below, which removes `pattern` and `patternProperties` from the
profile.

A `pattern` value or a `patternProperties` key that contains `\1` through `\9` or `\k<name>`
outside a character class is a schema error. Each SDK rejects it in the profile check, before a
language library compiles the schema, with the profile's normal error.

Backreferences have no shared behavior. RE2, which the Go SDK uses, has no backreferences. The
other engines disagree on a reference to a group that has not matched, such as `^(a|(b))\2$`, and on
a forward reference such as `^\1(a)$`. ECMA-262 matches the empty string in both cases. Emulating
that in every runtime would add a translation layer for a feature contracts rarely need.

`protocol/v1/contracts.json` pins the rejection for numeric, named, skipped-group, and forward
references, and for a `patternProperties` key. A contract that used a backreference stops
compiling; its owner publishes a new version without one.

## Amendment: the profile excludes `pattern` and `patternProperties` (2026-10-01)

`pattern` and `patternProperties` are outside the profile at any depth. Each SDK rejects either
keyword in the profile check, before a language library compiles the schema, with the profile's
normal error, `<path> is outside the Workhorse contract profile`. A property that is merely named
`pattern` stays valid. This amendment supersedes the backreference amendment above.

Regular expressions are the one keyword family where the SDK libraries cannot give one validity
decision. The Go SDK's RE2 engine cannot compile Unicode script escapes, `\u` escapes, control
escapes or lookaheads that the ECMA-262 reference accepts, so a Go worker could not load a contract
a TypeScript producer synced. Go also disagrees on matches, such as `^\s$` against U+00A0. The Rust
library accepts syntax that ECMA-262 refuses, such as `(?i)a`. Python and Ruby would each need an
ECMA-262 translator, and a Python translator still diverged after repeated review.

No shipped contract uses `pattern`. A contract author who needs a string-shape check makes it in
handler code. `format` stays annotation-only. A contract version that used either keyword stops
compiling. Its owner publishes a new version without the keyword and moves `currentVersion`. A task
keeps the version it was enqueued with. A worker checks the task's result against that version, so a
keyword in its result schema fails the attempt with the profile error. The task's retry policy then
applies. A keyword in its payload schema does not affect the task, because the payload was checked
at enqueue.

A reference must point at a schema position the profile check visits. The fragment is empty, names
an `$anchor` in the document, or is a JSON pointer whose tokens step only through schema keywords:
the subschema keywords, an index of an array keyword, or a name in `$defs`, `dependentSchemas` or
`properties`. Each SDK rejects any other reference with `<path>.$ref must point at a subschema of
the contract`. Without this rule, a reference into `default` or `examples` would apply a schema
that holds either keyword, and the profile check would never see it. A pointer token that
percent-decodes to `/` is also rejected. JSON Schema libraries disagree on whether `%2F` separates
tokens, so such a reference could resolve to a schema the profile check never saw. Each `$anchor`
value must also be unique in the document. Libraries disagree on which of two equal anchors a
reference names, so each SDK rejects the second declaration with `<path>.$anchor must declare a
unique anchor`.

`protocol/v1/contracts.json` pins the rejection of each keyword at the root and inside `$defs`,
`items` and `properties`, behind a reference into `default` or `examples`, and behind a reference
with an encoded separator. It also pins the rejection of a duplicate anchor. A keyword can return only through the rule in Consequences.

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
