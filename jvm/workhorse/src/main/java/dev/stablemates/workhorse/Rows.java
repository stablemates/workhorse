package dev.stablemates.workhorse;

import dev.stablemates.workhorse.internal.Json;
import dev.stablemates.workhorse.internal.Row;
import dev.stablemates.workhorse.internal.Sql;
import dev.stablemates.workhorse.internal.SqlCatalogue;
import java.sql.Connection;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/** Maps the result rows that {@link Queue} and {@link Admin} both read. */
final class Rows {
  private Rows() {}

  /**
   * One page of at most {@code limit} member tasks after the position {@code after}. The caller
   * validates {@code after} and {@code limit}.
   */
  static TaskGroupMemberPage memberPage(
      Connection connection, UUID groupId, long after, int limit) {
    String group = groupId.toString();
    List<Row> rows =
        Sql.rows(
            connection,
            SqlCatalogue.LIST_TASK_GROUP_MEMBERS_V1,
            group,
            Long.toString(after),
            Integer.toString(limit));
    // A full page can be the last page. The read of one more member tells the two apart.
    boolean more =
        rows.size() == limit
            && !Sql.rows(
                    connection,
                    SqlCatalogue.LIST_TASK_GROUP_MEMBERS_V1,
                    group,
                    Long.toString(rows.get(rows.size() - 1).requiredLong("position")),
                    "1")
                .isEmpty();
    List<TaskGroupMember> members = new ArrayList<>();
    for (Row row : rows) {
      String state = row.text("state");
      String outcome = row.text("outcome");
      members.add(
          new TaskGroupMember(
              row.requiredLong("position"),
              row.requiredUuid("task_id"),
              row.text("queue_name"),
              row.text("task_type"),
              state == null ? null : constant(TaskState.class, "task_group_member_state", state),
              outcome == null
                  ? null
                  : constant(TaskGroupMemberOutcome.class, "task_group_member_outcome", outcome),
              row.requiredInstant("added_at"),
              row.instant("counted_at")));
    }
    return new TaskGroupMemberPage(
        members, more ? members.get(members.size() - 1).position() : null);
  }

  static TaskGroup group(Row row) {
    Map<String, @Nullable Object> callbacks = Json.object(row.json("callbacks"));
    List<TaskGroupCallback> list = new ArrayList<>();
    if (callbacks != null) {
      for (TaskGroupCallbackKind kind : TaskGroupCallbackKind.values()) {
        String name = kind.name().toLowerCase(Locale.ROOT);
        if (callbacks.containsKey(name)) {
          Map<String, @Nullable Object> entry = Json.object(callbacks.get(name));
          Object taskId = entry == null ? null : entry.get("taskId");
          list.add(
              new TaskGroupCallback(
                  kind, taskId instanceof String text ? UUID.fromString(text) : null));
        }
      }
    }
    String result = row.text("result");
    return new TaskGroup(
        row.requiredUuid("group_id"),
        constant(TaskGroupState.class, "task_group_state", row.requiredText("state")),
        result == null ? null : constant(TaskGroupResult.class, "task_group_result", result),
        new TaskGroupCounts(
            row.requiredLong("total"),
            row.requiredLong("succeeded"),
            row.requiredLong("failed"),
            row.requiredLong("canceled"),
            row.requiredLong("pending")),
        row.requiredInstant("created_at"),
        row.instant("sealed_at"),
        row.instant("finished_at"),
        row.instant("canceled_at"),
        row.text("canceled_by"),
        row.text("cancel_reason"),
        list);
  }

  static <E extends Enum<E>> E constant(Class<E> type, String operation, @Nullable String text) {
    E value = text == null ? null : optionalConstant(type, text);
    if (value == null) {
      throw new UnexpectedStatusException(operation, text);
    }
    return value;
  }

  static <E extends Enum<E>> @Nullable E optionalConstant(Class<E> type, String text) {
    if (!text.equals(text.toLowerCase(Locale.ROOT))) {
      return null;
    }
    try {
      return Enum.valueOf(type, text.toUpperCase(Locale.ROOT));
    } catch (IllegalArgumentException unknown) {
      return null;
    }
  }

  static Row exactlyOne(List<Row> rows, String function) {
    if (rows.size() != 1) {
      throw new WorkhorseException(
          "workhorse." + function + " returned " + rows.size() + " rows; expected one");
    }
    return rows.get(0);
  }
}
