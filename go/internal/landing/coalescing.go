package example

import (
	"context"
	"fmt"

	workhorse "github.com/stablemates/workhorse/go"
)

func reindex(ctx context.Context, queue *workhorse.Queue, documentID string, quietMS int) error {
	options := workhorse.EnqueueOptions{Debounce: &workhorse.Debounce{
		Key: documentID, Scope: "search-index",
		WindowMS: quietMS, Schedule: workhorse.DebounceReset,
	}}
	first, err := queue.EnqueueWithResult(ctx, "search.reindex", map[string]any{
		"documentId": documentID, "revision": 1,
	}, options)
	if err != nil {
		return err
	}
	latest, err := queue.EnqueueWithResult(ctx, "search.reindex", map[string]any{
		"documentId": documentID, "revision": 2,
	}, options)
	if err == nil {
		fmt.Println(first.Outcome, latest.Outcome)
	}
	return err
}
