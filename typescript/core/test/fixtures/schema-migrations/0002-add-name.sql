ALTER TABLE workhorse.example ADD COLUMN name text;

UPDATE workhorse.schema_version SET version = 2 WHERE version = 1;
