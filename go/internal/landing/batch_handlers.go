package example

import (
	"time"

	workhorse "github.com/stablemates/workhorse/go"
)

func registerEmailBatch(worker *workhorse.Worker, batchSize int, linger time.Duration) {
	worker.HandleBatch("email.send", workhorse.BatchHandlerOptions{
		MaxSize: batchSize, Linger: linger,
	}, func(items []workhorse.BatchHandlerItem) []workhorse.BatchHandlerOutcome {
		outcomes := make([]workhorse.BatchHandlerOutcome, len(items))
		for index, item := range items {
			outcomes[index] = workhorse.BatchSucceeded{Result: item.Payload}
		}
		return outcomes
	})
}
