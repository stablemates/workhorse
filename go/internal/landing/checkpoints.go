package example

import (
	"context"

	workhorse "github.com/stablemates/workhorse/go"
)

func registerInvoice(worker *workhorse.Worker) {
	worker.Handle("invoice.issue", func(
		_ context.Context, payload any, handler *workhorse.HandlerContext,
	) (any, error) {
		// After Workhorse stores a checkpoint result, later runs return it.
		charge, err := handler.Checkpoint("charge", func() (any, error) {
			return map[string]any{"payload": payload}, nil
		})
		if err != nil {
			return nil, err
		}
		pdf, err := handler.Checkpoint("render", func() (any, error) {
			return map[string]any{"charge": charge}, nil
		})
		if err != nil {
			return nil, err
		}
		return map[string]any{"charge": charge, "pdf": pdf}, nil
	})
}
