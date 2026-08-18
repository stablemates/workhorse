-- Migration 0044: record served SQL protocol versions independently of the schema migration
-- history. Released migrations are immutable; never edit this file.
--
-- The runtime wraps this body in one transaction that takes the workhorse:schema-migration
-- advisory lock, validates the starting version, and records the version step. The body contains
-- only the schema change itself.

CREATE TABLE workhorse.protocol_version (
  version integer PRIMARY KEY,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO workhorse.protocol_version(version) VALUES (1);
