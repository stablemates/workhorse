package run.workhorse.examples.programs;

import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.logs.LogRecordBuilder;
import io.opentelemetry.api.logs.Logger;
import io.opentelemetry.api.logs.LoggerBuilder;
import io.opentelemetry.api.logs.LoggerProvider;
import io.opentelemetry.api.logs.Severity;
import io.opentelemetry.api.trace.TracerProvider;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.propagation.ContextPropagators;
import java.io.IOException;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.logging.Handler;
import java.util.logging.Level;
import java.util.logging.LogRecord;
import org.jspecify.annotations.Nullable;

/**
 * Writes demo log records as NDJSON, in the format of {@code
 * typescript/demo/file-log-exporter.cjs}.
 *
 * <p>The file rotates before a record would take it past the byte limit, and keeps the configured
 * count of numbered archives. A write that fails reports once to standard error and never reaches
 * the worker.
 *
 * <p>The SDK writes each event of the cross-language set to the OpenTelemetry logs API with its
 * attributes, and every event to {@code System.Logger} as text. {@link #openTelemetry} gives the
 * worker a logs bridge that writes the structured records. {@link #julHandler} writes the other
 * {@code java.util.logging} records, such as the Java-only events and the HikariCP log, and skips
 * an event that the logs bridge already wrote.
 */
final class DemoLogFile {
  static final long DEFAULT_MAX_BYTES = 10L * 1024 * 1024;
  static final int DEFAULT_ARCHIVES = 5;
  private static final String EVENT_MARKER = " {event.name=";
  private static final DateTimeFormatter TIMESTAMP =
      DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

  private final Path path;
  private final long maxBytes;
  private final int archives;
  private final Map<String, Object> resource;
  private final Set<String> bridgedEvents = ConcurrentHashMap.newKeySet();
  private boolean failed;

  DemoLogFile(Path path, long maxBytes, int archives, Map<String, Object> resource) {
    this.path = path;
    this.maxBytes = maxBytes;
    this.archives = archives;
    this.resource = Map.copyOf(resource);
  }

  Path path() {
    return path;
  }

  static String safePathSegment(String value) {
    String safe = value.replaceAll("[^a-zA-Z0-9._-]", "_");
    if (safe.length() > 100) {
      safe = safe.substring(0, 100);
    }
    return safe.isEmpty() ? "unknown" : safe;
  }

  static long positiveInteger(Map<String, String> environment, String name, long fallback) {
    String value = environment.get(name);
    if (value == null) {
      return fallback;
    }
    try {
      long parsed = Long.parseLong(value);
      if (parsed >= 1) {
        return parsed;
      }
    } catch (NumberFormatException ignored) {
      // The message below names the variable.
    }
    throw new IllegalArgumentException(name + " must be a positive integer");
  }

  /** The log file of this worker, or empty when the launcher names no directory or service. */
  static Optional<DemoLogFile> fromEnvironment(Map<String, String> environment) {
    String directory = environment.getOrDefault("WORKHORSE_DEMO_LOG_DIRECTORY", "");
    String service = environment.getOrDefault("WORKHORSE_DEMO_SERVICE_NAME", "");
    if (directory.isEmpty() || service.isEmpty()) {
      return Optional.empty();
    }
    String deployment = environment.getOrDefault("WORKHORSE_DEMO_ENV", "");
    if (deployment.isEmpty()) {
      deployment = "development";
    }
    long maxBytes = positiveInteger(environment, "WORKHORSE_DEMO_LOG_MAX_BYTES", DEFAULT_MAX_BYTES);
    long archives = positiveInteger(environment, "WORKHORSE_DEMO_LOG_ARCHIVES", DEFAULT_ARCHIVES);
    Map<String, Object> resource = new LinkedHashMap<>();
    resource.put("service.name", service);
    resource.put("deployment.environment.name", deployment);
    resource.put("deployment.environment", deployment);
    resource.put("host.name", hostName());
    resource.put("process.pid", ProcessHandle.current().pid());
    resource.put("telemetry.sdk.language", "java");
    Path path =
        Path.of(directory)
            .toAbsolutePath()
            .resolve(safePathSegment(deployment))
            .resolve(safePathSegment(service) + ".ndjson");
    return Optional.of(
        new DemoLogFile(path, maxBytes, (int) Math.min(archives, Integer.MAX_VALUE), resource));
  }

