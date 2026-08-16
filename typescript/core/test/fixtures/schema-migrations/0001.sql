CREATE SCHEMA workhorse;

CREATE TABLE workhorse.schema_version (
  version integer PRIMARY KEY
);

INSERT INTO workhorse.schema_version(version) VALUES (1);

CREATE TABLE workhorse.example (
  id bigint PRIMARY KEY
);
