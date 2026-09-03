package workhorse

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	maximumExternalWaitTimeout = 7 * 24 * time.Hour
	maximumExternalWaitBytes   = 65_536
	maximumDeliveryKeyBytes    = 512
	maximumExternalActorRunes  = 200
)

// ExternalWaitOptions controls the PostgreSQL-owned deadline for a signal or human wait.
type ExternalWaitOptions struct {
	Timeout time.Duration
}

// ExternalWaitDelivery supplies idempotency and trusted attribution for an external value.
type ExternalWaitDelivery struct {
	IdempotencyKey string
	RequestedBy    string
}

// SignalDeliveryStatus is PostgreSQL's disposition for a signal delivery.
type SignalDeliveryStatus string

const (
	SignalDelivered        SignalDeliveryStatus = externalDeliveredValue
	SignalDuplicate        SignalDeliveryStatus = externalDuplicateValue
	SignalNotWaiting       SignalDeliveryStatus = externalNotWaitingValue
	SignalAlreadyDelivered SignalDeliveryStatus = externalAlreadyDeliveredValue
	SignalStale            SignalDeliveryStatus = durableStaleValue
	SignalNotFound         SignalDeliveryStatus = externalNotFoundValue
)

// SignalDeliveryResult contains the accepted or retained signal delivery.
type SignalDeliveryResult struct {
	Status      SignalDeliveryStatus
	JobID       string
	Name        string
	Payload     any
	DeliveredAt *time.Time
	DeliveredBy string
}

// HumanWaitCompletionStatus is PostgreSQL's disposition for a human decision.
type HumanWaitCompletionStatus string

const (
	HumanWaitCompleted        HumanWaitCompletionStatus = externalCompletedValue
	HumanWaitDuplicate        HumanWaitCompletionStatus = externalDuplicateValue
	HumanWaitNotWaiting       HumanWaitCompletionStatus = externalNotWaitingValue
	HumanWaitAlreadyCompleted HumanWaitCompletionStatus = externalAlreadyCompletedValue
	HumanWaitStale            HumanWaitCompletionStatus = durableStaleValue
	HumanWaitNotFound         HumanWaitCompletionStatus = externalNotFoundValue
)

// HumanWaitCompletionResult contains the accepted or retained human decision.
type HumanWaitCompletionResult struct {
	Status      HumanWaitCompletionStatus
	JobID       string
	Name        string
	Payload     any
	CompletedAt *time.Time
	CompletedBy string
}

// SignalWaitLeaseLostError identifies a signal wait rejected under a stale fence.
type SignalWaitLeaseLostError struct {
	JobID    string
	WaitName string
}

func (err *SignalWaitLeaseLostError) Error() string {
	return fmt.Sprintf(signalWaitLeaseLostErrorFormat, err.WaitName, err.JobID)
}

func (err *SignalWaitLeaseLostError) Unwrap() error { return ErrLeaseLost }

// SignalWaitConflictError identifies a signal name already waiting under another activation.
type SignalWaitConflictError struct {
	JobID    string
	WaitName string
}

func (err *SignalWaitConflictError) Error() string {
	return fmt.Sprintf(signalWaitConflictErrorFormat, err.WaitName, err.JobID)
}

// SignalWaitLimitExceededError identifies a job that owns the supported number of signal waits.
type SignalWaitLimitExceededError struct{ JobID string }

func (err *SignalWaitLimitExceededError) Error() string {
	return fmt.Sprintf(signalWaitLimitExceededErrorFormat, err.JobID)
}

// SignalIdempotencyConflictError identifies a retained key reused with another signal delivery.
type SignalIdempotencyConflictError struct {
	JobID    string
	WaitName string
}

func (err *SignalIdempotencyConflictError) Error() string {
	return fmt.Sprintf(signalIdempotencyConflictFormat, err.WaitName, err.JobID)
}

// HumanWaitLeaseLostError identifies a human wait rejected under a stale fence.
type HumanWaitLeaseLostError struct {
	JobID    string
	WaitName string
}

func (err *HumanWaitLeaseLostError) Error() string {
	return fmt.Sprintf(humanWaitLeaseLostErrorFormat, err.WaitName, err.JobID)
}

func (err *HumanWaitLeaseLostError) Unwrap() error { return ErrLeaseLost }

// HumanWaitAlreadyWaitingError identifies a human wait already owned by another activation.
type HumanWaitAlreadyWaitingError struct {
	JobID    string
	WaitName string
}

