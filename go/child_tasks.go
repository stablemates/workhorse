package workhorse

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// MaxChildTasks is PostgreSQL's linked-child limit for one parent.
const MaxChildTasks = 100

var errChildSuspension = errors.New(childSuspensionMessage)

// ChildTaskRequest describes one named child created by an active parent handler.
type ChildTaskRequest struct {
	Name    string
	Type    string
	Payload any
	Options EnqueueOptions
}

// ChildOutcome is one tagged terminal outcome returned by RunChildren.
type ChildOutcome interface {
	OutcomeStatus() string
	childOutcome()
}

type ChildSucceeded struct {
	Result any `json:"result"`
}

func (ChildSucceeded) OutcomeStatus() string { return taskSucceededValue }
func (ChildSucceeded) childOutcome()         {}
func (outcome ChildSucceeded) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		Status string `json:"status"`
		Result any    `json:"result"`
	}{Status: outcome.OutcomeStatus(), Result: outcome.Result})
}

type ChildFailed struct {
	Error any `json:"error"`
}

func (ChildFailed) OutcomeStatus() string { return taskFailedValue }
func (ChildFailed) childOutcome()         {}
func (outcome ChildFailed) MarshalJSON() ([]byte, error) {
	return marshalChildErrorOutcome(outcome.OutcomeStatus(), outcome.Error)
}

type ChildCanceled struct {
	Error any `json:"error"`
}

func (ChildCanceled) OutcomeStatus() string { return taskCanceledValue }
func (ChildCanceled) childOutcome()         {}
func (outcome ChildCanceled) MarshalJSON() ([]byte, error) {
	return marshalChildErrorOutcome(outcome.OutcomeStatus(), outcome.Error)
}

func marshalChildErrorOutcome(status string, value any) ([]byte, error) {
	return json.Marshal(struct {
		Status string `json:"status"`
		Error  any    `json:"error"`
	}{Status: status, Error: value})
}

// ChildResult retains one settled outcome beside its stable child name.
type ChildResult struct {
	Name    string       `json:"name"`
	Outcome ChildOutcome `json:"outcome"`
}

// ChildSuccessResult is one successful result from RunChildrenAll.
type ChildSuccessResult struct {
	Name   string `json:"name"`
	Result any    `json:"result"`
}

type childSetInput struct {
	Name    string            `json:"name"`
	Request childEnqueueInput `json:"request"`
}

type childJoinMode string

type childEnqueueInput struct {
	Queue                string   `json:"queue"`
	Type                 string   `json:"type"`
	Payload              any      `json:"payload"`
	Priority             int      `json:"priority"`
	ContractVersion      any      `json:"contractVersion"`
	PayloadMaxBytes      any      `json:"payloadMaxBytes"`
	ResultMaxBytes       any      `json:"resultMaxBytes"`
	SensitivePayloadKeys any      `json:"sensitivePayloadKeys"`
	SensitiveResultKeys  any      `json:"sensitiveResultKeys"`
	TraceContext         any      `json:"traceContext,omitempty"`
	RunAt                *string  `json:"runAt,omitempty"`
	Deadline             *string  `json:"deadline"`
	ConcurrencyKey       any      `json:"concurrencyKey"`
	Budget               any      `json:"budget"`
	ExecutionTimeoutMS   any      `json:"executionTimeoutMs"`
	MaxAttempts          int      `json:"maxAttempts"`
	RetryPolicy          any      `json:"retryPolicy"`
	PrerequisiteTaskID   any      `json:"prerequisiteTaskId"`
	Dependencies         any      `json:"dependencies"`
	Tags                 []string `json:"tags"`
}

// ChildLeaseLostError identifies child creation rejected under a stale parent fence.
type ChildLeaseLostError struct{ ParentTaskID string }

func (err *ChildLeaseLostError) Error() string {
	return fmt.Sprintf(childLeaseLostErrorFormat, err.ParentTaskID)
}

func (err *ChildLeaseLostError) Unwrap() error { return ErrLeaseLost }

// ChildConflictError identifies a retained child name or set replayed with another request.
type ChildConflictError struct {
	ParentTaskID    string
	ChildName       string
	StoredChildName string
}

func (err *ChildConflictError) Error() string {
	if err.StoredChildName != emptyString && err.StoredChildName != err.ChildName {
		return fmt.Sprintf(childRenameConflictErrorFormat, err.ParentTaskID, err.StoredChildName, err.ChildName)
	}
	return fmt.Sprintf(childConflictErrorFormat, err.ChildName, err.ParentTaskID)
}

