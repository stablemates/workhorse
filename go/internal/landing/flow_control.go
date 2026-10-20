package example

import (
	"context"

	workhorse "github.com/stablemates/workhorse/go"
)

func configureFlowControl(
	ctx context.Context,
	queue *workhorse.Queue,
	messageID string,
	tenantID string,
) error {
	maxPerTenant := 2
	if _, err := queue.SyncConcurrencyPolicies(ctx, "workers", []workhorse.ConcurrencyPolicyDefinition{
		{Queue: "mail", MaxActive: 20, MaxActivePerKey: &maxPerTenant},
	}); err != nil {
		return err
	}
	if _, err := queue.SyncRateLimitPolicies(ctx, "workers", []workhorse.RateLimitPolicyDefinition{
		{
			Queue: "provider-api",
			Rate:  workhorse.RateLimit{Limit: 100, IntervalMS: 1_000, Burst: 200},
		},
	}); err != nil {
		return err
	}
	_, err := queue.Enqueue(ctx, "mail.send", map[string]any{
		"messageId": messageID,
	}, workhorse.EnqueueOptions{
		Queue: "mail", ConcurrencyKey: "tenant:" + tenantID,
	})
	return err
}
