package workhorse

import "time"

// QueueTierStatementForTest is the SQL of the tier read that a worker sends before it probes a
// queue of unknown tier.
var QueueTierStatementForTest = internalStatementRegistry[queueTierStatementName]

// FastClaimStatementForTest is the SQL of the fast claim, complete_many_and_claim_v1.
var FastClaimStatementForTest = protocolStatementRegistry[completeManyAndClaimStatementName]

// EndFullTierIntervalForTest ends the full-tier interval of queue, so the next claim of worker
// probes the tier again.
func EndFullTierIntervalForTest(worker *Worker, queue string) {
	worker.fullTierMu.Lock()
	defer worker.fullTierMu.Unlock()
	if _, known := worker.fullTierUntil[queue]; known {
		worker.fullTierUntil[queue] = time.Time{}
	}
}

// FullTierQueueForTest reports whether worker holds queue as full tier until its next probe.
func FullTierQueueForTest(worker *Worker, queue string) bool {
	worker.fullTierMu.Lock()
	defer worker.fullTierMu.Unlock()
	_, known := worker.fullTierUntil[queue]
	return known
}
