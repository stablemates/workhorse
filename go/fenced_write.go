package workhorse

import "context"

// fencedWriteDeadlockAttempts bounds how often a fenced write is sent after PostgreSQL chose it as a
// deadlock victim.
//
// Settling a task resolves its dependents inside the same statement, and the resolver locks each
// level of that cascade only when it reaches it. Two settlements whose cascades meet at different
// levels can therefore wait on each other, and PostgreSQL then raises 40P01 in one of them.
const fencedWriteDeadlockAttempts = 3

// queryFencedWrite sends a fenced write and sends it again when PostgreSQL chose it as a deadlock
// victim.
//
// PostgreSQL rolls back the whole statement, so nothing in it committed, and the fence decides
// again whether a resend may still act. A caller-owned transaction is aborted by the deadlock, so a
// resend there fails with 25P02, and the caller gets the original deadlock instead.
func queryFencedWrite(
	ctx context.Context,
	executor Executor,
	statement string,
	arguments ...any,
) ([]Row, error) {
	var deadlock error
	for attempt := 1; ; attempt++ {
		rows, err := executor.Query(ctx, statement, arguments...)
		if err == nil {
			return rows, nil
		}
		if deadlock != nil && hasSQLState(err, inFailedSQLTransactionSQLState) {
			return nil, deadlock
		}
		if attempt >= fencedWriteDeadlockAttempts || !hasSQLState(err, deadlockDetectedSQLState) {
			return nil, err
		}
		deadlock = err
	}
}
