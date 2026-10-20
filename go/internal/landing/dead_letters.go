package example

import (
	"context"

	workhorse "github.com/stablemates/workhorse/go"
)

func redriveBilling(ctx context.Context, admin *workhorse.Admin) error {
	page, err := admin.ListDeadLetters(ctx, workhorse.DeadLetterQuery{
		DeadLetterFilter: workhorse.DeadLetterFilter{
			Queue: "billing", ErrorName: "CardDeclined",
		},
	})
	if err != nil {
		return err
	}
	for _, failure := range page.Items {
		if _, err := admin.Redrive(ctx, failure.TaskID, workhorse.AdminAudit{
			Actor:     "operator@example.com",
			Reason:    "provider incident resolved",
			RequestID: "incident-2026-08-03:" + failure.TaskID,
		}); err != nil {
			return err
		}
	}
	return nil
}
