// Enqueues through the *sql.Tx under a Go sqlx transaction, opened with pgx stdlib, so the
// application write and the task commit together. This is Go sqlx, not Rust SQLx.
//
// Documentation: https://workhorse.run/docs/go-sqlx
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/jmoiron/sqlx"
	workhorse "github.com/stablemates/workhorse/go"
)

func writeOrder(ctx context.Context, tx *sqlx.Tx, id string, taskType string) (string, error) {
	_, err := tx.NamedExecContext(ctx,
		"INSERT INTO recipe_order (id, details, note) VALUES (:id, :details, :note)",
		map[string]any{"id": id, "details": `{"source":"sqlx","items":["first","second"]}`, "note": nil})
	if err != nil {
		return "", err
	}
	queue := workhorse.NewQueue(workhorse.NewSQLExecutor(tx.Tx), "recipes")
	return queue.Enqueue(ctx, taskType, map[string]any{
		"orderId": id, "details": json.RawMessage(`{"source":"sqlx","items":["first","second"]}`),
	})
}

func createOrder(ctx context.Context, database *sqlx.DB, id string, taskType string) (string, error) {
	tx, err := database.BeginTxx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback() }()
	taskID, err := writeOrder(ctx, tx, id, taskType)
	if err != nil {
		return "", err
	}
	return taskID, tx.Commit()
}

func main() {
	database, err := sqlx.Open("pgx", os.Getenv("WORKHORSE_DATABASE_URL"))
	if err != nil {
		panic(err)
	}
	defer func() { _ = database.Close() }()
	taskID, err := createOrder(context.Background(), database, "22222222-2222-4222-8222-222222222222", "order.accepted")
	if err != nil {
		panic(err)
	}
	fmt.Println(taskID)
}
