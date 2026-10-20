package example

import (
	"context"
	"time"

	workhorse "github.com/stablemates/workhorse/go"
)

func enqueueReminder(ctx context.Context, queue *workhorse.Queue, matchID string, kickoff time.Time) (string, error) {
	return queue.Enqueue(ctx, "match.reminder", map[string]any{
		"matchId": matchID,
	}, workhorse.EnqueueOptions{
		Deadline:           &kickoff,
		ExecutionTimeoutMS: 30_000,
		MaxAttempts:        5,
		RetryPolicy: map[string]any{
			"type": "exponential", "initialDelayMs": 1_000,
			"multiplier": 2, "maxDelayMs": 60_000,
		},
	})
}
