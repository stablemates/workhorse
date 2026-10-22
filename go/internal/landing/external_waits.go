package example

import (
	"context"

	workhorse "github.com/stablemates/workhorse/go"
)

type review struct {
	Approved bool `json:"approved"`
}

func configureRelease(worker *workhorse.Worker) {
	worker.Handle("release.publish", func(
		_ context.Context, release any, handler *workhorse.HandlerContext,
	) (any, error) {
		scan, err := handler.WaitForSignal("security-scan")
		if err != nil {
			return nil, err
		}
		response, err := handler.WaitForHuman("release-approval", map[string]any{
			"release": release, "scan": scan,
		})
		if err != nil {
			return nil, err
		}
		decision, err := workhorse.DecodeValue[review](response)
		if err != nil {
			return nil, err
		}
		return map[string]any{"published": decision.Approved}, nil
	})
}

func deliverScan(ctx context.Context, queue *workhorse.Queue, taskID string, result any, deliveryID string) error {
	_, err := queue.SendSignal(ctx, taskID, "security-scan", result, workhorse.ExternalWaitDelivery{
		IdempotencyKey: deliveryID, RequestedBy: "security-scanner",
	})
	return err
}
