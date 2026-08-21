package workhorse

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

const maximumWaitDuration = 365 * 24 * time.Hour

var errDurableWaitSuspension = errors.New(durableWaitSuspensionMessage)

// CheckpointLeaseLostError identifies a checkpoint rejected under a stale fence.
type CheckpointLeaseLostError struct {
	JobID          string
	CheckpointName string
}

func (err *CheckpointLeaseLostError) Error() string {
	return fmt.Sprintf(checkpointLeaseLostErrorFormat, err.CheckpointName, err.JobID)
}

func (err *CheckpointLeaseLostError) Unwrap() error { return ErrLeaseLost }

// CheckpointConflictError identifies an immutable checkpoint name reused with another value.
type CheckpointConflictError struct {
	JobID          string
	CheckpointName string
}

func (err *CheckpointConflictError) Error() string {
	return fmt.Sprintf(checkpointConflictErrorFormat, err.CheckpointName, err.JobID)
}

// WaitLeaseLostError identifies a durable wait rejected under a stale fence.
type WaitLeaseLostError struct {
	JobID    string
	WaitName string
}

func (err *WaitLeaseLostError) Error() string {
	return fmt.Sprintf(waitLeaseLostErrorFormat, err.WaitName, err.JobID)
}

func (err *WaitLeaseLostError) Unwrap() error { return ErrLeaseLost }

// WaitConflictError identifies a durable wait name reused with another target.
type WaitConflictError struct {
	JobID    string
	WaitName string
}

func (err *WaitConflictError) Error() string {
	return fmt.Sprintf(waitConflictErrorFormat, err.WaitName, err.JobID)
}

// WaitLimitExceededError identifies a job that already owns the supported number of waits.
type WaitLimitExceededError struct{ JobID string }

func (err *WaitLimitExceededError) Error() string {
	return fmt.Sprintf(waitLimitExceededErrorFormat, err.JobID)
}

type checkpointCall struct {
	done  chan struct{}
	value any
	err   error
}

type waitCall struct {
	done chan struct{}
	err  error
}

type waitRequest struct {
	durationMS *int64
	wakeAt     *time.Time
}

// HandlerContext exposes fenced durable operations for one claimed handler activation.
type HandlerContext struct {
	Job ClaimedJob

	context     context.Context
	cancel      context.CancelCauseFunc
	executor    Executor
	workerID    string
	checkpoint  sync.Mutex
	checkpoints map[string]*checkpointCall
	wait        sync.Mutex
	waits       map[string]*waitCall
	signal      sync.Mutex
	signals     map[string]*externalWaitCall
	human       sync.Mutex
	humanWaits  map[string]*humanWaitCall
	suspended   atomic.Bool
}

// Checkpoint returns the stored value for name, or runs and immutably saves operation once.
func (handler *HandlerContext) Checkpoint(
	name string,
	operation func() (any, error),
) (any, error) {
	if err := validateDurableName(name, durableCheckpointKindValue); err != nil {
		return nil, err
	}
	if operation == nil {
		return nil, errors.New(nilCheckpointOperationMessage)
	}
	handler.checkpoint.Lock()
	if handler.checkpoints == nil {
		handler.checkpoints = make(map[string]*checkpointCall)
	}
	if pending := handler.checkpoints[name]; pending != nil {
		handler.checkpoint.Unlock()
		<-pending.done
		return pending.value, pending.err
	}
	pending := &checkpointCall{done: make(chan struct{})}
	handler.checkpoints[name] = pending
	handler.checkpoint.Unlock()

	pending.value, pending.err = handler.runCheckpoint(name, operation)
	handler.checkpoint.Lock()
	delete(handler.checkpoints, name)
	close(pending.done)
	handler.checkpoint.Unlock()
	return pending.value, pending.err
}

