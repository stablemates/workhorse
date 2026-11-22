package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.testing.RecordingOpenTelemetry;
import run.workhorse.testing.RedriveCounts;
import run.workhorse.testing.ScratchDataSource;
import run.workhorse.testing.ScratchDatabase;

/**
 * The count of each {@code redrive_v1} and {@code redrive_many_v1} result in {@code
 * workhorse.tasks.redrive}, as the TypeScript admin records it. The dashboard calls the admin, so
 * it counts the same result.
 */
@ExtendWith(ScratchDatabase.class)
class AdminTelemetryDatabaseTest {
  /**
   * {@code redrive_many_v1} answers two rows of a known status and one of a status of a newer
   * protocol, and {@code redrive_v1} answers a status of a newer protocol. Only a failed task gives
   * real rows. Each test replaces the functions in its own transaction and rolls it back.
   */
  private static final String SCRIPTED_REDRIVE_FUNCTIONS =
      """
      CREATE OR REPLACE FUNCTION workhorse.redrive_many_v1(
        p_filter jsonb, p_limit integer, p_dry_run boolean, p_requested_by text, p_reason text,
        p_request_id text, p_cursor_finished_at timestamptz DEFAULT NULL,
        p_cursor_task_id uuid DEFAULT NULL
      ) RETURNS TABLE (
        ordinal integer, status text, source_task_id uuid, target_task_id uuid, source_state text,
        target_state text, requested_at timestamptz, source_finished_at_cursor text,
        has_more boolean
      ) LANGUAGE sql AS $body$
        SELECT row.ordinal, row.status, gen_random_uuid(), NULL::uuid, NULL::text, NULL::text,
               NULL::timestamptz, NULL::text, false
        FROM (VALUES (1, 'redriven'), (2, 'future_status'), (3, 'redriven')) AS row(ordinal, status)
      $body$;
      CREATE OR REPLACE FUNCTION workhorse.redrive_v1(
        p_source_task_id uuid, p_requested_by text, p_reason text, p_request_id text
      ) RETURNS TABLE (
        status text, source_task_id uuid, target_task_id uuid, source_state text,
        target_state text, requested_at timestamptz
      ) LANGUAGE sql AS $body$
        SELECT 'future_status'::text, p_source_task_id, NULL::uuid, NULL::text, NULL::text,
               NULL::timestamptz
      $body$;
      """;

  private final ConnectionSource source = ConnectionSource.of(new ScratchDataSource(true));
  private final RecordingOpenTelemetry recording = new RecordingOpenTelemetry();
  private final Admin admin = new Admin(source, WorkhorseTelemetry.of(recording.sdk()));
  private final String queueName = "redrive-metric-" + UUID.randomUUID();

  @AfterEach
  void close() {
    recording.close();
  }

  private static AdminAudit audit() {
    return new AdminAudit("operator", "redrive metric", UUID.randomUUID().toString());
  }

  @Test
  void countsEachRedriveResultByItsDurableStatus() {
    UUID taskId =
        new Queue(source)
            .enqueue("email.send", Map.of(), EnqueueOptions.builder().queue(queueName).build())
            .taskId();
    assertEquals(RedriveStatus.NOT_FOUND, admin.redrive(UUID.randomUUID(), audit()).status());
    assertEquals(RedriveStatus.NOT_FAILED, admin.redrive(taskId, audit()).status());
    // A page without a failed task counts nothing.
    assertTrue(
        admin
            .redriveMany(RedriveFilter.builder().queue(queueName).build(), audit())
            .results()
            .isEmpty());

    assertEquals(Map.of("not_failed", 1L, "not_found", 1L), RedriveCounts.of(recording));
  }

  /**
   * As TypeScript does, the bulk redrive counts each status once with the number of its rows, and a
   * dry run counts its rows too. The count takes the raw status before the admin rejects the
   * result, so a status of a newer protocol is also counted. Before, the JVM admin counted nothing.
   */
  @Test
  void countsEachStatusOfAPageAndAStatusOfANewerProtocol() throws SQLException {
    try (Connection connection = ScratchDatabase.connect()) {
      connection.setAutoCommit(false);
      try (Statement statement = connection.createStatement()) {
        statement.execute(SCRIPTED_REDRIVE_FUNCTIONS);
      }
      try {
        RedriveFilter filter = RedriveFilter.builder().queue(queueName).dryRun(true).build();
        assertThrows(
            UnexpectedStatusException.class, () -> admin.redriveMany(connection, filter, audit()));
        assertThrows(
            UnexpectedStatusException.class,
            () -> admin.redrive(connection, UUID.randomUUID(), audit()));
      } finally {
        connection.rollback();
      }
    }

    assertEquals(Map.of("future_status", 2L, "redriven", 2L), RedriveCounts.of(recording));
  }
}
