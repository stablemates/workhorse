package workhorse

import (
	"context"
	"crypto/rand"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

const (
	maximumBatchSize   = 100
	maximumBatchLinger = 60 * time.Second
)

// BatchHandlerOptions bounds one process-local batch rendezvous.
type BatchHandlerOptions struct {
	MaxSize int
	Linger  time.Duration
}

// BatchHandlerContext exposes the fence, checkpoint, and task group operations of one task in the
// batch, without suspension APIs.
type BatchHandlerContext struct {
	Task    ClaimedTask
	Context context.Context

	handler *HandlerContext
}

// Checkpoint returns a member's stored value, or runs and saves operation once. See
// HandlerContext.Checkpoint for CheckpointOptions.
func (handler *BatchHandlerContext) Checkpoint(
	name string,
	operation func() (any, error),
	options ...CheckpointOptions,
) (any, error) {
	return handler.handler.Checkpoint(name, operation, options...)
}

// GetProgress returns the member's latest progress projection.
func (handler *BatchHandlerContext) GetProgress() (*TaskProgress, error) {
	return handler.handler.GetProgress()
}

// SetProgress replaces the member's latest progress under its fenced lease.
func (handler *BatchHandlerContext) SetProgress(value any) (*TaskProgress, error) {
	return handler.handler.SetProgress(value)
}

// GetTaskGroup reads the group this task in the batch is a member of, or whose callback it is. It
// returns nil for a task with no group.
func (handler *BatchHandlerContext) GetTaskGroup() (*TaskGroupLink, error) {
	return handler.handler.GetTaskGroup()
}

// AddToTaskGroup adds up to MaxEnqueueBatchSize tasks to the group of this member task, under its
// fenced lease. A request without a queue goes to the queue of this task in the batch.
func (handler *BatchHandlerContext) AddToTaskGroup(requests []EnqueueRequest) ([]EnqueueResult, error) {
	return handler.handler.AddToTaskGroup(requests)
}

// BatchHandlerItem is one claimed payload and its independent fenced context.
type BatchHandlerItem struct {
	Payload any
	Context *BatchHandlerContext
}

// BatchHandlerOutcome is one member's explicit success or failure.
type BatchHandlerOutcome interface {
	batchHandlerOutcome()
}

// BatchSucceeded completes one member with Result.
type BatchSucceeded struct{ Result any }

func (BatchSucceeded) batchHandlerOutcome() {}

// BatchFailed submits Error through one member's persisted retry policy.
type BatchFailed struct{ Error error }

func (BatchFailed) batchHandlerOutcome() {}

// BatchHandler processes one ordered group and returns one positional outcome per member.
type BatchHandler func([]BatchHandlerItem) []BatchHandlerOutcome

type batchMember struct {
	arrival int64
	arrived time.Time
	item    BatchHandlerItem
	result  chan batchMemberResult
	// returnLock orders the record of the return of the batch handler against the end of the wait
	// of this member. Only the dispatch and this member's own leave take it, never a lock that
	// another member holds (ADR 0117).
	returnLock sync.Mutex
	// returned holds the result of the batch handler for this member once it returned. The
	// dispatch sets it before the failure evidence write.
	returned *batchMemberResult
}

type batchMemberResult struct {
	value any
	err   error
}

type batchCoordinator struct {
	worker   *Worker
	taskType string
	options  BatchHandlerOptions
	handler  BatchHandler
	mu       sync.Mutex
	next     int64
	pending  map[string][]*batchMember
}

// HandleBatch registers a process-local batch coordinator for one task type. It follows the rule
// of Handle: it is safe to call from any goroutine, also while Run or RunOnce runs, and it applies
// to each task that the worker claims after HandleBatch returns.
func (worker *Worker) HandleBatch(
	taskType string,
	options BatchHandlerOptions,
	handler BatchHandler,
) *Worker {
	if taskType == emptyString {
		panic(emptyWorkerTaskTypeMessage)
	}
	if handler == nil {
		panic(nilBatchHandlerMessage)
	}
	if options.MaxSize < 1 || options.MaxSize > maximumBatchSize {
		panic(fmt.Sprintf(batchSizeRangeFormat, maximumBatchSize))
	}
	if options.MaxSize > worker.concurrency {
		panic(batchSizeConcurrencyMessage)
	}
	if options.Linger < 0 || options.Linger > maximumBatchLinger || options.Linger%time.Millisecond != 0 {
		panic(fmt.Sprintf(batchLingerRangeFormat, maximumBatchLinger))
	}
	coordinator := &batchCoordinator{
		worker: worker, taskType: taskType, options: options, handler: handler,
		pending: make(map[string][]*batchMember),
	}
	worker.registerHandler(taskType, coordinator.handle)
	return worker
}

func (coordinator *batchCoordinator) handle(
	ctx context.Context,
	payload any,
	handler *HandlerContext,
) (any, error) {
	member := &batchMember{
		arrived: time.Now(),
		item: BatchHandlerItem{
			Payload: payload,
			Context: &BatchHandlerContext{Task: handler.Task, Context: ctx, handler: handler},
		},
		result: make(chan batchMemberResult, 1),
	}
	coordinator.mu.Lock()
	member.arrival = coordinator.next
	coordinator.next++
	queue := handler.Task.Queue
	coordinator.pending[queue] = append(coordinator.pending[queue], member)
	firstArrival := coordinator.pending[queue][0].arrived
	var batch []*batchMember
	if len(coordinator.pending[queue]) >= coordinator.options.MaxSize {
		batch = coordinator.take(queue)
	}
	coordinator.mu.Unlock()

	if len(batch) > 0 {
		coordinator.dispatch(batch)
	} else if coordinator.options.Linger == 0 {
		coordinator.mu.Lock()
		batch = coordinator.take(queue)
		coordinator.mu.Unlock()
		if len(batch) > 0 {
			coordinator.dispatch(batch)
		}
	} else {
		timer := time.NewTimer(max(time.Millisecond, time.Until(firstArrival.Add(coordinator.options.Linger))))
		defer timer.Stop()
		select {
		case result := <-member.result:
			return result.value, result.err
		case <-timer.C:
			coordinator.mu.Lock()
			batch = coordinator.take(queue)
			coordinator.mu.Unlock()
			if len(batch) > 0 {
				coordinator.dispatch(batch)
			}
		case <-ctx.Done():
			return coordinator.leave(ctx, queue, member)
		}
	}

	select {
	case result := <-member.result:
		return result.value, result.err
	case <-ctx.Done():
		return coordinator.leave(ctx, queue, member)
	}
}

// leave ends the wait of a member whose context ended. If the batch handler already returned, the
// member settles with its result, so a stop during the evidence write keeps the failure of the
// handler and its error (ADR 0117). Otherwise the member leaves its queue with the cause.
func (coordinator *batchCoordinator) leave(
	ctx context.Context,
	queue string,
	member *batchMember,
) (any, error) {
	member.returnLock.Lock()
	returned := member.returned
	if returned == nil {
		// The batch handler has not returned for this member, so the cancellation came first.
		member.item.Context.handler.markReturned()
	}
	member.returnLock.Unlock()
	if returned != nil {
		return returned.value, returned.err
	}
	coordinator.remove(queue, member)
	return nil, context.Cause(ctx)
}

func (coordinator *batchCoordinator) take(queue string) []*batchMember {
	pending := coordinator.pending[queue]
	if len(pending) == 0 {
		return nil
	}
	size := min(coordinator.options.MaxSize, len(pending))
	batch := append([]*batchMember(nil), pending[:size]...)
	if size == len(pending) {
		delete(coordinator.pending, queue)
	} else {
		coordinator.pending[queue] = pending[size:]
	}
	sort.SliceStable(batch, func(left, right int) bool {
		leftTask := batch[left].item.Context.Task
		rightTask := batch[right].item.Context.Task
		if leftTask.Priority != rightTask.Priority {
			return leftTask.Priority > rightTask.Priority
		}
		return batch[left].arrival < batch[right].arrival
	})
	return batch
}

func (coordinator *batchCoordinator) remove(queue string, target *batchMember) {
	coordinator.mu.Lock()
	defer coordinator.mu.Unlock()
	pending := coordinator.pending[queue]
	for index, member := range pending {
		if member != target {
			continue
		}
		pending = append(pending[:index], pending[index+1:]...)
		if len(pending) == 0 {
			delete(coordinator.pending, queue)
		} else {
			coordinator.pending[queue] = pending
		}
		return
	}
}

func (coordinator *batchCoordinator) dispatch(batch []*batchMember) {
	// answered marks each member that got its result. If code outside the batch handler panics
	// before every member has one, each other member gets the result that the batch handler
	// returned for it, or the panic as a HandlerPanicError. Thus no member waits until the stop.
	answered := make([]bool, len(batch))
	defer func() {
		recovered := recover()
		if recovered == nil {
			return
		}
		panicked := newHandlerPanicError(batchDispatchPanicFormat, coordinator.taskType, recovered)
		for index, member := range batch {
			if answered[index] {
				continue
			}
			member.returnLock.Lock()
			if member.returned == nil {
				member.item.Context.handler.markReturned()
				member.returned = &batchMemberResult{err: panicked}
			}
			result := *member.returned
			member.returnLock.Unlock()
			member.result <- result
		}
	}()
	queue := batch[0].item.Context.Task.Queue
	full := len(batch) == coordinator.options.MaxSize
	linger := time.Since(batch[0].arrived)
	if coordinator.worker.metrics.enabled {
		attributes := metric.WithAttributes(
			attribute.String(queueNameAttribute, queue),
			attribute.String(taskTypeAttribute, coordinator.taskType),
			attribute.Bool(batchFullAttribute, full),
		)
		coordinator.worker.metrics.batchSize.Record(
			batch[0].item.Context.Context,
			int64(len(batch)),
			attributes,
		)
		coordinator.worker.metrics.batchLinger.Record(
			batch[0].item.Context.Context,
			float64(linger)/float64(time.Millisecond),
			attributes,
		)
	}
	logWorkerEvent(
		batch[0].item.Context.Context,
		coordinator.worker.logger,
		slog.LevelDebug,
		batchDispatchedEvent,
		batchDispatchedLogMessage,
		func() []any {
			return []any{
				slog.String(queueNameAttribute, queue),
				slog.String(taskTypeAttribute, coordinator.taskType),
				slog.String(workerIDAttribute, coordinator.worker.workerID),
				slog.Int(batchSizeAttribute, len(batch)),
				slog.Float64(batchLingerAttribute, float64(linger)/float64(time.Millisecond)),
				slog.Bool(batchFullAttribute, full),
			}
		},
	)
	batchID, hasBatchID := newUUID()
	if hasBatchID {
		coordinator.record(batch[0].item.Context.Context, recordBatchDispatchStatementName, batchID, batch)
	}
	items := make([]BatchHandlerItem, len(batch))
	for index, member := range batch {
		items[index] = member.item
	}
	outcomes, err := callBatchHandler(coordinator.taskType, coordinator.handler, items)
	var results []batchMemberResult
	if err == nil {
		results, err = normalizeBatchOutcomes(coordinator.taskType, outcomes, len(batch))
	}
	// Each member records the return of the handler and its result before the evidence write. A
	// stop during that write then cannot turn a failure into a release, or replace its error with
	// the cancellation (ADR 0117). The record reads the cause under the lock of the member alone,
	// so no wait for a lock that another member holds comes between the return and the read.
	for index, member := range batch {
		result := batchMemberResult{err: err}
		if err == nil {
			result = results[index]
		}
		member.returnLock.Lock()
		member.item.Context.handler.markReturned()
		member.returned = &result
		member.returnLock.Unlock()
	}
	if err != nil {
		if hasBatchID {
			coordinator.record(batch[0].item.Context.Context, recordBatchFailureStatementName, batchID, batch)
		}
		for index, member := range batch {
			member.result <- batchMemberResult{err: err}
			answered[index] = true
		}
		return
	}
	for index, member := range batch {
		member.result <- results[index]
		answered[index] = true
	}
}

func (coordinator *batchCoordinator) record(
	ctx context.Context,
	statement string,
	batchID string,
	batch []*batchMember,
) {
	taskIDs := make([]string, len(batch))
	attempts := make([]int, len(batch))
	fences := make([]int64, len(batch))
	for index, member := range batch {
		task := member.item.Context.Task
		taskIDs[index], attempts[index], fences[index] = task.ID, task.Attempt, task.FenceToken
	}
	rows, err := queryFencedWrite(
		ctx,
		NewPGXExecutor(coordinator.worker.pool),
		protocolStatementRegistry[statement],
		batchID,
		taskIDs,
		attempts,
		fences,
		coordinator.worker.workerID,
	)
	if err != nil || len(rows) != 1 {
		return
	}
	recorded, ok := integer(rows[0][rowRecordedField])
	if !ok || recorded != len(batch) {
		return
	}
}

func callBatchHandler(
	taskType string,
	handler BatchHandler,
	items []BatchHandlerItem,
) (outcomes []BatchHandlerOutcome, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = newHandlerPanicError(batchHandlerPanicFormat, taskType, recovered)
		}
	}()
	return handler(items), nil
}

