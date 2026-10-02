-- name: CreateOrder :one
INSERT INTO recipe_order (id, details, note)
VALUES ($1, $2, $3)
RETURNING *;

-- name: GetOrder :one
SELECT * FROM recipe_order WHERE id = $1;

-- name: TransactionIdentity :one
SELECT pg_backend_pid()::integer AS backend_pid,
       pg_current_xact_id()::text AS transaction_id;
