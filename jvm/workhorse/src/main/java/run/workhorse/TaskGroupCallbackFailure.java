package run.workhorse;

import java.time.Instant;

/**
 * Why a finished group did not enqueue a callback. The enqueue at the finish failed, for example
 * because an operator moved the callback queue to the fast tier and the request has a concurrency
 * key. Workhorse does not try the callback again. Retention deletes this record with the group.
 *
 * @param code the SQLSTATE of the enqueue error
 * @param message the message of the enqueue error
 * @param failedAt the time of the failure
 */
public record TaskGroupCallbackFailure(String code, String message, Instant failedAt) {}
