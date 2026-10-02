package main

import (
	"context"
	"database/sql"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/jmoiron/sqlx"
	workhorse "github.com/stablemates/workhorse/go"
	"github.com/stablemates/workhorse/go/internal/transactionproof"
)

func TestGoSQLXTransactionRecipe(t *testing.T) {
	ctx := context.Background()
	databaseURL := transactionproof.Database(t)
	trace := &transactionproof.Trace{}
	config, err := pgx.ParseConfig(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	config.Tracer = trace
	database := sqlx.NewDb(stdlib.OpenDB(*config), "pgx")
	t.Cleanup(func() { _ = database.Close() })
	observer, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(observer.Close)
	transactionproof.Run(t, transactionproof.Fixture{
		DatabaseURL: databaseURL, Observer: observer, Trace: trace,
		CLIOrderID: "22222222-2222-4222-8222-222222222222",
		Create: func(ctx context.Context, id, taskType string) (string, error) {
			return createOrder(ctx, database, id, taskType)
		},
		Begin: func(ctx context.Context) (transactionproof.Transaction, error) {
			tx, err := database.BeginTxx(ctx, nil)
			if err != nil {
				return transactionproof.Transaction{}, err
			}
			return transactionproof.Transaction{
				Executor: workhorse.NewSQLExecutor(tx.Tx),
				Write: func(ctx context.Context, id, taskType string) (string, error) {
					return writeOrder(ctx, tx, id, taskType)
				},
				Read: func(ctx context.Context, id string) (transactionproof.Order, error) {
					var order struct {
						ID      string         `db:"id"`
						Details []byte         `db:"details"`
						Note    sql.NullString `db:"note"`
						PID     int32          `db:"backend_pid"`
						XID     string         `db:"transaction_id"`
					}
					err := tx.GetContext(ctx, &order, "SELECT * FROM recipe_order WHERE id = $1::uuid", id)
					var note *string
					if order.Note.Valid {
						note = &order.Note.String
					}
					return transactionproof.Order{ID: order.ID, Details: order.Details, Note: note,
						Identity: transactionproof.Identity{PID: order.PID, XID: order.XID}}, err
				},
				Identity: func(ctx context.Context) (transactionproof.Identity, error) {
					var identity transactionproof.Identity
					err := tx.QueryRowxContext(ctx, "SELECT pg_backend_pid(), pg_current_xact_id()::text").Scan(&identity.PID, &identity.XID)
					return identity, err
				},
				Commit: tx.Commit, Rollback: tx.Rollback,
			}, nil
		},
	})
}
