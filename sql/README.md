# SQL sources

`schema/current.sql` is the tracked source for a clean installation. Edit it directly while the
project remains pre-release. Repository tests also read this file, so a schema change touches one
tracked artifact.

Package builds run `pnpm schema:generate`. That command writes the ignored `schema.sql` artifact,
which the TypeScript package copies into `dist/sql/schema.sql` for runtime installation. Do not
edit or commit the generated file.

After the first stable release, add forward migrations under `migrations/` and freeze released
clean-install artifacts under `releases/` as described in `docs/schema-lifecycle.md`.
