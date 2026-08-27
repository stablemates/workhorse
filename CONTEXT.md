# Workhorse

Workhorse is a PostgreSQL-native durable execution protocol. This glossary names the product terms
that public material and implementation work use consistently.

## Language

**Public beta**:
A usable 0.x Workhorse release for evaluation and early production adoption, without compatibility
or schema upgrade guarantees between minor releases.
_Avoid as a stability label_: Alpha, pre-release, validation MVP, validation release

**Release train**:
The staged publication of Python, npm, and Go artifacts from one source commit within one
controlled release window.
_Avoid_: Simultaneous release, coordinated release

**Telemetry provider**:
The single process-wide destination for Workhorse traces, metrics, logs, and queue observations.
If none is registered, Workhorse discards those signals without changing queue behaviour.

**OpenTelemetry adapter**:
The free integration that translates Workhorse telemetry signals into OpenTelemetry signals.
It does not own Workhorse's signal names or meanings.