func normalizeBatchOutcomes(
	taskType string,
	outcomes []BatchHandlerOutcome,
	expected int,
) ([]batchMemberResult, error) {
	if len(outcomes) != expected {
		return nil, fmt.Errorf(batchOutcomeCountFormat, taskType, len(outcomes), expected)
	}
	results := make([]batchMemberResult, len(outcomes))
	for index, outcome := range outcomes {
		switch outcome := outcome.(type) {
		case BatchSucceeded:
			results[index].value = outcome.Result
		case *BatchSucceeded:
			if outcome == nil {
				return nil, fmt.Errorf(invalidBatchOutcomeFormat, taskType, index)
			}
			results[index].value = outcome.Result
		case BatchFailed:
			if outcome.Error == nil {
				return nil, fmt.Errorf(invalidBatchOutcomeFormat, taskType, index)
			}
			results[index].err = outcome.Error
		case *BatchFailed:
			if outcome == nil || outcome.Error == nil {
				return nil, fmt.Errorf(invalidBatchOutcomeFormat, taskType, index)
			}
			results[index].err = outcome.Error
		default:
			return nil, fmt.Errorf(invalidBatchOutcomeFormat, taskType, index)
		}
	}
	return results, nil
}

func newUUID() (string, bool) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return emptyString, false
	}
	value[6] = value[6]&0x0f | 0x40
	value[8] = value[8]&0x3f | 0x80
	return fmt.Sprintf(batchIDFormat, value[0:4], value[4:6], value[6:8], value[8:10], value[10:16]), true
}