// ChildLimitExceededError identifies a parent that exceeds MaxChildTasks.
type ChildLimitExceededError struct{ ParentTaskID string }

func (err *ChildLimitExceededError) Error() string {
	return fmt.Sprintf(childLimitExceededErrorFormat, err.ParentTaskID)
}

// ChildResultLimitExceededError identifies joined results larger than the parent's contract.
type ChildResultLimitExceededError struct {
	ParentTaskID     string
	ResultBytes      int
	ResultLimitBytes int
}

func (err *ChildResultLimitExceededError) Error() string {
	return fmt.Sprintf(childResultLimitExceededErrorFormat, err.ParentTaskID)
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
	value   any
	err     error
}

// RunChild creates one named child or joins its retained result after parent replay.
func (handler *HandlerContext) RunChild(
	name string,
	taskType string,
	payload any,
	options ...EnqueueOptions,
) (any, error) {
	if err := handler.rejectOnFastTier(fastTierChildTasksFeature); err != nil {
		return nil, err
	}
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
	build := func(versions childVersions) ([]byte, error) {
		request, err := handler.serializeChildRequest(
			name, taskType, payload, childOptions, versions, make(childContracts),
		)
		if err != nil {
			return nil, err
		}
		return json.Marshal(request)
	}
	encoded, err := handler.initialChildRequest(build)
	if err != nil {
		return nil, err
	}
	canonical := string(encoded)

	handler.child.Lock()
	if handler.children == nil {
		handler.children = make(map[string]*childCall)
	}
	if pending := handler.children[name]; pending != nil {
		if pending.request != canonical {
			handler.child.Unlock()
			return nil, &ChildConflictError{ParentTaskID: handler.Task.ID, ChildName: name}
		}
		handler.child.Unlock()
		<-pending.done
		return pending.value, pending.err
	}
	pending := &childCall{done: make(chan struct{}), request: canonical}
	handler.children[name] = pending
	handler.child.Unlock()

	pending.value, pending.err = handler.createChild(name, encoded, build)
	handler.child.Lock()
	delete(handler.children, name)
	close(pending.done)
	handler.child.Unlock()
	return pending.value, pending.err
}

func (handler *HandlerContext) createChild(
	name string,
	request []byte,
	build func(childVersions) ([]byte, error),
) (any, error) {
	write := func(request []byte) (map[string]any, error) {
		if err := context.Cause(handler.context); err != nil {
			return nil, err
		}
		rows, err := queryFencedWrite(
			handler.context,
			handler.executor,
			protocolStatementRegistry[createChildStatementName],
			handler.Task.ID,
			handler.workerID,
			handler.Task.FenceToken,
			name,
			request,
		)
		if err != nil {
			return nil, err
		}
		if len(rows) != 1 {
			return nil, errors.New(invalidChildResultMessage)
		}
		return rows[0], nil
	}
	row, err := write(request)
	if err != nil {
		return nil, err
	}
	if row, err = handler.replayedChildRequest(row, request, build, write); err != nil {
		return nil, err
	}
	status, _ := row[rowStatusField].(string)
	switch status {
	case childCreatedValue:
		handler.suspended.Store(true)
		handler.cancel(errChildSuspension)
		return nil, errChildSuspension
	case childCompletedValue:
		return decodedJSON(row[rowResultField])
	case durableStaleValue:
		return nil, &ChildLeaseLostError{ParentTaskID: handler.Task.ID}
	case durableConflictValue:
		storedName, _ := row[rowStoredChildNameField].(string)
		return nil, &ChildConflictError{ParentTaskID: handler.Task.ID, ChildName: name, StoredChildName: storedName}
	case durableLimitExceededValue:
		return nil, &ChildLimitExceededError{ParentTaskID: handler.Task.ID}
	default:
		return nil, fmt.Errorf(unknownChildStatusFormat, status)
	}
}

// RunChildren creates one bounded child set or joins its results after parent replay.
// Results retain request order, while Name provides stable keyed lookup to callers.
func (handler *HandlerContext) RunChildren(children []ChildTaskRequest) ([]ChildResult, error) {
	value, err := handler.createChildSet(children, childSettledModeValue)
	if err != nil {
		return nil, err
	}
	return value.([]ChildResult), nil
}

