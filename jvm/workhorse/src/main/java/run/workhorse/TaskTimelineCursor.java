package run.workhorse;

import java.util.UUID;

/**
 * Resumes a timeline page after its last entry.
 *
 * @param taskId the task of the timeline
 * @param occurredAt the time of the last entry, as PostgreSQL's text
 * @param kind the kind of the last entry
 * @param recordId the record of the last entry
 */
public record TaskTimelineCursor(
    UUID taskId, String occurredAt, TaskTimelineKind kind, UUID recordId) {}
