CREATE SCHEMA workhorse;

CREATE TABLE workhorse.schema_version (
  version integer PRIMARY KEY
);

INSERT INTO workhorse.schema_version(version) VALUES (3);

CREATE TABLE workhorse.example (
  id bigint PRIMARY KEY,
  name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
