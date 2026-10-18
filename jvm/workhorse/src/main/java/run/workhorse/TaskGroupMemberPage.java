package run.workhorse;

import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * One page of member tasks.
 *
 * @param members the member tasks of the page
 * @param nextAfter the position to pass as {@code after} for the next page, or {@code null} on the
 *     last page
 */
public record TaskGroupMemberPage(List<TaskGroupMember> members, @Nullable Long nextAfter) {
  /** Copies the members. */
  public TaskGroupMemberPage {
    members = List.copyOf(members);
  }
}
