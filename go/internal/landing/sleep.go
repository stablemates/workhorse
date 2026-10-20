package example

import (
	"context"
	"time"

	workhorse "github.com/stablemates/workhorse/go"
)

func registerSettlement(worker *workhorse.Worker) {
	worker.Handle("order.settle", func(
		_ context.Context, payload any, handler *workhorse.HandlerContext,
	) (any, error) {
		order, err := handler.Checkpoint("place", func() (any, error) {
			return map[string]any{"payload": payload}, nil
		})
		if err != nil {
			return nil, err
		}
		if err := handler.Sleep("settlement-window", time.Hour); err != nil {
			return nil, err
		}
		return map[string]any{"order": order, "confirmed": true}, nil
	})
}
