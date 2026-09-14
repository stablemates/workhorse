# SQL sources

`schema/current.sql` is the tracked source for a clean installation. While the unreleased version
1 baseline is being recut, `releases/0001.sql` mirrors that source and changes in place. An installer
applies the baseline once; it never applies `0001.sql` after `current.sql`.

After the baseline is released, schema changes use ordered migration steps and released artifacts
become immutable. See `docs/schema-lifecycle.md` for the additive migration contract.

Package builds run `pnpm schema:generate` to write the ignored `schema.sql` artifact.
The TypeScript package copies that artifact and the migrations into `dist/sql`.
Do not edit or commit the generated file.
