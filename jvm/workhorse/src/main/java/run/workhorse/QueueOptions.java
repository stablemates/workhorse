package run.workhorse;

/**
 * The options of a {@link Queue}.
 *
 * @param defaultQueue the queue of a request that names none, {@code "default"} by default
 * @param codec the codec of payloads and results, {@link JsonCodec#standard()} by default
 * @param telemetry the OpenTelemetry instance that the queue reports to, {@code
 *     GlobalOpenTelemetry} by default
 */
public record QueueOptions(String defaultQueue, JsonCodec codec, WorkhorseTelemetry telemetry) {
  /**
   * Checks the default queue.
   *
   * @throws IllegalArgumentException if the default queue is empty
   */
  public QueueOptions {
    if (defaultQueue.isEmpty()) {
      throw new IllegalArgumentException("default queue must be a non-empty String");
    }
  }

  /** The options with every default. */
  public static QueueOptions defaults() {
    return builder().build();
  }

  /** A builder with every default. */
  public static Builder builder() {
    return new Builder();
  }

  /** Builds {@link QueueOptions}. */
  public static final class Builder {
    private String defaultQueue = "default";
    private JsonCodec codec = JsonCodec.standard();
    private WorkhorseTelemetry telemetry = WorkhorseTelemetry.global();

    private Builder() {}

    /** Sets the default queue. */
    public Builder defaultQueue(String defaultQueue) {
      this.defaultQueue = defaultQueue;
      return this;
    }

    /** Sets the codec. */
    public Builder codec(JsonCodec codec) {
      this.codec = codec;
      return this;
    }

    /** Sets the OpenTelemetry instance that the queue reports to. */
    public Builder telemetry(WorkhorseTelemetry telemetry) {
      this.telemetry = telemetry;
      return this;
    }

    /** The options. */
    public QueueOptions build() {
      return new QueueOptions(defaultQueue, codec, telemetry);
    }
  }
}
