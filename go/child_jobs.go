package workhorse

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

// MaxChildJobs is PostgreSQL's linked-child limit for one parent.
const MaxChildJobs = 100

var errChildSuspension = errors.New(childSuspensionMessage)

// ChildJobRequest describes one named child created by an active parent handler.
type ChildJobRequest struct {
	Name    string
	Type    string
	Payload any
	Options EnqueueOptions
}

// ChildResult retains one joined result beside its stable child name.
// CreateChildren returns these records in request order.
type ChildResult struct {
	Name   string `json:"name"`
	Result any    `json:"result"`
}

type childSetInput struct {
	Name    string            `json:"name"`
	Request childEnqueueInput `json:"request"`
}

type childEnqueueInput struct {
	Queue                string   `json:"queue"`
	Type                 string   `json:"type"`
	Payload              any      `json:"payload"`
	Priority             int      `json:"priority"`
	ContractVersion      any      `json:"contractVersion"`
	PayloadMaxBytes      int      `json:"payloadMaxBytes"`
	ResultMaxBytes       int      `json:"resultMaxBytes"`
	SensitivePayloadKeys []string `json:"sensitivePayloadKeys"`
	SensitiveResultKeys  []string `json:"sensitiveResultKeys"`
	TraceContext         any      `json:"traceContext,omitempty"`
	RunAt                *string  `json:"runAt,omitempty"`
	Deadline             *string  `json:"deadline"`
	ConcurrencyKey       any      `json:"concurrencyKey"`
	ExecutionTimeoutMS   any      `json:"executionTimeoutMs"`
	MaxAttempts          int      `json:"maxAttempts"`
	RetryPolicy          any      `json:"retryPolicy"`
	PrerequisiteJobID    any      `json:"prerequisiteJobId"`
	Dependencies         any      `json:"dependencies"`
	Tags                 []string `json:"tags"`
}

// ChildLeaseLostError identifies child creation rejected under a stale parent fence.
type ChildLeaseLostError struct{ ParentJobID string }

func (err *ChildLeaseLostError) Error() string {
	return fmt.Sprintf(childLeaseLostErrorFormat, err.ParentJobID)
}

func (err *ChildLeaseLostError) Unwrap() error { return ErrLeaseLost }

// ChildConflictError identifies a retained child name or set replayed with another request.
type ChildConflictError struct {
	ParentJobID string
	ChildName   string
}

func (err *ChildConflictError) Error() string {
	return fmt.Sprintf(childConflictErrorFormat, err.ChildName, err.ParentJobID)
}

// ChildLimitExceededError identifies a parent that exceeds MaxChildJobs.
type ChildLimitExceededError struct{ ParentJobID string }

func (err *ChildLimitExceededError) Error() string {
	return fmt.Sprintf(childLimitExceededErrorFormat, err.ParentJobID)
}

// ChildResultLimitExceededError identifies joined results larger than the parent's contract.
type ChildResultLimitExceededError struct {
	ParentJobID      string
	ResultBytes      int
	ResultLimitBytes int
}

func (err *ChildResultLimitExceededError) Error() string {
	return fmt.Sprintf(childResultLimitExceededErrorFormat, err.ParentJobID)
}

type childCall struct {
	done    chan struct{}
	request string
	value   any
	err     error
}

type childrenCall struct {
	done    chan struct{}
	request string
	value   []ChildResult
	err     error
}