func (err *HumanWaitAlreadyWaitingError) Error() string {
	return fmt.Sprintf(humanWaitAlreadyWaitingErrorFormat, err.WaitName, err.JobID)
}

// HumanWaitLimitExceededError identifies a job that owns the supported number of human waits.
type HumanWaitLimitExceededError struct{ JobID string }

func (err *HumanWaitLimitExceededError) Error() string {
	return fmt.Sprintf(humanWaitLimitExceededErrorFormat, err.JobID)
}

// HumanWaitConflictError identifies a human wait name replayed with different context.
type HumanWaitConflictError struct {
	JobID    string
	WaitName string
}

func (err *HumanWaitConflictError) Error() string {
	return fmt.Sprintf(humanWaitConflictErrorFormat, err.WaitName, err.JobID)
}

// HumanWaitIdempotencyConflictError identifies a retained key reused with another decision.
type HumanWaitIdempotencyConflictError struct {
	JobID    string
	WaitName string
}

func (err *HumanWaitIdempotencyConflictError) Error() string {
	return fmt.Sprintf(humanWaitIdempotencyConflictFormat, err.WaitName, err.JobID)
}

type externalWaitCall struct {
	done  chan struct{}
	value any
	err   error
}

type humanWaitCall struct {
	externalWaitCall
	context string
}

// WaitForSignal suspends the job until a named signal is delivered, then returns its JSON payload.
func (handler *HandlerContext) WaitForSignal(name string, options ...ExternalWaitOptions) (any, error) {
	timeoutMS, err := validateExternalWait(name, signalLabelValue, options)
	if err != nil {
		return nil, err
	}
	handler.signal.Lock()
	if handler.signals == nil {
		handler.signals = make(map[string]*externalWaitCall)
	}
	if pending := handler.signals[name]; pending != nil {
		handler.signal.Unlock()
		<-pending.done
		return pending.value, pending.err
	}
	pending := &externalWaitCall{done: make(chan struct{})}
	handler.signals[name] = pending
	handler.signal.Unlock()

	pending.value, pending.err = handler.runSignalWait(name, timeoutMS)
	handler.signal.Lock()
	delete(handler.signals, name)
	close(pending.done)
	handler.signal.Unlock()
	return pending.value, pending.err
}

func (handler *HandlerContext) runSignalWait(name string, timeoutMS *int64) (any, error) {
	if err := context.Cause(handler.context); err != nil {
		return nil, err
	}
	var timeoutArgument any
	if timeoutMS != nil {
		timeoutArgument = *timeoutMS
	}
	rows, err := handler.executor.Query(
		handler.context,
		protocolStatementRegistry[waitForSignalStatementName],
		handler.Job.ID,
		handler.workerID,
		handler.Job.FenceToken,
		name,
		timeoutArgument,
	)
	if err != nil {
		return nil, err
	}
	if len(rows) != 1 {
		return nil, errors.New(invalidSignalWaitResultMessage)
	}
	switch status, _ := rows[0][rowStatusField].(string); status {
	case externalDeliveredValue:
		return decodedJSON(rows[0][rowPayloadField])
	case externalWaitingValue:
		handler.suspended.Store(true)
		handler.cancel(errDurableWaitSuspension)
		return nil, errDurableWaitSuspension
	case durableStaleValue:
		return nil, &SignalWaitLeaseLostError{JobID: handler.Job.ID, WaitName: name}
	case externalAlreadyWaitingValue:
		return nil, &SignalWaitConflictError{JobID: handler.Job.ID, WaitName: name}
	case durableLimitExceededValue:
		return nil, &SignalWaitLimitExceededError{JobID: handler.Job.ID}
	default:
		return nil, fmt.Errorf(unknownSignalWaitStatusFormat, status)
	}
}

// WaitForHuman suspends the job until a named decision is completed, then returns its JSON result.
func (handler *HandlerContext) WaitForHuman(
	name string,
	waitContext any,
	options ...ExternalWaitOptions,
) (any, error) {
	timeoutMS, err := validateExternalWait(name, humanWaitLabelValue, options)
	if err != nil {
		return nil, err
	}
	encodedContext, err := encodeExternalWaitValue(waitContext, humanWaitContextLabelValue)
	if err != nil {
		return nil, err
	}
	canonicalContext := string(encodedContext)
	handler.human.Lock()
	if handler.humanWaits == nil {
		handler.humanWaits = make(map[string]*humanWaitCall)
	}
	if pending := handler.humanWaits[name]; pending != nil {
		if pending.context != canonicalContext {
			handler.human.Unlock()
			return nil, &HumanWaitConflictError{JobID: handler.Job.ID, WaitName: name}
		}
		handler.human.Unlock()
		<-pending.done
		return pending.value, pending.err
	}
	pending := &humanWaitCall{
		externalWaitCall: externalWaitCall{done: make(chan struct{})},
		context:          canonicalContext,
	}
	handler.humanWaits[name] = pending
	handler.human.Unlock()

	pending.value, pending.err = handler.runHumanWait(name, encodedContext, timeoutMS)
	handler.human.Lock()
	delete(handler.humanWaits, name)
	close(pending.done)
	handler.human.Unlock()
	return pending.value, pending.err
}

