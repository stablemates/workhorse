package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"

	"github.com/google/uuid"
	_ "github.com/jackc/pgx/v5/stdlib"
	workhorse "github.com/stablemates/workhorse/go"
	"github.com/uptrace/bun"
	"github.com/uptrace/bun/dialect/pgdialect"
)

type order struct {
	bun.BaseModel `bun:"table:bun_order"`
	ID            string          `bun:"id,pk,type:uuid"`
	Customer      string          `bun:"customer,notnull"`
	Receipt       json.RawMessage `bun:"receipt,type:jsonb,notnull"`
}

func acceptOrder(ctx context.Context, tx bun.Tx, accepted *order, options workhorse.EnqueueOptions) (workhorse.EnqueueResult, error) {
	if _, err := tx.NewInsert().Model(accepted).Exec(ctx); err != nil {
		return workhorse.EnqueueResult{}, err
	}
	queue := workhorse.NewQueue(workhorse.NewSQLExecutor(tx.Tx), "orders")
	return queue.EnqueueWithResult(ctx, "order.accepted", map[string]any{
		"orderId": accepted.ID, "customer": accepted.Customer, "receipt": accepted.Receipt,
	}, options)
}

func run(ctx context.Context, databaseURL string) (string, error) {
	if databaseURL == "" {
		return "", fmt.Errorf("WORKHORSE_DATABASE_URL is required")
	}
	database, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return "", err
	}
	db := bun.NewDB(database, pgdialect.New())
	defer db.Close()
	if err := workhorse.AssertSchemaCompatible(ctx, workhorse.NewSQLExecutor(database)); err != nil {
		return "", err
	}
	accepted := &order{ID: uuid.NewString(), Customer: "customer-42", Receipt: json.RawMessage(`{"total":42}`)}
	var result workhorse.EnqueueResult
	err = db.RunInTx(ctx, nil, func(ctx context.Context, tx bun.Tx) error {
		var err error
		result, err = acceptOrder(ctx, tx, accepted, workhorse.EnqueueOptions{Tags: []string{"orders"}})
		return err
	})
	if err != nil {
		return "", err
	}
	return result.TaskID, nil
}

func main() {
	taskID, err := run(context.Background(), os.Getenv("WORKHORSE_DATABASE_URL"))
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println(taskID)
}
