package workhorse_test

import (
	"context"
	"strings"
	"testing"
	"time"

	workhorse "github.com/stablemates/workhorse/go"
)

func TestAdminRoutesEveryOperatorOperationThroughThePublicClient(t *testing.T) {
	now := time.Now().UTC()
	responses := make([][]workhorse.Row, 0, 40)
	operation := func(rows ...workhorse.Row) {
		responses = append(responses, []workhorse.Row{{"kind": "schema", "version": int64(1)}, {"kind": "protocol", "version": int64(1)}}, rows)
	}
	operation() // ListJobs
	operation() // GetJob
	operation() // GetJobTimeline
	operation() // ListDeadLetters
	operation(workhorse.Row{"status": "created", "source_job_id": "source", "target_job_id": "target", "source_state": "failed", "target_state": "ready", "requested_at": now})
	operation() // RedriveMany
	operation() // GetCheckpoint
	operation() // ListCheckpoints
	operation() // GetProgress
	operation() // GetWait
	operation() // ListWaits
	operation() // ListSignalWaits
	operation() // ListHumanWaits
	operation(workhorse.Row{"set_queue_paused_v1": true})
	operation(workhorse.Row{"set_queue_paused_v1": false})
	operation(workhorse.Row{"deleted_count": int32(4)})
	operation() // ListWorkers
	operation(workhorse.Row{"worker_id": "worker", "paused": true, "paused_at": now, "paused_by": "operator", "paused_reason": "incident"})
	executor := &queueExecutor{responses: responses}
	admin := workhorse.NewAdmin(executor)
	audit := workhorse.AdminAudit{Actor: "operator", Reason: "incident", RequestID: "incident-42"}
	ctx := context.Background()

	if _, err := admin.ListJobs(ctx, workhorse.JobListQuery{}); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.GetJob(ctx, "00000000-0000-4000-8000-000000000001"); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.GetJobTimeline(ctx, "00000000-0000-4000-8000-000000000001", workhorse.JobTimelineQuery{}); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.ListDeadLetters(ctx, workhorse.DeadLetterQuery{}); err != nil {
		t.Fatal(err)
	}
	if result, err := admin.Redrive(ctx, "00000000-0000-4000-8000-000000000001", audit); err != nil || result.TargetJobID == nil {
		t.Fatalf("redrive: %#v %v", result, err)
	}
	if _, err := admin.RedriveMany(ctx, workhorse.DeadLetterFilter{}, audit, workhorse.BulkRedriveOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.GetCheckpoint(ctx, "00000000-0000-4000-8000-000000000001", "checkpoint"); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.ListCheckpoints(ctx, "00000000-0000-4000-8000-000000000001"); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.GetProgress(ctx, "00000000-0000-4000-8000-000000000001"); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.GetWait(ctx, "00000000-0000-4000-8000-000000000001", "wait"); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.ListWaits(ctx, "00000000-0000-4000-8000-000000000001"); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.ListSignalWaits(ctx, workhorse.ExternalWaitQuery{}); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.ListHumanWaits(ctx, workhorse.ExternalWaitQuery{}); err != nil {
		t.Fatal(err)
	}
	if err := admin.PauseQueue(ctx, "default", audit); err != nil {
		t.Fatal(err)
	}
	if err := admin.ResumeQueue(ctx, "default", audit); err != nil {
		t.Fatal(err)
	}
	if count, err := admin.PurgeQueue(ctx, "default", audit); err != nil || count != 4 {
		t.Fatalf("purge: %d %v", count, err)
	}
	if _, err := admin.ListWorkers(ctx); err != nil {
		t.Fatal(err)
	}
	if result, err := admin.SetWorkerPaused(ctx, "worker", true, audit); err != nil || result == nil || !result.Paused {
		t.Fatalf("worker pause: %#v %v", result, err)
	}

	joined := make([]string, 0, len(executor.calls))
	for _, call := range executor.calls {
		joined = append(joined, call.statement)
	}
	statements := strings.Join(joined, "\n")
	for _, function := range []string{"list_jobs_v1", "list_job_timeline_v1", "list_dead_letters_v1", "redrive_v1", "redrive_many_v1", "set_queue_paused_v1", "purge_queue_v1", "set_worker_paused_v1"} {
		if !strings.Contains(statements, function) {
			t.Errorf("Admin did not call %s", function)
		}
	}
}

func TestAdminRejectsIncompleteAuditBeforeQuery(t *testing.T) {
	executor := &queueExecutor{}
	admin := workhorse.NewAdmin(executor)
	if _, err := admin.PurgeQueue(context.Background(), "default", workhorse.AdminAudit{}); err == nil {
		t.Fatal("PurgeQueue accepted empty audit identity")
	}
	if len(executor.calls) != 0 {
		t.Fatalf("invalid audit reached PostgreSQL: %#v", executor.calls)
	}
}

func TestAdminMeasuresActorAndReasonInCharacters(t *testing.T) {
	executor := &queueExecutor{responses: [][]workhorse.Row{
		{{"kind": "schema", "version": int64(1)}, {"kind": "protocol", "version": int64(1)}},
		{{"set_queue_paused_v1": true}},
	}}
	admin := workhorse.NewAdmin(executor)
	audit := workhorse.AdminAudit{
		Actor:     strings.Repeat("é", 200),
		Reason:    strings.Repeat("界", 2000),
		RequestID: "unicode-audit",
	}
	if err := admin.PauseQueue(context.Background(), "default", audit); err != nil {
		t.Fatal(err)
	}
}