func (handler *HandlerContext) runHumanWait(name string, waitContext []byte, timeoutMS *int64) (any, error) {
	if err := context.Cause(handler.context); err != nil {
		return nil, err
	}
	var timeoutArgument any
	if timeoutMS != nil {
		timeoutArgument = *timeoutMS
	}
	rows, err := handler.executor.Query(
		handler.context,
		protocolStatementRegistry[waitForHumanStatementName],
		handler.Job.ID,
		handler.workerID,
		handler.Job.FenceToken,
		name,
		waitContext,
		timeoutArgument,
	)
	if err != nil {
		return nil, err
	}
	if len(rows) != 1 {
		return nil, errors.New(invalidHumanWaitResultMessage)
	}
	switch status, _ := rows[0][rowStatusField].(string); status {
	case externalCompletedValue:
		return decodedJSON(rows[0][rowResultField])
	case externalWaitingValue:
		handler.suspended.Store(true)
		handler.cancel(errDurableWaitSuspension)
		return nil, errDurableWaitSuspension
	case durableStaleValue:
		return nil, &HumanWaitLeaseLostError{JobID: handler.Job.ID, WaitName: name}
	case externalAlreadyWaitingValue:
		return nil, &HumanWaitAlreadyWaitingError{JobID: handler.Job.ID, WaitName: name}
	case durableLimitExceededValue:
		return nil, &HumanWaitLimitExceededError{JobID: handler.Job.ID}
	case durableConflictValue:
		return nil, &HumanWaitConflictError{JobID: handler.Job.ID, WaitName: name}
	default:
		return nil, fmt.Errorf(unknownHumanWaitStatusFormat, status)
	}
}

// SendSignal delivers one idempotent JSON payload to a named signal wait.
func (queue *Queue) SendSignal(
	ctx context.Context,
	jobID string,
	name string,
	payload any,
	delivery ExternalWaitDelivery,
) (SignalDeliveryResult, error) {
	if err := validateExternalWaitName(name, signalLabelValue); err != nil {
		return SignalDeliveryResult{}, err
	}
	if err := validateExternalWaitDelivery(delivery, signalLabelValue); err != nil {
		return SignalDeliveryResult{}, err
	}
	encoded, err := encodeExternalWaitValue(payload, signalPayloadLabelValue)
	if err != nil {
		return SignalDeliveryResult{}, err
	}
	if err := AssertSchemaCompatible(ctx, queue.executor); err != nil {
		return SignalDeliveryResult{}, err
	}
	rows, err := queue.executor.Query(
		ctx,
		protocolStatementRegistry[sendSignalStatementName],
		jobID,
		name,
		encoded,
		delivery.IdempotencyKey,
		delivery.RequestedBy,
	)
	if err != nil {
		return SignalDeliveryResult{}, err
	}
	if len(rows) != 1 {
		return SignalDeliveryResult{}, errors.New(invalidSignalDeliveryResultMessage)
	}
	status, _ := rows[0][rowStatusField].(string)
	if status == durableConflictValue {
		return SignalDeliveryResult{}, &SignalIdempotencyConflictError{JobID: jobID, WaitName: name}
	}
	result := SignalDeliveryResult{Status: SignalDeliveryStatus(status), JobID: jobID, Name: name}
	switch result.Status {
	case SignalDelivered, SignalDuplicate, SignalNotWaiting, SignalAlreadyDelivered, SignalStale, SignalNotFound:
	default:
		return SignalDeliveryResult{}, fmt.Errorf(unknownSignalDeliveryStatusFormat, status)
	}
	result.Payload, err = decodedJSON(rows[0][rowPayloadField])
	if err != nil {
		return SignalDeliveryResult{}, err
	}
	if deliveredAt, ok := rows[0][rowDeliveredAtField].(time.Time); ok {
		result.DeliveredAt = &deliveredAt
	}
	if deliveredBy, ok := rows[0][rowDeliveredByField].(string); ok {
		result.DeliveredBy = deliveredBy
	}
	return result, nil
}

