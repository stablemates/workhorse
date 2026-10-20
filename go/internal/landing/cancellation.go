package example

import (
	"context"
	"fmt"

	workhorse "github.com/stablemates/workhorse/go"
)

func configureExport(ctx context.Context, queue *workhorse.Queue, worker *workhorse.Worker, taskID string) error {
	worker.Handle("rows.export", func(
		handlerContext context.Context, payload any, _ *workhorse.HandlerContext,
	) (any, error) {
		if err := context.Cause(handlerContext); err != nil {
			return nil, err
		}
		fmt.Println("upload", payload)
		return map[string]any{"stopped": false}, nil
	})
	requestedBy, reason := "operator@example.com", "customer withdrew the request"
	_, err := queue.Cancel(ctx, taskID, workhorse.CancellationRequest{
		RequestedBy: &requestedBy, Reason: &reason,
	})
	return err
}
