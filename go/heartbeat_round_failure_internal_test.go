package workhorse

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"syscall"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
)

// timeoutNetError is a net.Error that reports a timeout, as a dial or socket timeout does.
type timeoutNetError struct{}

func (timeoutNetError) Error() string   { return "i/o timeout" }
func (timeoutNetError) Timeout() bool   { return true }
func (timeoutNetError) Temporary() bool { return true }

func socketReset() error {
	return &net.OpError{Op: "read", Net: "tcp", Err: os.NewSyscallError("read", syscall.ECONNRESET)}
}

func TestHeartbeatRoundFailureReason(t *testing.T) {
	// A ConnectError that a test builds has no inner error, so each case joins it with the error
	// that pgx would wrap. The classifier reads both through errors.As and errors.Is.
	connectError := &pgconn.ConnectError{Config: &pgconn.Config{}}
	for _, testCase := range []struct {
		name            string
		err             error
		deadlineReached bool
		reason          string
	}{
		{"the round deadline", errHeartbeatRoundExpired, false, "timeout"},
		{"a deadline before the heartbeat", errHeartbeatRoundExpiredBeforeHeartbeat, false, "timeout"},
		{"the context deadline at the round deadline", fmt.Errorf("query: %w", context.DeadlineExceeded), true, "timeout"},
		{"a pgx connect timeout before the round deadline", errors.Join(connectError, context.DeadlineExceeded), false, "connection"},
		{"a context deadline before the round deadline", fmt.Errorf("query: %w", context.DeadlineExceeded), false, "connection"},
		{"statement_timeout", &pgconn.PgError{Code: "57014"}, false, "timeout"},
		{"an idle transaction timeout", &pgconn.PgError{Code: "25P03"}, false, "timeout"},
		{"a socket timeout that the round deadline did not cause", timeoutNetError{}, false, "connection"},
		{"a socket reset", socketReset(), false, "connection"},
		{"a wrapped socket reset", fmt.Errorf("heartbeat: %w", socketReset()), false, "connection"},
		{"a failed dial", errors.Join(connectError, socketReset()), false, "connection"},
		{"a closed pgx connection", fmt.Errorf("query: %w", pgconn.ErrConnClosed), false, "connection"},
		{"an end of stream", fmt.Errorf("receive: %w", io.ErrUnexpectedEOF), false, "connection"},
		{"SQLSTATE class 08", &pgconn.PgError{Code: "08006"}, false, "connection"},
		{"a server shutdown", &pgconn.PgError{Code: "57P01"}, false, "connection"},
		{"a refused password at connection startup", errors.Join(connectError, &pgconn.PgError{Code: "28P01"}), false, "database"},
		{"a socket reset after a server error", errors.Join(&pgconn.PgError{Code: "28P01"}, socketReset()), false, "connection"},
		{"a server error and a context deadline before the round deadline", errors.Join(&pgconn.PgError{Code: "28P01"}, context.DeadlineExceeded), false, "database"},
		{"a server error and a context deadline at the round deadline", errors.Join(&pgconn.PgError{Code: "28P01"}, context.DeadlineExceeded), true, "timeout"},
		{"a socket reset and a context deadline before the round deadline", errors.Join(context.DeadlineExceeded, socketReset()), false, "connection"},
		{"another SQLSTATE", fmt.Errorf("round: %w", &pgconn.PgError{Code: "40P01"}), false, "database"},
		{"an error without a code", errors.New("unexpected"), false, "other"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			reason := heartbeatRoundFailureReason(testCase.err, testCase.deadlineReached)
			if reason != testCase.reason {
				t.Fatalf("heartbeatRoundFailureReason = %q; want %q", reason, testCase.reason)
			}
		})
	}
}

// A round that fails before PostgreSQL answers counts once in round_failure, by reason. It gives no
// ownership verdict, so the attempt keeps running and heartbeat.failure stays empty.
func TestAFailedHeartbeatRoundCountsByReasonAndKeepsTheAttempt(t *testing.T) {
	reader := sdkmetric.NewManualReader()
	provider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	previousProvider := otel.GetMeterProvider()
	otel.SetMeterProvider(provider)
	t.Cleanup(func() {
		otel.SetMeterProvider(previousProvider)
		_ = provider.Shutdown(context.Background())
	})
	fake := &fakeHeartbeat{answer: func(call int, tasks []string) (map[string]ownershipStatus, error) {
		if call == 0 {
			return nil, fmt.Errorf("heartbeat_many_v2: %w", socketReset())
		}
		return statusesFor(tasks, workerOwnershipAccepted, nil), nil
	}}
	worker := newBusyHeartbeatWorker(t, 10*time.Second, 20*time.Millisecond, fake)
	attempt := superviseAttempt(t, worker, "survives-a-failed-round", 1)
	fake.waitForRounds(t, 3, 5*time.Second)
	if cause := attempt.cause(); cause != nil {
		t.Fatalf("a failed round ended the attempt: %v", cause)
	}

	var collected metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &collected); err != nil {
		t.Fatal(err)
	}
	var roundFailures *metricdata.Metrics
	for _, scope := range collected.ScopeMetrics {
		for index, instrument := range scope.Metrics {
			switch instrument.Name {
			case heartbeatRoundFailuresInstrument:
				roundFailures = &scope.Metrics[index]
			case heartbeatFailuresInstrument:
				t.Errorf("a failed round counted an ownership verdict: %+v", instrument.Data)
			}
		}
	}
	if roundFailures == nil {
		t.Fatalf("the worker did not emit %s", heartbeatRoundFailuresInstrument)
	}
	if roundFailures.Unit != "{round}" {
		t.Errorf("%s unit = %q; want {round}", roundFailures.Name, roundFailures.Unit)
	}
	sum, ok := roundFailures.Data.(metricdata.Sum[int64])
	if !ok || len(sum.DataPoints) != 1 {
		t.Fatalf("%s data = %+v; want one data point", roundFailures.Name, roundFailures.Data)
	}
	point := sum.DataPoints[0]
	want := attribute.NewSet(attribute.String("workhorse.heartbeat.failure_reason", "connection"))
	if point.Value != 1 || !point.Attributes.Equals(&want) {
		t.Fatalf("%s point = %d %v; want 1 %v", roundFailures.Name, point.Value, point.Attributes.ToSlice(), want.ToSlice())
	}
}