// RunChildrenAll preserves propagation semantics and returns only successful child results.
func (handler *HandlerContext) RunChildrenAll(children []ChildTaskRequest) ([]ChildSuccessResult, error) {
	value, err := handler.createChildSet(children, childAllSuccessModeValue)
	if err != nil {
		return nil, err
	}
	return value.([]ChildSuccessResult), nil
}

func (handler *HandlerContext) createChildSet(children []ChildTaskRequest, mode childJoinMode) (any, error) {
	if err := handler.rejectOnFastTier(fastTierChildTasksFeature); err != nil {
		return nil, err
	}
	if len(children) > MaxChildTasks {
		return nil, &ChildLimitExceededError{ParentTaskID: handler.Task.ID}
	}
	names := make(map[string]struct{}, len(children))
	for _, child := range children {
		if err := validateDurableName(child.Name, childLabelValue); err != nil {
			return nil, err
		}
		if _, exists := names[child.Name]; exists {
			return nil, errors.New(uniqueChildNamesMessage)
		}
		names[child.Name] = struct{}{}
	}
	build := func(versions childVersions) ([]byte, error) {
		requests := make([]childSetInput, len(children))
		contracts := make(childContracts)
		for index, child := range children {
			request, err := handler.serializeChildRequest(
				child.Name, child.Type, child.Payload, child.Options, versions, contracts,
			)
			if err != nil {
				return nil, fmt.Errorf(childRequestErrorFormat, index+1, err)
			}
			requests[index] = childSetInput{Name: child.Name, Request: request}
		}
		return json.Marshal(requests)
	}
	encoded, err := handler.initialChildRequest(build)
	if err != nil {
		return nil, err
	}
	canonical := string(mode) + childCallModeSeparator + string(encoded)

	handler.childSet.Lock()
	if pending := handler.childSetCall; pending != nil {
		if pending.request != canonical {
			handler.childSet.Unlock()
			return nil, &ChildConflictError{ParentTaskID: handler.Task.ID, ChildName: childSetNameValue}
		}
		handler.childSet.Unlock()
		<-pending.done
		return pending.value, pending.err
	}
	pending := &childrenCall{done: make(chan struct{}), request: canonical}
	handler.childSetCall = pending
	handler.childSet.Unlock()

	pending.value, pending.err = handler.createChildren(encoded, mode, build)
	handler.childSet.Lock()
	handler.childSetCall = nil
	close(pending.done)
	handler.childSet.Unlock()
	return pending.value, pending.err
}

func (handler *HandlerContext) createChildren(
	requests []byte,
	mode childJoinMode,
	build func(childVersions) ([]byte, error),
) (any, error) {
	write := func(requests []byte) (map[string]any, error) {
		if err := context.Cause(handler.context); err != nil {
			return nil, err
		}
		rows, err := queryFencedWrite(
			handler.context,
			handler.executor,
			protocolStatementRegistry[createChildrenStatementName],
			handler.Task.ID,
			handler.workerID,
			handler.Task.FenceToken,
			requests,
			mode,
		)
		if err != nil {
			return nil, err
		}
		if len(rows) != 1 {
			return nil, errors.New(invalidChildrenResultMessage)
		}
		return rows[0], nil
	}
	row, err := write(requests)
	if err != nil {
		return nil, err
	}
	if row, err = handler.replayedChildRequest(row, requests, build, write); err != nil {
		return nil, err
	}
	rows := []map[string]any{row}
	status, _ := rows[0][rowStatusField].(string)
	switch status {
	case childCreatedValue:
		handler.suspended.Store(true)
		handler.cancel(errChildSuspension)
		return nil, errChildSuspension
	case childCompletedValue:
		return orderedChildResults(rows[0][rowChildrenField], mode)
	case durableStaleValue:
		return nil, &ChildLeaseLostError{ParentTaskID: handler.Task.ID}
	case durableConflictValue:
		return nil, &ChildConflictError{ParentTaskID: handler.Task.ID, ChildName: childSetNameValue}
	case durableLimitExceededValue:
		return nil, &ChildLimitExceededError{ParentTaskID: handler.Task.ID}
	case childResultTooLargeValue:
		resultBytes, _ := integer(rows[0][rowResultBytesField])
		resultLimitBytes, _ := integer(rows[0][rowResultLimitBytesField])
		return nil, &ChildResultLimitExceededError{
			ParentTaskID: handler.Task.ID, ResultBytes: resultBytes, ResultLimitBytes: resultLimitBytes,
		}
	default:
		return nil, fmt.Errorf(unknownChildrenStatusFormat, status)
	}
}

