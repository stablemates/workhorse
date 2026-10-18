package run.workhorse;

import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * One version of a task type's payload and result contract. A schema is a Draft 2020-12 JSON Schema
 * inside the Workhorse contract profile (ADR 0039), as a JSON value: a {@code Map} or a {@code
 * Boolean}. {@code true} accepts anything. A byte limit of {@code null} or 0 uses the protocol
 * default.
 *
 * @param payloadSchema the payload schema
 * @param resultSchema the result schema
 * @param maxPayloadBytes the payload limit, or {@code null}
 * @param maxResultBytes the result limit, or {@code null}
 * @param sensitivePayloadKeys the top-level payload keys that reads redact
 * @param sensitiveResultKeys the top-level result keys that reads redact
 */
public record TaskContractVersion(
    Object payloadSchema,
    Object resultSchema,
    @Nullable Long maxPayloadBytes,
    @Nullable Long maxResultBytes,
    List<String> sensitivePayloadKeys,
    List<String> sensitiveResultKeys) {
  /** Copies the key lists. */
  public TaskContractVersion {
    sensitivePayloadKeys = List.copyOf(sensitivePayloadKeys);
    sensitiveResultKeys = List.copyOf(sensitiveResultKeys);
  }

  /** A version that accepts any payload and any result. */
  public TaskContractVersion() {
    this(true, true);
  }

  /** A version with two schemas and the default limits. */
  public TaskContractVersion(Object payloadSchema, Object resultSchema) {
    this(payloadSchema, resultSchema, null, null, List.of(), List.of());
  }
}
