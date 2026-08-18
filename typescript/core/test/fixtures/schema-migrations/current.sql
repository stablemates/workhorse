CREATE SCHEMA workhorse;

CREATE TABLE workhorse.schema_version (
  version integer PRIMARY KEY,
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE workhorse.schema_migration (
  version integer PRIMARY KEY,
  description text NOT NULL CHECK (description <> ''),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO workhorse.schema_migration(version, description) VALUES
  (1, 'fixture baseline'),
  (2, 'add name'),
  (3, 'add created_at');
INSERT INTO workhorse.schema_version(version) VALUES (3);

CREATE TABLE workhorse.example (
  id bigint PRIMARY KEY,
  name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
