package run.workhorse;

import java.util.UUID;

/**
 * Resumes a signal wait page or a human wait page after its last wait.
 *
 * @param createdAt the creation time of the last wait, as PostgreSQL's text
 * @param taskId the task of the last wait
 * @param name the name of the last wait
 */
public record ExternalWaitCursor(String createdAt, UUID taskId, String name) {}
