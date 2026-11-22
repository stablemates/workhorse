package run.workhorse.testing;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.sdk.metrics.data.LongPointData;
import io.opentelemetry.sdk.metrics.data.MetricData;
import io.opentelemetry.sdk.metrics.data.MetricDataType;
import java.util.Map;
import java.util.TreeMap;

/** The value of {@code workhorse.tasks.cancellation} for each cancellation status. */
public final class CancellationCounts {
  private CancellationCounts() {}

  /**
   * The value of each {@code workhorse.cancellation.status} in {@code recording}. It also checks
   * the kind, the unit, the description, and the only attribute against TypeScript.
   */
  public static Map<String, Long> of(RecordingOpenTelemetry recording) {
    Map<String, Long> counts = new TreeMap<>();
    for (MetricData metric : recording.metrics()) {
      if (!metric.getName().equals("workhorse.tasks.cancellation")) {
        continue;
      }
      assertEquals(MetricDataType.LONG_SUM, metric.getType());
      assertTrue(metric.getLongSumData().isMonotonic());
      assertEquals("{request}", metric.getUnit());
      assertEquals("Task cancellation requests by durable result", metric.getDescription());
      for (LongPointData point : metric.getLongSumData().getPoints()) {
        assertEquals(1, point.getAttributes().size(), point.getAttributes().toString());
        String status =
            point.getAttributes().get(AttributeKey.stringKey("workhorse.cancellation.status"));
        counts.merge(status, point.getValue(), Long::sum);
      }
    }
    return counts;
  }
}