// CreateChild creates one named child or joins its retained result after parent replay.
func (handler *HandlerContext) CreateChild(
	name string,
	jobType string,
	payload any,
	options ...EnqueueOptions,
) (any, error) {
	if len(options) > 1 {
		return nil, fmt.Errorf(tooManyChildOptionsMessage, ErrInvalidEnqueueOptions)
	}
	if err := validateDurableName(name, childLabelValue); err != nil {
		return nil, err
	}
	childOptions := EnqueueOptions{}
	if len(options) == 1 {
		childOptions = options[0]
	}
	_, canonical, err := serializeChildRequest(handler.Job, jobType, payload, childOptions)
	if err != nil {
		return nil, err
	}

	handler.child.Lock()
	if handler.children == nil {
		handler.children = make(map[string]*childCall)
	}
	if pending := handler.children[name]; pending != nil {
		if pending.request != canonical {
			handler.child.Unlock()
			return nil, &ChildConflictError{ParentJobID: handler.Job.ID, ChildName: name}
		}
		handler.child.Unlock()
		<-pending.done
		return pending.value, pending.err
	}
	pending := &childCall{done: make(chan struct{}), request: canonical}
	handler.children[name] = pending
	handler.child.Unlock()

	pending.value, pending.err = handler.createChild(name, []byte(canonical))
	handler.child.Lock()
	delete(handler.children, name)
	close(pending.done)
	handler.child.Unlock()
	return pending.value, pending.err
}

func (handler *HandlerContext) createChild(name string, request []byte) (any, error) {
	if err := context.Cause(handler.context); err != nil {
		return nil, err
	}
	rows, err := handler.executor.Query(
		handler.context,
		protocolStatementRegistry[createChildStatementName],
		handler.Job.ID,
		handler.workerID,
		handler.Job.FenceToken,
		name,
		request,
	)
	if err != nil {
		return nil, err
	}
	if len(rows) != 1 {
		return nil, errors.New(invalidChildResultMessage)
	}
	status, _ := rows[0][rowStatusField].(string)
	switch status {
	case childCreatedValue:
		handler.suspended.Store(true)
		handler.cancel(errChildSuspension)
		return nil, errChildSuspension
	case childCompletedValue:
		return decodedJSON(rows[0][rowResultField])
	case durableStaleValue:
		return nil, &ChildLeaseLostError{ParentJobID: handler.Job.ID}
	case durableConflictValue:
		return nil, &ChildConflictError{ParentJobID: handler.Job.ID, ChildName: name}
	case durableLimitExceededValue:
		return nil, &ChildLimitExceededError{ParentJobID: handler.Job.ID}
	default:
		return nil, fmt.Errorf(unknownChildStatusFormat, status)
	}
}

// CreateChildren creates one bounded child set or joins its results after parent replay.
// Results retain request order, while Name provides stable keyed lookup to callers.
func (handler *HandlerContext) CreateChildren(children []ChildJobRequest) ([]ChildResult, error) {
	if len(children) > MaxChildJobs {
		return nil, &ChildLimitExceededError{ParentJobID: handler.Job.ID}
	}
	requests := make([]childSetInput, len(children))
	names := make(map[string]struct{}, len(children))
	for index, child := range children {
		if err := validateDurableName(child.Name, childLabelValue); err != nil {
			return nil, err
		}
		if _, exists := names[child.Name]; exists {
			return nil, errors.New(uniqueChildNamesMessage)
		}
		names[child.Name] = struct{}{}
		request, _, err := serializeChildRequest(handler.Job, child.Type, child.Payload, child.Options)
		if err != nil {
			return nil, fmt.Errorf(childRequestErrorFormat, index+1, err)
		}
		requests[index] = childSetInput{Name: child.Name, Request: request}
	}
	encoded, err := json.Marshal(requests)
	if err != nil {
		return nil, err
	}
	canonical := string(encoded)

	handler.childSet.Lock()
	if pending := handler.childSetCall; pending != nil {
		if pending.request != canonical {
			handler.childSet.Unlock()
			return nil, &ChildConflictError{ParentJobID: handler.Job.ID, ChildName: childSetNameValue}
		}
		handler.childSet.Unlock()
		<-pending.done
		return pending.value, pending.err
	}
	pending := &childrenCall{done: make(chan struct{}), request: canonical}
	handler.childSetCall = pending
	handler.childSet.Unlock()

	pending.value, pending.err = handler.createChildren(encoded)
	handler.childSet.Lock()
	handler.childSetCall = nil
	close(pending.done)
	handler.childSet.Unlock()
	return pending.value, pending.err
}

