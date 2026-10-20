package example

import (
	"context"

	workhorse "github.com/stablemates/workhorse/go"
)

func configureCheckout(ctx context.Context, queue *workhorse.Queue, worker *workhorse.Worker, orderID string) error {
	inventoryID, err := queue.Enqueue(ctx, "inventory.reserve", map[string]any{"orderId": orderID})
	if err != nil {
		return err
	}
	if _, err := queue.Enqueue(ctx, "order.confirm", map[string]any{
		"orderId": orderID,
	}, workhorse.EnqueueOptions{Dependencies: &workhorse.Dependencies{
		PrerequisiteTaskIDs: []string{inventoryID},
		OnSuccess:           workhorse.DependencyRelease,
		OnFailure:           workhorse.DependencyCancel,
		OnCancellation:      workhorse.DependencyCancel,
	}}); err != nil {
		return err
	}

	worker.Handle("order.fulfill", func(
		_ context.Context, order any, handler *workhorse.HandlerContext,
	) (any, error) {
		return handler.RunChild("charge", "payment.capture", order, workhorse.EnqueueOptions{})
	})
	return nil
}
