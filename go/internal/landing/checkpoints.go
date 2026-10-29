package example

import (
	"context"
	"fmt"

	workhorse "github.com/stablemates/workhorse/go"
)

type invoice struct {
	Amount int    `json:"amount"`
	Email  string `json:"email"`
}

type charge struct {
	ID string `json:"id"`
}

func chargeCard(amount int) (charge, error) {
	return charge{ID: fmt.Sprintf("ch_%d", amount)}, nil
}

func renderInvoice(chargeID string) (map[string]any, error) {
	return map[string]any{"chargeId": chargeID}, nil
}

func registerInvoice(worker *workhorse.Worker) {
	worker.Handle("invoice.issue", workhorse.Typed(func(
		_ context.Context,
		payload invoice,
		handler *workhorse.HandlerContext,
	) (any, error) {
		// Later runs return the stored checkpoint result.
		stored, err := handler.Checkpoint("charge", func() (any, error) {
			return chargeCard(payload.Amount)
		})
		if err != nil {
			return nil, err
		}
		paid, err := workhorse.DecodeValue[charge](stored)
		if err != nil {
			return nil, err
		}
		pdf, err := handler.Checkpoint("render", func() (any, error) {
			return renderInvoice(paid.ID)
		})
		if err != nil {
			return nil, err
		}
		fmt.Println("email", payload.Email, pdf)
		return map[string]any{"chargeId": paid.ID}, nil
	}))
}
