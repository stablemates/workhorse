# Cron occurrence dialect

`cron_occurrences_v1` is the normative evaluator for every Workhorse SDK. Workers own the cadence
that offers schedule work, while PostgreSQL parses each definition and returns due occurrence
instants.

Expressions have five fields (`minute hour day-of-month month day-of-week`) or six fields with
seconds first. Fields accept `*`, comma lists, inclusive ranges, and `/step`. Month names are
`JAN` through `DEC`; weekday names are `SUN` through `SAT`; weekday `7` aliases Sunday. A lone `?`
is a wildcard in either day field.

The day fields follow ordinary cron OR semantics. If both are restricted, a date matches when
either field matches. `L` in day-of-month selects the last date. `<weekday>L` selects the last
named weekday. `<weekday>#<ordinal>` selects that weekday's ordinal occurrence in the month.

An `H` token selects a stable value. PostgreSQL hashes UTF-8
`${expression}:${fieldIndex}:${tokenIndex}` with SHA-256, reads the first four digest bytes as an
unsigned big-endian integer, and reduces it within the field or declared `H(lower-upper)` range.
`H/step` selects the stable start of a stepped range. Field and token indexes are zero-based.

The supported descriptors are `@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily`,
`@midnight`, and `@hourly`. Workhorse rejects runtime-specific descriptors such as `@every` and
`@weekends`.

Each definition stores an IANA timezone. PostgreSQL advances a nonexistent wall time across a
daylight-saving gap and selects the first instant when a wall time repeats. Occurrences have
one-second precision. If several wall-clock fields normalize to the same instant, PostgreSQL emits
that instant once. A new definition returns the latest occurrence at or before `now`; an
existing definition returns occurrences strictly after its last durable key and at or before
`now`, capped by the supplied catch-up limit. The search horizon is 128 years.

[`cron-occurrences.json`](cron-occurrences.json) is the executable fixture for these rules.
