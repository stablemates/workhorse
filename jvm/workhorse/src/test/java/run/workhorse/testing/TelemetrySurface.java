package run.workhorse.testing;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The governed telemetry names of {@code api/telemetry.txt}: each instrument with its kind, unit,
 * and description, each span name, and each attribute name.
 */
public record TelemetrySurface(
    Map<String, Instrument> instruments, List<String> spans, List<String> attributes) {
  /** One instrument line. */
  public record Instrument(String kind, String unit, String description) {}

  /** The names of {@code api/telemetry.txt} in this checkout. */
  public static TelemetrySurface read() {
    Path file =
        Path.of(System.getProperty("workhorse.schema"))
            .getParent()
            .getParent()
            .getParent()
            .resolve("api/telemetry.txt");
    List<String> lines;
    try {
      lines = Files.readAllLines(file);
    } catch (IOException error) {
      throw new UncheckedIOException(error);
    }
    Map<String, Instrument> instruments = new LinkedHashMap<>();
    List<String> spans = new ArrayList<>();
    List<String> attributes = new ArrayList<>();
    String section = "";
    for (String line : lines) {
      if (line.startsWith("## ")) {
        section = line.substring(3).trim();
        continue;
      }
      if (line.isBlank() || line.startsWith("#")) {
        continue;
      }
      switch (section) {
        case "Instruments" -> {
          String[] fields = line.trim().split("\\s+", 4);
          instruments.put(fields[0], new Instrument(fields[1], fields[2], fields[3]));
        }
        case "Spans" -> spans.add(line.trim());
        case "Attributes" -> attributes.add(line.trim());
        default -> throw new IllegalStateException("a name outside a section: " + line);
      }
    }
    return new TelemetrySurface(
        Map.copyOf(instruments), List.copyOf(spans), List.copyOf(attributes));
  }

  /** Every name in the file. */
  public List<String> names() {
    List<String> names = new ArrayList<>(instruments.keySet());
    names.addAll(spans);
    names.addAll(attributes);
    return names;
  }
}
