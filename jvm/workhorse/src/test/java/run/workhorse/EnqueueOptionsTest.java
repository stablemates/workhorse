package run.workhorse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;

/** The options records copy a caller's retry policy (SM-1525). */
class EnqueueOptionsTest {
  private static Map<String, @Nullable Object> policy() {
    Map<String, @Nullable Object> policy = new HashMap<>();
    policy.put("type", "fixed");
    policy.put("delayMs", 1000L);
    policy.put("nested", new ArrayList<>(List.of(new HashMap<>(Map.of("a", 1L)))));
    return policy;
  }

  @SuppressWarnings("unchecked")
  private static void change(Map<String, @Nullable Object> policy) {
    policy.put("delayMs", 2000L);
    List<Object> nested = (List<Object>) policy.get("nested");
    ((Map<String, Object>) nested.get(0)).put("a", 2L);
    nested.add("more");
  }

  @Test
  void enqueueOptionsKeepTheRetryPolicyOfTheBuild() {
    Map<String, @Nullable Object> policy = policy();
    EnqueueOptions options = EnqueueOptions.builder().retryPolicy(policy).build();
    Map<String, @Nullable Object> expected = policy();
    change(policy);
    assertEquals(expected, options.retryPolicy());
    assertEquals(expected, options.toBuilder().build().retryPolicy());
    assertThrows(UnsupportedOperationException.class, () -> options.retryPolicy().clear());
  }

  @Test
  void aScheduledTaskKeepsTheRetryPolicyOfItsConstruction() {
    Map<String, @Nullable Object> policy = policy();
    ScheduledTask task = new ScheduledTask("report", null, null, 0, null, null, policy);
    Map<String, @Nullable Object> expected = policy();
    change(policy);
    assertEquals(expected, task.retryPolicy());
    assertThrows(UnsupportedOperationException.class, () -> task.retryPolicy().clear());
  }

  @Test
  void aNullRetryPolicyStaysNull() {
    assertEquals(null, EnqueueOptions.defaults().retryPolicy());
    assertEquals(null, ScheduledTask.of("report", null).retryPolicy());
  }
}
