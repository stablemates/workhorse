package run.workhorse;

/**
 * Who asks for an operator control, why, and the request ID that makes a retry idempotent.
 * PostgreSQL records the audit with the control.
 *
 * <p>{@link Admin} rejects a blank field before it calls PostgreSQL.
 *
 * @param actor who asks, 1 to 200 characters
 * @param reason why, 1 to 2,000 characters
 * @param requestId the idempotency key of the control, 1 to 512 UTF-8 bytes
 */
public record AdminAudit(String actor, String reason, String requestId) {}
