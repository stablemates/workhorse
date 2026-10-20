package example

import (
	"context"

	workhorse "github.com/stablemates/workhorse/go"
)

func captureInvoice(ctx context.Context, queue *workhorse.Queue) (string, error) {
	return queue.Enqueue(ctx, "invoice.capture", map[string]any{
		"invoiceId": "inv-1",
	}, workhorse.EnqueueOptions{
		Queue: "billing",
		Idempotency: &workhorse.Idempotency{
			Key: "capture:inv-1", Scope: "tenant-42", TTLMS: 86_400_000,
		},
	})
}
