// Runs sqlc-generated application queries and a Workhorse enqueue in one caller-owned pgx
// transaction, so the order row and its task commit together.
//
// Documentation: https://workhorse.run/docs/sqlc
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
	"github.com/stablemates/workhorse/go/examples/sqlc/generated"
)

func writeOrder(ctx context.Context, tx pgx.Tx, queries *generated.Queries, id string, taskType string) (string, error) {
	var orderID pgtype.UUID
	if err := orderID.Scan(id); err != nil {
		return "", err
	}
	order, err := queries.WithTx(tx).CreateOrder(ctx, generated.CreateOrderParams{
		ID: orderID, Details: json.RawMessage(`{"source":"sqlc","items":["first","second"]}`),
	})
	if err != nil {
		return "", err
	}
	queue := workhorse.NewQueue(workhorse.NewPGXExecutor(tx), "recipes")
	return queue.Enqueue(ctx, taskType, map[string]any{"orderId": id, "details": json.RawMessage(order.Details)})
}

func createOrder(ctx context.Context, pool *pgxpool.Pool, id string, taskType string) (string, error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	taskID, err := writeOrder(ctx, tx, generated.New(pool), id, taskType)
	if err != nil {
		return "", err
	}
	return taskID, tx.Commit(ctx)
}

func main() {
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, os.Getenv("WORKHORSE_DATABASE_URL"))
	if err != nil {
		panic(err)
	}
	defer pool.Close()
	taskID, err := createOrder(ctx, pool, "11111111-1111-4111-8111-111111111111", "order.accepted")
	if err != nil {
		panic(err)
	}
	fmt.Println(taskID)
}
