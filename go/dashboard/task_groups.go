package dashboard

import (
	"context"
)

// The task group procedures (ADR 0095) run the statements that generate-bindings.ts copies from
// the TypeScript server, so every backend answers them with the same JSON.

func (service *backend) taskGroups(ctx context.Context, input any, _ string) (any, error) {
	return service.jsonQuery(ctx, taskGroupsStatement, string(mustJSON(input)))
}

func (service *backend) taskGroupDetail(ctx context.Context, input any, _ string) (any, error) {
	value, _ := document(input)
	value["canCancel"] = !service.readOnly
	result, err := service.jsonQuery(ctx, taskGroupDetailStatement, string(mustJSON(value)))
	if err != nil {
		return nil, err
	}
	if result == nil {
		return nil, &RPCError{Status: 404, Code: "NOT_FOUND", Message: "Task group not found"}
	}
	return result, nil
}

// cancelTaskGroup seals the group and cancels each member task that is not terminal, through
// cancel_task_group_v1. The authenticated actor is the actor of the cancel.
func (service *backend) cancelTaskGroup(ctx context.Context, input any, actor string) (any, error) {
	value, _ := document(input)
	audit := adminAudit(value, actor)
	result, err := service.jsonQuery(ctx, cancelTaskGroupStatement, string(mustJSON(map[string]any{
		"id": value["id"], "actor": audit.Actor, "reason": audit.Reason, "requestId": audit.RequestID,
	})))
	if err != nil {
		return nil, err
	}
	if result == nil {
		return nil, &RPCError{Status: 404, Code: "NOT_FOUND", Message: "Task group not found"}
	}
	return result, nil
}
