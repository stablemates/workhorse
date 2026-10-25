package workhorse

import (
	"context"
	"errors"
	"io"
	"net"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// heartbeatRoundFailureReason returns the category of a heartbeat round that failed before
// PostgreSQL gave a verdict. deadlineReached tells whether the round deadline had passed when the
// round returned. Every SDK uses the same rule, in this order:
//
//   - timeout: the round deadline (errHeartbeatRoundExpired, or context.DeadlineExceeded after the
//     round deadline; pgx wraps the context error when the round context ends a socket read),
//     statement_timeout (57014), or idle_in_transaction_session_timeout (25P03).
//   - connection: the round did not reach PostgreSQL or lost its connection. This is a SQLSTATE
//     that starts with 08, a server shutdown (57P01 to 57P03), a closed pgx connection
//     (pgconn.ErrConnClosed), a net.Error, or an end of stream (io.EOF, io.ErrUnexpectedEOF).
//   - database: any other SQLSTATE. A server error during connection startup, such as 28P01, is
//     database, also when pgx wraps it in a pgconn.ConnectError.
//   - connection, without a SQLSTATE: a pgconn.ConnectError, or a context.DeadlineExceeded before
//     the round deadline, such as a pgx connect timeout.
//   - other: everything else.
func heartbeatRoundFailureReason(err error, deadlineReached bool) string {
	var sqlState string
	var carrier sqlStateCarrier
	if errors.As(err, &carrier) {
		sqlState = carrier.SQLState()
	}
	contextDeadline := errors.Is(err, context.DeadlineExceeded)
	switch {
	case errors.Is(err, errHeartbeatRoundExpired),
		contextDeadline && deadlineReached,
		sqlState == queryCanceledSQLState,
		sqlState == idleInTransactionTimeoutSQLState:
		return heartbeatRoundFailureTimeout
	case strings.HasPrefix(sqlState, connectionExceptionSQLStateClass),
		sqlState == adminShutdownSQLState,
		sqlState == crashShutdownSQLState,
		sqlState == cannotConnectNowSQLState:
		return heartbeatRoundFailureConnection
	}
	switch {
	case errors.Is(err, pgconn.ErrConnClosed),
		hasNetworkError(err),
		errors.Is(err, io.EOF),
		errors.Is(err, io.ErrUnexpectedEOF):
		return heartbeatRoundFailureConnection
	case sqlState != emptyString:
		return heartbeatRoundFailureDatabase
	}
	var connectError *pgconn.ConnectError
	if contextDeadline || errors.As(err, &connectError) {
		return heartbeatRoundFailureConnection
	}
	return heartbeatRoundFailureOther
}

// hasNetworkError reports whether a node of the error tree of err is a net.Error other than
// context.DeadlineExceeded. The context error also implements net.Error, but it is a deadline, not a
// socket failure, so the deadline rules classify it. errors.As cannot skip it, so the function walks
// the tree.
func hasNetworkError(err error) bool {
	if err == nil {
		return false
	}
	if _, ok := err.(net.Error); ok && err != context.DeadlineExceeded {
		return true
	}
	switch tree := err.(type) {
	case interface{ Unwrap() []error }:
		return slices.ContainsFunc(tree.Unwrap(), hasNetworkError)
	case interface{ Unwrap() error }:
		return hasNetworkError(tree.Unwrap())
	}
	return false
}

// recordHeartbeatRoundFailure counts one heartbeat round that failed before PostgreSQL returned a
// status for its leases. The round gives no ownership verdict, so workhorse.worker.heartbeat.failure
// does not count it. One loop sends one round at a time, so the rate stays bounded by the heartbeat
// interval and its busy retries.
func (worker *Worker) recordHeartbeatRoundFailure(ctx context.Context, err error, deadlineReached bool) {
	if worker.metrics.enabled {
		worker.metrics.heartbeatRoundFailures.Add(
			ctx, 1,
			metric.WithAttributes(
				attribute.String(heartbeatReasonAttribute, heartbeatRoundFailureReason(err, deadlineReached)),
			),
		)
	}
}
