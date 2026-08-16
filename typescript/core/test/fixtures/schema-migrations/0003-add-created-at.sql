ALTER TABLE workhorse.example ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

UPDATE workhorse.schema_version SET version = 3 WHERE version = 2;
