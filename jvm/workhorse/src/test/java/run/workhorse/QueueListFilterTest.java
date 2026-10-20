package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertFalse;

import java.lang.reflect.AnnotatedType;
import java.sql.Connection;
import java.util.List;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/**
 * SM-1523: the name filter of each policy and budget list is non-null. A nullable filter beside the
 * {@code Connection} overload made {@code queue.listBudgets(null)} ambiguous, so it could not take
 * {@code null}. An empty list, or the overload without a filter, reads every row.
 */
class QueueListFilterTest {
  @ParameterizedTest
  @ValueSource(strings = {"listBudgets", "listConcurrencyPolicies", "listRateLimitPolicies"})
  void theNameFilterIsNonNull(String name) throws NoSuchMethodException {
    AnnotatedType source = Queue.class.getMethod(name, List.class).getAnnotatedParameterTypes()[0];
    AnnotatedType caller =
        Queue.class.getMethod(name, Connection.class, List.class).getAnnotatedParameterTypes()[1];
    assertFalse(source.isAnnotationPresent(Nullable.class), name + "(List)");
    assertFalse(caller.isAnnotationPresent(Nullable.class), name + "(Connection, List)");
  }
}