func (handler *HandlerContext) createChildren(requests []byte) ([]ChildResult, error) {
	if err := context.Cause(handler.context); err != nil {
		return nil, err
	}
	rows, err := handler.executor.Query(
		handler.context,
		protocolStatementRegistry[createChildrenStatementName],
		handler.Job.ID,
		handler.workerID,
		handler.Job.FenceToken,
		requests,
	)
	if err != nil {
		return nil, err
	}
	if len(rows) != 1 {
		return nil, errors.New(invalidChildrenResultMessage)
	}
	status, _ := rows[0][rowStatusField].(string)
	switch status {
	case childCreatedValue:
		handler.suspended.Store(true)
		handler.cancel(errChildSuspension)
		return nil, errChildSuspension
	case childCompletedValue:
		return orderedChildResults(rows[0][rowChildrenField])
	case durableStaleValue:
		return nil, &ChildLeaseLostError{ParentJobID: handler.Job.ID}
	case durableConflictValue:
		return nil, &ChildConflictError{ParentJobID: handler.Job.ID, ChildName: childSetNameValue}
	case durableLimitExceededValue:
		return nil, &ChildLimitExceededError{ParentJobID: handler.Job.ID}
	case childResultTooLargeValue:
		resultBytes, _ := integer(rows[0][rowResultBytesField])
		resultLimitBytes, _ := integer(rows[0][rowResultLimitBytesField])
		return nil, &ChildResultLimitExceededError{
			ParentJobID: handler.Job.ID, ResultBytes: resultBytes, ResultLimitBytes: resultLimitBytes,
		}
	default:
		return nil, fmt.Errorf(unknownChildrenStatusFormat, status)
	}
}

func serializeChildRequest(
	parent ClaimedJob,
	jobType string,
	payload any,
	options EnqueueOptions,
) (childEnqueueInput, string, error) {
	if err := validateEnqueueOptions(options); err != nil {
		return childEnqueueInput{}, emptyString, err
	}
	if options.Idempotency != nil || options.Debounce != nil || options.Throttle != nil || options.Dependencies != nil {
		return childEnqueueInput{}, emptyString, fmt.Errorf(childKeyedOptionsMessage, ErrInvalidEnqueueOptions)
	}
	queueName := options.Queue
	if queueName == emptyString {
		queueName = defaultWorkerQueueValue
	}
	maxAttempts := options.MaxAttempts
	if maxAttempts == 0 {
		maxAttempts = defaultMaxAttempts
	}
	request := childEnqueueInput{
		Queue: queueName, Type: jobType, Payload: payload, Priority: options.Priority,
		PayloadMaxBytes: defaultJobValueMaxBytes, ResultMaxBytes: defaultJobValueMaxBytes,
		SensitivePayloadKeys: []string{}, SensitiveResultKeys: []string{},
		TraceContext: parent.TraceContext, ConcurrencyKey: nilIfEmpty(options.ConcurrencyKey),
		ExecutionTimeoutMS: nilIfZero(options.ExecutionTimeoutMS), MaxAttempts: maxAttempts,
		RetryPolicy: options.RetryPolicy, Tags: append([]string{}, options.Tags...),
	}
	if options.RunAt != nil {
		formatted := formatTimestamp(*options.RunAt)
		request.RunAt = &formatted
	}
	if options.Deadline != nil {
		formatted := formatTimestamp(*options.Deadline)
		request.Deadline = &formatted
	}
	encoded, err := json.Marshal(request)
	if err != nil {
		return childEnqueueInput{}, emptyString, err
	}
	return request, string(encoded), nil
}

func orderedChildResults(value any) ([]ChildResult, error) {
	decoded, err := decodedJSON(value)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(decoded)
	if err != nil {
		return nil, err
	}
	var children []struct {
		Name   string `json:"name"`
		Result any    `json:"result"`
	}
	if err := json.Unmarshal(encoded, &children); err != nil {
		return nil, errors.New(invalidChildrenResultMessage)
	}
	results := make([]ChildResult, len(children))
	for index, child := range children {
		results[index] = ChildResult{Name: child.Name, Result: child.Result}
	}
	return results, nil
}
