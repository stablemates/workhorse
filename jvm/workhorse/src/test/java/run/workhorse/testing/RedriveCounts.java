package run.workhorse.testing;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.sdk.metrics.data.LongPointData;
import io.opentelemetry.sdk.metrics.data.MetricData;
import io.opentelemetry.sdk.metrics.data.MetricDataType;
import java.util.Map;
import java.util.TreeMap;

/** The value of {@code workhorse.tasks.redrive} for each redrive status. */
public final class RedriveCounts {
  private RedriveCounts() {}

  /**
   * The value of each {@code workhorse.redrive.status} in {@code recording}. It also checks the
   * kind, the unit, the description, and the only attribute against TypeScript.
   */
  public static Map<String, Long> of(RecordingOpenTelemetry recording) {
    Map<String, Long> counts = new TreeMap<>();
    for (MetricData metric : recording.metrics()) {
      if (!metric.getName().equals("workhorse.tasks.redrive")) {
        continue;
      }
      assertEquals(MetricDataType.LONG_SUM, metric.getType());
      assertTrue(metric.getLongSumData().isMonotonic());
      assertEquals("{request}", metric.getUnit());
      assertEquals("Task redrive requests by durable result", metric.getDescription());
      for (LongPointData point : metric.getLongSumData().getPoints()) {
        assertEquals(1, point.getAttributes().size(), point.getAttributes().toString());
        String status =
            point.getAttributes().get(AttributeKey.stringKey("workhorse.redrive.status"));
        counts.merge(status, point.getValue(), Long::sum);
      }
    }
    return counts;
  }
}
