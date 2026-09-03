package main

import (
	"context"
	"os"

	"github.com/jackc/pgx/v5/pgxpool"
	workhorse "github.com/stablemates/workhorse/go"
)

func main() {
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, os.Getenv("WORKHORSE_DATABASE_URL"))
	if err != nil {
		panic(err)
	}
	defer pool.Close()

	worker, err := workhorse.NewWorker(pool, workhorse.WorkerOptions{Queue: "orders"})
	if err != nil {
		panic(err)
	}
	worker.Handle("order.process", func(
		_ context.Context,
		payload any,
		handler *workhorse.HandlerContext,
	) (any, error) {
		children, err := handler.RunChildrenAll([]workhorse.ChildJobRequest{
			{Name: "invoice", Type: "invoice.create", Payload: payload},
			{Name: "receipt", Type: "receipt.send", Payload: payload},
		})
		if err != nil {
			return nil, err
		}
		approval, err := handler.WaitForSignal("approval")
		if err != nil {
			return nil, err
		}
		decision, err := handler.WaitForHuman("review", map[string]any{
			"payload": payload, "approval": approval,
		})
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"children": children, "approval": approval, "decision": decision,
		}, nil
	})
	worker.Handle("invoice.create", completeChild)
	worker.Handle("receipt.send", completeChild)

	if err := worker.Run(ctx); err != nil {
		panic(err)
	}
}

func completeChild(_ context.Context, payload any, _ *workhorse.HandlerContext) (any, error) {
	return map[string]any{"completed": true, "payload": payload}, nil
}
