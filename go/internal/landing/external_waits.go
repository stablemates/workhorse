package example

import (
	"context"
	"fmt"

	workhorse "github.com/stablemates/workhorse/go"
)

func configureRelease(worker *workhorse.Worker) {
	worker.Handle("release.publish", func(
		_ context.Context, release any, handler *workhorse.HandlerContext,
	) (any, error) {
		scan, err := handler.WaitForSignal("security-scan")
		if err != nil {
			return nil, err
		}
		review, err := handler.WaitForHuman("release-approval", map[string]any{
			"release": release, "scan": scan,
		})
		if err != nil {
			return nil, err
		}
		decision, ok := review.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("review must be an object")
		}
		approved, ok := decision["approved"].(bool)
		if !ok {
			return nil, fmt.Errorf("review needs a boolean approved field")
		}
		return map[string]any{"published": approved}, nil
	})
}

func deliverScan(ctx context.Context, queue *workhorse.Queue, taskID string, result any, deliveryID string) error {
	_, err := queue.SendSignal(ctx, taskID, "security-scan", result, workhorse.ExternalWaitDelivery{
		IdempotencyKey: deliveryID, RequestedBy: "security-scanner",
	})
	return err
}
