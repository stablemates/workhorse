package dev.stablemates.workhorse;

import java.util.UUID;

/**
 * Resumes a task page after its last task. The text fields are PostgreSQL's text, passed back as
 * they are.
 *
 * @param createdAt the creation time of the last task, as PostgreSQL's text
 * @param taskId the last task
 * @param signature PostgreSQL's signature of the filter that made the page
 */
public record TaskListCursor(String createdAt, UUID taskId, String signature) {}
