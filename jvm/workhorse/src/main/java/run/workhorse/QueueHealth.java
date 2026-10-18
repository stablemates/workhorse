package run.workhorse;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * PostgreSQL's queue health snapshot over the last day.
 *
 * <p>The snapshot keeps the keys that {@code queue_health_v1} returns, as Ruby returns them. A
 * schema migration can add a key, so the record holds one map and not one component for each key
 * (ADR 0103, amendment of 2026-10-17).
 *
 * @param snapshot the snapshot, decoded with the JSON types of the default codec
 */
public record QueueHealth(Map<String, @Nullable Object> snapshot) {
  /** Copies the snapshot in its iteration order. */
  public QueueHealth {
    snapshot = Collections.unmodifiableMap(new LinkedHashMap<>(snapshot));
  }
}