// childVersions maps a child name to the contract version its existing task carries. A nil version
// records a child created without a contract, and a name it omits takes the current contract.
type childVersions map[string]*string

type childContractKey struct {
	taskType string
	pinned   bool
	version  string
}

// childContracts caches the contracts one child request build loads.
type childContracts map[childContractKey]*payloadContract

// initialChildRequest builds the request under the current contracts. When those contracts reject
// a payload, a replayed parent builds again with each existing child at the version it was created
// under. PostgreSQL still rejects a request that differs from the accepted one.
func (handler *HandlerContext) initialChildRequest(build func(childVersions) ([]byte, error)) ([]byte, error) {
	encoded, err := build(nil)
	var validation *TaskContractValidationError
	if err == nil {
		return encoded, nil
	}
	if !errors.As(err, &validation) {
		return nil, handler.childLookupError(err)
	}
	versions, loadErr := handler.acceptedChildVersions()
	if loadErr != nil {
		return nil, handler.childLookupError(loadErr)
	}
	if len(versions) == 0 {
		return nil, err
	}
	accepted, acceptedErr := build(versions)
	if acceptedErr != nil {
		if errors.As(acceptedErr, &validation) {
			return nil, err
		}
		return nil, handler.childLookupError(acceptedErr)
	}
	return accepted, nil
}

// childLookupError returns the handler's cancellation cause when a contract lookup failed after the
// handler context ended, so a lost lease surfaces as LeaseLostError rather than context.Canceled.
func (handler *HandlerContext) childLookupError(err error) error {
	if cause := context.Cause(handler.context); cause != nil {
		return cause
	}
	return err
}

// replayedChildRequest retries a conflict once with each existing child stamped with the contract
// version it was created under. PostgreSQL compares a replayed request with the accepted one,
// contract stamp included, so a contract change since the first activation would otherwise conflict.
func (handler *HandlerContext) replayedChildRequest(
	row map[string]any,
	request []byte,
	build func(childVersions) ([]byte, error),
	write func([]byte) (map[string]any, error),
) (map[string]any, error) {
	if status, _ := row[rowStatusField].(string); status != durableConflictValue {
		return row, nil
	}
	versions, err := handler.acceptedChildVersions()
	if err != nil {
		return nil, handler.childLookupError(err)
	}
	if len(versions) == 0 {
		return row, nil
	}
	accepted, err := build(versions)
	if err != nil {
		var validation *TaskContractValidationError
		if errors.As(err, &validation) {
			return row, nil
		}
		return nil, handler.childLookupError(err)
	}
	if bytes.Equal(accepted, request) {
		return row, nil
	}
	return write(accepted)
}

// acceptedChildVersions returns the contract version of each child this task created, by name.
func (handler *HandlerContext) acceptedChildVersions() (childVersions, error) {
	edges, err := handler.executor.Query(
		handler.context,
		internalStatementRegistry[taskChildStatementName],
		handler.Task.ID,
		MaxChildTasks+1,
	)
	if err != nil {
		return nil, err
	}
	versions := make(childVersions)
	for _, edge := range edges {
		if parent, _ := uuidString(edge[rowParentTaskIDField]); !strings.EqualFold(parent, handler.Task.ID) {
			continue
		}
		name, nameOK := edge[rowChildNameField].(string)
		childID, idOK := uuidString(edge[rowChildTaskIDField])
		if !nameOK || !idOK {
			return nil, errors.New(invalidChildResultMessage)
		}
		rows, err := handler.executor.Query(handler.context, adminStatementRegistry[getTaskStatementName], childID)
		if err != nil {
			return nil, err
		}
		var version *string
		if len(rows) == 1 {
			if value, ok := rows[0][rowContractVersionField].(string); ok {
				version = &value
			}
		}
		versions[name] = version
	}
	return versions, nil
}

