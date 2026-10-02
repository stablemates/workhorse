CREATE TABLE recipe_order (
    id uuid PRIMARY KEY,
    details jsonb NOT NULL,
    note text,
    backend_pid integer NOT NULL DEFAULT pg_backend_pid(),
    transaction_id text NOT NULL DEFAULT pg_current_xact_id()::text
);
