package run.workhorse;

import java.util.UUID;

/**
 * Resumes a dead-letter page or a bulk redrive after its last source task.
 *
 * @param finishedAt the finish time of the last source task, as PostgreSQL's text
 * @param taskId the last source task
 */
public record DeadLetterCursor(String finishedAt, UUID taskId) {}