  private static String hostName() {
    try {
      return InetAddress.getLocalHost().getHostName();
    } catch (UnknownHostException error) {
      return "unknown-host";
    }
  }

  static String timestamp(Instant moment) {
    return TIMESTAMP.format(moment);
  }

  void write(
      String severityText,
      int severityNumber,
      @Nullable String eventName,
      String body,
      Map<String, ?> attributes,
      String scope,
      Instant time) {
    StringBuilder line = new StringBuilder(256).append('{');
    field(line, "timestamp", timestamp(time));
    field(line, "observedTimestamp", timestamp(Instant.now()));
    field(line, "severityText", severityText);
    field(line, "severityNumber", severityNumber);
    if (eventName != null) {
      field(line, "eventName", eventName);
    }
    field(line, "body", body);
    field(line, "attributes", attributes);
    field(line, "resource", resource);
    line.append("\"scope\":");
    json(line, Map.of("name", scope));
    line.append("}\n");
    byte[] bytes = line.toString().getBytes(StandardCharsets.UTF_8);
    synchronized (this) {
      try {
        append(bytes);
      } catch (IOException | RuntimeException error) {
        if (!failed) {
          failed = true;
          System.err.println("Could not write the demo log file " + path + ": " + error);
        }
      }
    }
  }

  private void append(byte[] line) throws IOException {
    Path parent = path.getParent();
    if (parent != null) {
      Files.createDirectories(parent);
    }
    long size = Files.exists(path) ? Files.size(path) : 0;
    if (size > 0 && size + line.length > maxBytes) {
      rotate();
    }
    Files.write(path, line, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
  }

  private Path archive(int index) {
    return path.resolveSibling(path.getFileName() + "." + index);
  }

  private void rotate() throws IOException {
    Files.deleteIfExists(archive(archives));
    for (int index = archives - 1; index >= 1; index--) {
      try {
        Files.move(archive(index), archive(index + 1));
      } catch (NoSuchFileException ignored) {
        // A missing archive leaves nothing to move.
      }
    }
    Files.move(path, archive(1));
  }

  private static void field(StringBuilder line, String key, @Nullable Object value) {
    json(line, key);
    line.append(':');
    json(line, value);
    line.append(',');
  }

  private static void json(StringBuilder line, @Nullable Object value) {
    if (value == null) {
      line.append("null");
    } else if (value instanceof Boolean || value instanceof Integer || value instanceof Long) {
      line.append(value);
    } else if (value instanceof Double number) {
      line.append(Double.isFinite(number) ? number.toString() : "null");
    } else if (value instanceof Map<?, ?> map) {
      line.append('{');
      boolean first = true;
      for (Map.Entry<?, ?> entry : map.entrySet()) {
        if (!first) {
          line.append(',');
        }
        first = false;
        json(line, String.valueOf(entry.getKey()));
        line.append(':');
        json(line, entry.getValue());
      }
      line.append('}');
    } else if (value instanceof List<?> list) {
      line.append('[');
      for (int index = 0; index < list.size(); index++) {
        if (index > 0) {
          line.append(',');
        }
        json(line, list.get(index));
      }
      line.append(']');
    } else {
      String text = value.toString();
      line.append('"');
      for (int index = 0; index < text.length(); index++) {
        char character = text.charAt(index);
        switch (character) {
          case '"' -> line.append("\\\"");
          case '\\' -> line.append("\\\\");
          case '\n' -> line.append("\\n");
          case '\r' -> line.append("\\r");
          case '\t' -> line.append("\\t");
          default -> {
            if (character < 0x20) {
              line.append(String.format("\\u%04x", (int) character));
            } else {
              line.append(character);
            }
          }
        }
      }
      line.append('"');
    }
  }

  /**
   * An OpenTelemetry instance whose logs bridge writes this file. Traces and metrics do nothing.
   */
  OpenTelemetry openTelemetry() {
    LoggerProvider provider = name -> new Builder(name);
    return new OpenTelemetry() {
      @Override
      public TracerProvider getTracerProvider() {
        return TracerProvider.noop();
      }

      @Override
      public LoggerProvider getLogsBridge() {
        return provider;
      }

      @Override
      public ContextPropagators getPropagators() {
        return ContextPropagators.noop();
      }
    };
  }

  /** A {@code java.util.logging} handler that writes the records the logs bridge did not write. */
  Handler julHandler() {
    return new Handler() {
      @Override
      public void publish(LogRecord record) {
        String message = record.getMessage() == null ? "" : record.getMessage();
        if (record.getParameters() != null && record.getParameters().length > 0) {
          message = java.text.MessageFormat.format(message, record.getParameters());
        }
        String eventName = null;
        String body = message;
        int marker = message.indexOf(EVENT_MARKER);
        if (marker >= 0) {
          int start = marker + EVENT_MARKER.length();
          int end = message.indexOf(',', start);
          int close = message.indexOf('}', start);
          if (end < 0 || (close >= 0 && close < end)) {
            end = close;
          }
          if (end > start) {
            eventName = message.substring(start, end);
            if (bridgedEvents.contains(eventName)) {
              return;
            }
          }
        }
        Map<String, Object> attributes = new LinkedHashMap<>();
        Throwable thrown = record.getThrown();
        if (thrown != null) {
          attributes.put("exception.type", thrown.getClass().getName());
          attributes.put("exception.message", String.valueOf(thrown.getMessage()));
        }
        int level = record.getLevel().intValue();
        String text;
        int number;
        if (level >= Level.SEVERE.intValue()) {
          text = "ERROR";
          number = 17;
        } else if (level >= Level.WARNING.intValue()) {
          text = "WARN";
          number = 13;
        } else if (level >= Level.INFO.intValue()) {
          text = "INFO";
          number = 9;
        } else {
          text = "DEBUG";
          number = 5;
        }
        String scope = record.getLoggerName() == null ? "" : record.getLoggerName();
        write(text, number, eventName, body, attributes, scope, record.getInstant());
      }

      @Override
      public void flush() {}

      @Override
      public void close() {}
    };
  }

  private final class Builder implements LoggerBuilder {
    private final String name;

    Builder(String name) {
      this.name = name;
    }

    @Override
    public LoggerBuilder setSchemaUrl(String schemaUrl) {
      return this;
    }

    @Override
    public LoggerBuilder setInstrumentationVersion(String version) {
      return this;
    }

    @Override
    public Logger build() {
      return () -> new BridgedRecord(name);
    }
  }

  private final class BridgedRecord implements LogRecordBuilder {
    private final String scope;
    private final Map<String, Object> attributes = new LinkedHashMap<>();
    private @Nullable Instant time;
    private @Nullable Severity severity;
    private @Nullable String severityText;
    private @Nullable String eventName;
    private String body = "";

    BridgedRecord(String scope) {
      this.scope = scope;
    }

    @Override
    public LogRecordBuilder setTimestamp(long timestamp, TimeUnit unit) {
      time = Instant.EPOCH.plusNanos(unit.toNanos(timestamp));
      return this;
    }

    @Override
    public LogRecordBuilder setTimestamp(Instant instant) {
      time = instant;
      return this;
    }

    @Override
    public LogRecordBuilder setObservedTimestamp(long timestamp, TimeUnit unit) {
      return this;
    }

    @Override
    public LogRecordBuilder setObservedTimestamp(Instant instant) {
      return this;
    }

    @Override
    public LogRecordBuilder setContext(Context context) {
      return this;
    }

    @Override
    public LogRecordBuilder setSeverity(Severity value) {
      severity = value;
      return this;
    }

    @Override
    public LogRecordBuilder setSeverityText(String value) {
      severityText = value;
      return this;
    }

    @Override
    public LogRecordBuilder setBody(String value) {
      body = value;
      return this;
    }

    @Override
    public LogRecordBuilder setEventName(String value) {
      eventName = value;
      return this;
    }

    @Override
    public <T> LogRecordBuilder setAttribute(AttributeKey<T> key, @Nullable T value) {
      if (value != null) {
        attributes.put(key.getKey(), value);
      }
      return this;
    }

    @Override
    public void emit() {
      String name = eventName;
      if (name != null) {
        bridgedEvents.add(name);
      }
      Severity level = severity == null ? Severity.INFO : severity;
      String text = severityText == null ? level.name() : severityText;
      Instant moment = time == null ? Instant.now() : time;
      write(text, level.getSeverityNumber(), name, body, attributes, scope, moment);
    }
  }
}
