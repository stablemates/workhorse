package main

import (
	"context"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
	"github.com/stablemates/workhorse/go/examples/sqlc/generated"
	"github.com/stablemates/workhorse/go/internal/transactionproof"
)

func TestSQLCTransactionRecipe(t *testing.T) {
	ctx := context.Background()
	databaseURL := transactionproof.Database(t)
	trace := &transactionproof.Trace{}
	config, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.Tracer = trace
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	observer, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(observer.Close)
	queries := generated.New(pool)
	transactionproof.Run(t, transactionproof.Fixture{
		DatabaseURL: databaseURL, Observer: observer, Trace: trace,
		CLIOrderID: "11111111-1111-4111-8111-111111111111",
		Create: func(ctx context.Context, id, taskType string) (string, error) {
			return createOrder(ctx, pool, id, taskType)
		},
		Begin: func(ctx context.Context) (transactionproof.Transaction, error) {
			tx, err := pool.Begin(ctx)
			if err != nil {
				return transactionproof.Transaction{}, err
			}
			bound := queries.WithTx(tx)
			return transactionproof.Transaction{
				Executor: workhorse.NewPGXExecutor(tx),
				Write: func(ctx context.Context, id, taskType string) (string, error) {
					return writeOrder(ctx, tx, queries, id, taskType)
				},
				Read: func(ctx context.Context, id string) (transactionproof.Order, error) {
					var orderID pgtype.UUID
					if err := orderID.Scan(id); err != nil {
						return transactionproof.Order{}, err
					}
					order, err := bound.GetOrder(ctx, orderID)
					if err != nil {
						return transactionproof.Order{}, err
					}
					var note *string
					if order.Note.Valid {
						note = &order.Note.String
					}
					if !order.ID.Valid {
						return transactionproof.Order{}, fmt.Errorf("generated UUID is invalid")
					}
					return transactionproof.Order{ID: order.ID.String(), Details: order.Details, Note: note,
						Identity: transactionproof.Identity{PID: order.BackendPid, XID: order.TransactionID}}, nil
				},
				Identity: func(ctx context.Context) (transactionproof.Identity, error) {
					identity, err := bound.TransactionIdentity(ctx)
					return transactionproof.Identity{PID: identity.BackendPid, XID: identity.TransactionID}, err
				},
				Commit:   func() error { return tx.Commit(context.Background()) },
				Rollback: func() error { return tx.Rollback(context.Background()) },
			}, nil
		},
	})
}
