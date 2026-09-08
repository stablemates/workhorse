# SQL sources

`schema/current.sql` is the tracked source for a clean installation. Every schema change also
adds an ordered step under `migrations/`. Released artifacts under `releases/` are immutable.
See `docs/schema-lifecycle.md` for the additive migration contract.

Package builds run `pnpm schema:generate` to write the ignored `schema.sql` artifact.
The TypeScript package copies that artifact and the migrations into `dist/sql`.
Do not edit or commit the generated file.