// serializeChildRequest renders the create-child request for one child. A contracted child carries
// the contract PostgreSQL holds now, because a child write has no stale-contract retry. A name in
// versions stamps that contract version instead, or none when the version is nil.
func (handler *HandlerContext) serializeChildRequest(
	name string,
	taskType string,
	payload any,
	options EnqueueOptions,
	versions childVersions,
	contracts childContracts,
) (childEnqueueInput, error) {
	if err := validateEnqueueOptions(options); err != nil {
		return childEnqueueInput{}, err
	}
	if options.Idempotency != nil || options.Debounce != nil || options.Throttle != nil || options.Dependencies != nil {
		return childEnqueueInput{}, fmt.Errorf(childKeyedOptionsMessage, ErrInvalidEnqueueOptions)
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
		Queue: queueName, Type: taskType, Payload: payload, Priority: options.Priority,
		PayloadMaxBytes: defaultTaskValueMaxBytes, ResultMaxBytes: defaultTaskValueMaxBytes,
		SensitivePayloadKeys: []string{}, SensitiveResultKeys: []string{},
		TraceContext: handler.Task.TraceContext, ConcurrencyKey: nilIfEmpty(options.ConcurrencyKey),
		Budget:             nilIfEmpty(options.Budget),
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
	contract, err := handler.childContract(name, taskType, versions, contracts)
	if err != nil {
		return childEnqueueInput{}, err
	}
	if contract == nil {
		return request, nil
	}
	if err := contract.validatePayload(taskType, payload); err != nil {
		return childEnqueueInput{}, err
	}
	request.ContractVersion = contract.version
	request.PayloadMaxBytes = contract.payloadMaxBytes
	request.ResultMaxBytes = contract.resultMaxBytes
	request.SensitivePayloadKeys = contract.sensitivePayloadKeys
	request.SensitiveResultKeys = contract.sensitiveResultKeys
	return request, nil
}

// childContract loads the contract a child request carries, reusing loads within one build.
func (handler *HandlerContext) childContract(
	name string,
	taskType string,
	versions childVersions,
	contracts childContracts,
) (*payloadContract, error) {
	version, pinned := versions[name]
	key := childContractKey{taskType: taskType, pinned: pinned}
	var requested any
	if pinned {
		if version == nil {
			return nil, nil
		}
		key.version = *version
		requested = *version
	}
	if contract, ok := contracts[key]; ok {
		return contract, nil
	}
	contract, err := loadPayloadContract(handler.context, handler.executor, handler.contracts, taskType, requested)
	if err != nil {
		return nil, err
	}
	contracts[key] = contract
	return contract, nil
}

type childSetRow struct {
	Name    string         `json:"name"`
	Result  any            `json:"result"`
	Outcome map[string]any `json:"outcome"`
}

// decodeChildSetRows reads the children column once. pgx delivers jsonb already decoded, so
// that shape is walked directly; raw JSON from database/sql is unmarshalled once.
func decodeChildSetRows(value any) ([]childSetRow, error) {
	var encoded []byte
	switch value := value.(type) {
	case []byte:
		encoded = value
	case string:
		encoded = []byte(value)
	case []any:
		children := make([]childSetRow, len(value))
		for index, item := range value {
			document, ok := item.(map[string]any)
			if !ok {
				return nil, errors.New(invalidChildrenResultMessage)
			}
			name, ok := document[rowNameField].(string)
			if !ok {
				return nil, errors.New(invalidChildrenResultMessage)
			}
			outcome, _ := document[rowOutcomeField].(map[string]any)
			children[index] = childSetRow{Name: name, Result: document[rowResultField], Outcome: outcome}
		}
		return children, nil
	default:
		return nil, errors.New(invalidChildrenResultMessage)
	}
	var children []childSetRow
	if err := json.Unmarshal(encoded, &children); err != nil {
		return nil, errors.New(invalidChildrenResultMessage)
	}
	return children, nil
}

func orderedChildResults(value any, mode childJoinMode) (any, error) {
	children, err := decodeChildSetRows(value)
	if err != nil {
		return nil, err
	}
	if mode == childAllSuccessModeValue {
		results := make([]ChildSuccessResult, len(children))
		for index, child := range children {
			results[index] = ChildSuccessResult{Name: child.Name, Result: child.Result}
		}
		return results, nil
	}
	results := make([]ChildResult, len(children))
	for index, child := range children {
		var outcome ChildOutcome
		switch child.Outcome[rowStatusField] {
		case taskSucceededValue:
			outcome = ChildSucceeded{Result: child.Outcome[rowResultField]}
		case taskFailedValue:
			outcome = ChildFailed{Error: child.Outcome[rowErrorField]}
		case taskCanceledValue:
			outcome = ChildCanceled{Error: child.Outcome[rowErrorField]}
		default:
			return nil, errors.New(invalidChildrenResultMessage)
		}
		results[index] = ChildResult{Name: child.Name, Outcome: outcome}
	}
	return results, nil
}