func (handler *HandlerContext) runCheckpoint(
	name string,
	operation func() (any, error),
) (any, error) {
	if err := context.Cause(handler.context); err != nil {
		return nil, err
	}
	rows, err := handler.executor.Query(
		handler.context,
		internalStatementRegistry[listCheckpointStatementName],
		handler.Job.ID,
		name,
	)
	if err != nil {
		return nil, err
	}
	if len(rows) > 1 {
		return nil, errors.New(invalidCheckpointResultMessage)
	}
	if len(rows) == 1 {
		return decodedJSON(rows[0][rowCheckpointValueField])
	}
	value, err := operation()
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	rows, err = handler.executor.Query(
		handler.context,
		protocolStatementRegistry[saveCheckpointStatementName],
		handler.Job.ID,
		handler.workerID,
		handler.Job.FenceToken,
		name,
		encoded,
	)
	if err != nil {
		return nil, err
	}
	if len(rows) != 1 {
		return nil, errors.New(invalidCheckpointResultMessage)
	}
	switch status, _ := rows[0][rowStatusField].(string); status {
	case durableSavedValue, durableExistingValue:
		return decodedJSON(rows[0][rowCheckpointValueField])
	case durableStaleValue:
		return nil, &CheckpointLeaseLostError{JobID: handler.Job.ID, CheckpointName: name}
	case durableConflictValue:
		return nil, &CheckpointConflictError{JobID: handler.Job.ID, CheckpointName: name}
	default:
		return nil, fmt.Errorf(unknownCheckpointStatusFormat, status)
	}
}

// Sleep suspends the job without consuming its logical attempt until duration elapses.
func (handler *HandlerContext) Sleep(name string, duration time.Duration) error {
	if duration < time.Millisecond || duration > maximumWaitDuration || duration%time.Millisecond != 0 {
		return fmt.Errorf(waitDurationRangeFormat, time.Millisecond, maximumWaitDuration)
	}
	durationMS := int64(duration / time.Millisecond)
	return handler.scheduleWait(name, waitRequest{durationMS: &durationMS})
}

// SleepUntil suspends the job without consuming its logical attempt until wakeAt.
func (handler *HandlerContext) SleepUntil(name string, wakeAt time.Time) error {
	if wakeAt.IsZero() || time.Until(wakeAt) > maximumWaitDuration {
		return errors.New(waitTargetRangeMessage)
	}
	return handler.scheduleWait(name, waitRequest{wakeAt: &wakeAt})
}

func (handler *HandlerContext) scheduleWait(name string, request waitRequest) error {
	if err := validateDurableName(name, durableWaitKindValue); err != nil {
		return err
	}
	handler.wait.Lock()
	if handler.waits == nil {
		handler.waits = make(map[string]*waitCall)
	}
	if pending := handler.waits[name]; pending != nil {
		handler.wait.Unlock()
		<-pending.done
		return pending.err
	}
	pending := &waitCall{done: make(chan struct{})}
	handler.waits[name] = pending
	handler.wait.Unlock()

	pending.err = handler.runWait(name, request)
	handler.wait.Lock()
	delete(handler.waits, name)
	close(pending.done)
	handler.wait.Unlock()
	return pending.err
}

func (handler *HandlerContext) runWait(name string, request waitRequest) error {
	if err := context.Cause(handler.context); err != nil {
		return err
	}
	var durationMS any
	if request.durationMS != nil {
		durationMS = *request.durationMS
	}
	var wakeAt any
	if request.wakeAt != nil {
		wakeAt = *request.wakeAt
	}
	rows, err := handler.executor.Query(
		handler.context,
		protocolStatementRegistry[scheduleWaitStatementName],
		handler.Job.ID,
		handler.workerID,
		handler.Job.FenceToken,
		name,
		durationMS,
		wakeAt,
	)
	if err != nil {
		return err
	}
	if len(rows) != 1 {
		return errors.New(invalidDurableWaitResultMessage)
	}
	switch status, _ := rows[0][rowStatusField].(string); status {
	case durableElapsedValue:
		return nil
	case durableScheduledValue:
		handler.suspended.Store(true)
		handler.cancel(errDurableWaitSuspension)
		return errDurableWaitSuspension
	case durableStaleValue:
		return &WaitLeaseLostError{JobID: handler.Job.ID, WaitName: name}
	case durableConflictValue:
		return &WaitConflictError{JobID: handler.Job.ID, WaitName: name}
	case durableLimitExceededValue:
		return &WaitLimitExceededError{JobID: handler.Job.ID}
	default:
		return fmt.Errorf(unknownDurableWaitStatusFormat, status)
	}
}

func validateDurableName(name, kind string) error {
	length := utf8.RuneCountInString(name)
	if length < 1 || length > 200 {
		return fmt.Errorf(durableNameRangeFormat, kind)
	}
	return nil
}