// CompleteHumanWait supplies one idempotent JSON result to a named human wait.
func (queue *Queue) CompleteHumanWait(
	ctx context.Context,
	jobID string,
	name string,
	result any,
	delivery ExternalWaitDelivery,
) (HumanWaitCompletionResult, error) {
	if err := validateExternalWaitName(name, humanWaitLabelValue); err != nil {
		return HumanWaitCompletionResult{}, err
	}
	if err := validateExternalWaitDelivery(delivery, humanWaitLabelValue); err != nil {
		return HumanWaitCompletionResult{}, err
	}
	encoded, err := encodeExternalWaitValue(result, humanWaitResultLabelValue)
	if err != nil {
		return HumanWaitCompletionResult{}, err
	}
	if err := AssertSchemaCompatible(ctx, queue.executor); err != nil {
		return HumanWaitCompletionResult{}, err
	}
	rows, err := queue.executor.Query(
		ctx,
		protocolStatementRegistry[completeHumanWaitStatementName],
		jobID,
		name,
		encoded,
		delivery.IdempotencyKey,
		delivery.RequestedBy,
	)
	if err != nil {
		return HumanWaitCompletionResult{}, err
	}
	if len(rows) != 1 {
		return HumanWaitCompletionResult{}, errors.New(invalidHumanCompletionResultMessage)
	}
	status, _ := rows[0][rowStatusField].(string)
	if status == durableConflictValue {
		return HumanWaitCompletionResult{}, &HumanWaitIdempotencyConflictError{JobID: jobID, WaitName: name}
	}
	completion := HumanWaitCompletionResult{
		Status: HumanWaitCompletionStatus(status), JobID: jobID, Name: name,
	}
	switch completion.Status {
	case HumanWaitCompleted, HumanWaitDuplicate, HumanWaitNotWaiting,
		HumanWaitAlreadyCompleted, HumanWaitStale, HumanWaitNotFound:
	default:
		return HumanWaitCompletionResult{}, fmt.Errorf(unknownHumanCompletionStatusFormat, status)
	}
	completion.Payload, err = decodedJSON(rows[0][rowResultField])
	if err != nil {
		return HumanWaitCompletionResult{}, err
	}
	if completedAt, ok := rows[0][rowCompletedAtField].(time.Time); ok {
		completion.CompletedAt = &completedAt
	}
	if completedBy, ok := rows[0][rowCompletedByField].(string); ok {
		completion.CompletedBy = completedBy
	}
	return completion, nil
}

func validateExternalWait(name, label string, options []ExternalWaitOptions) (*int64, error) {
	if err := validateExternalWaitName(name, label); err != nil {
		return nil, err
	}
	if len(options) > 1 {
		return nil, errors.New(externalWaitOptionsCountMessage)
	}
	if len(options) == 0 || options[0].Timeout == 0 {
		return nil, nil
	}
	timeout := options[0].Timeout
	if timeout < time.Millisecond || timeout > maximumExternalWaitTimeout || timeout%time.Millisecond != 0 {
		return nil, fmt.Errorf(externalWaitTimeoutRangeMessage, time.Millisecond, maximumExternalWaitTimeout)
	}
	timeoutMS := int64(timeout / time.Millisecond)
	return &timeoutMS, nil
}

func validateExternalWaitName(name, label string) error {
	if strings.TrimSpace(name) != name || utf8.RuneCountInString(name) < 1 || utf8.RuneCountInString(name) > 200 {
		return fmt.Errorf(externalWaitNameRangeFormat, label)
	}
	return nil
}

func validateExternalWaitDelivery(delivery ExternalWaitDelivery, label string) error {
	if len(delivery.IdempotencyKey) < 1 || len(delivery.IdempotencyKey) > maximumDeliveryKeyBytes {
		return fmt.Errorf(externalWaitDeliveryKeyRangeFormat, label)
	}
	actorRunes := utf8.RuneCountInString(delivery.RequestedBy)
	if actorRunes < 1 || actorRunes > maximumExternalActorRunes {
		return fmt.Errorf(externalWaitActorRangeFormat, label)
	}
	return nil
}

func encodeExternalWaitValue(value any, label string) ([]byte, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	if len(encoded) > maximumExternalWaitBytes {
		return nil, fmt.Errorf(externalWaitValueSizeFormat, label)
	}
	return encoded, nil
}
