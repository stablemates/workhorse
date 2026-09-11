-- workhorse-migration: {"kind":"additive"}
ALTER TABLE workhorse.example ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
