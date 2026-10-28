package workhorse

import (
	"context"
	"errors"
	"testing"
)

// countingExecutor counts each statement and fails it, so a test can assert that none ran.
type countingExecutor struct {
	statements int
}

func (executor *countingExecutor) Query(context.Context, string, ...any) ([]Row, error) {
	executor.statements++
	return nil, errors.New("unexpected statement")
}

// Each batch checks the options of every request before its first statement: the compatibility
// query, a payload contract read, or a membership read. A valid request comes before the invalid one.
func TestBatchChecksEveryRequestOptionBeforeAnyStatement(t *testing.T) {
	valid := EnqueueRequest{Type: "valid", Payload: map[string]any{}}
	invalid := EnqueueRequest{Type: "invalid", Payload: map[string]any{}, Options: EnqueueOptions{MaxAttempts: 101}}
	cases := map[string]func(*countingExecutor) error{
		"child set": func(executor *countingExecutor) error {
			_, err := newBatchOrderHandler(executor).RunChildren([]ChildTaskRequest{
				{Name: "valid", Type: valid.Type, Payload: valid.Payload},
				{Name: "invalid", Type: invalid.Type, Payload: invalid.Payload, Options: invalid.Options},
			})
			return err
		},
		"task group callbacks": func(executor *countingExecutor) error {
			_, err := NewQueue(executor, "default").CreateTaskGroup(context.Background(), TaskGroupCallbacks{
				OnFinish: &valid, OnSuccess: &EnqueueRequest{Type: "invalid", Options: EnqueueOptions{Priority: 101}},
			})
			return err
		},
		"task group block": func(executor *countingExecutor) error {
			_, err := NewQueue(executor, "default").TaskGroup(
				context.Background(), TaskGroupCallbacks{OnFinish: &invalid},
				func(builder *TaskGroupBuilder) error { return builder.Add(valid) },
			)
			return err
		},
		"task group add": func(executor *countingExecutor) error {
			_, err := NewQueue(executor, "default").AddToTaskGroup(context.Background(), "group", []EnqueueRequest{valid, invalid})
			return err
		},
		"handler task group add": func(executor *countingExecutor) error {
			_, err := newBatchOrderHandler(executor).AddToTaskGroup([]EnqueueRequest{valid, invalid})
			return err
		},
	}
	for name, run := range cases {
		t.Run(name, func(t *testing.T) {
			executor := &countingExecutor{}
			if err := run(executor); !errors.Is(err, ErrInvalidEnqueueOptions) {
				t.Fatalf("expected ErrInvalidEnqueueOptions, got %v", err)
			}
			if executor.statements != 0 {
				t.Fatalf("expected no statement, got %d", executor.statements)
			}
		})
	}
}

func newBatchOrderHandler(executor Executor) *HandlerContext {
	return &HandlerContext{
		Task:     ClaimedTask{ID: "task", Queue: "defaults", FenceToken: 1},
		context:  context.Background(),
		executor: executor,
		workerID: "worker",
	}
}
