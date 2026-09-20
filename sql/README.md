# SQL sources

`schema/current.sql` is the tracked source for a clean installation. An installer applies one
clean-install artifact once; it never applies a `releases/` artifact after `current.sql`.

`releases/<NNNN>.sql` freezes the clean installation a published release shipped, copied from
`schema/current.sql` at that release's tag. `0001.sql` is the 0.1.5 baseline, `0006.sql` is 0.2.0,
and `0009.sql` is 0.2.1. Released artifacts and released migrations are immutable: a schema change
adds an ordered migration step instead. See `docs/schema-lifecycle.md` for the additive migration
contract.

Package builds run `pnpm schema:generate` to write the ignored `schema.sql` artifact.
The TypeScript package copies that artifact and the migrations into `dist/sql`.
Do not edit or commit the generated file.
