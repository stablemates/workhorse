package dev.stablemates.workhorse.conformance;

import dev.stablemates.workhorse.internal.Json;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Stream;
import org.jspecify.annotations.Nullable;

/**
 * Every fixture each {@code protocol/v1} category file declares, in file order. The counterpart of
 * Ruby's {@code Conformance::Catalogue}.
 */
final class Catalogue {
  /** Files in {@code protocol/v1} that describe fixtures rather than declare them. */
  static final Set<String> METADATA = Set.of("manifest.json", "cron.md", "governed-surface.json");

  /** Fixture files, by the category name the list uses. */
  static final List<String> CATEGORIES =
      List.of(
          "compatibility",
          "contracts",
          "cron-occurrences",
          "failures",
          "interpreter",
          "requests",
          "runtime",
          "scenarios",
          "schedules");

  private final Map<String, List<Map<String, @Nullable Object>>> fixtures;
  private final Map<String, @Nullable Object> manifest;

  private Catalogue(
      Map<String, List<Map<String, @Nullable Object>>> fixtures,
      Map<String, @Nullable Object> manifest) {
    this.fixtures = fixtures;
    this.manifest = manifest;
  }

  /** The fixtures in {@code directory}, refusing any file the runner does not classify. */
  static Catalogue load(Path directory) throws IOException {
    List<String> unknown = new ArrayList<>();
    try (Stream<Path> files = Files.list(directory)) {
      for (Path file : (Iterable<Path>) files::iterator) {
        String name = file.getFileName().toString();
        boolean category =
            name.endsWith(".json") && CATEGORIES.contains(name.substring(0, name.length() - 5));
        if (!METADATA.contains(name) && !category) {
          unknown.add(name);
        }
      }
    }
    if (!unknown.isEmpty()) {
      throw new Failure(
          "protocol/v1 holds files the JVM runner does not classify: "
              + String.join(", ", new TreeSet<>(unknown))
              + "; execute them or name them as metadata");
    }
    Map<String, List<Map<String, @Nullable Object>>> fixtures = new LinkedHashMap<>();
    for (String category : CATEGORIES) {
      Object document = Json.parse(Files.readString(directory.resolve(category + ".json")));
      // `failures.json` wraps its fixtures beside the envelope they share.
      Map<String, @Nullable Object> wrapped = Json.object(document);
      Object list =
          category.equals("failures") && wrapped != null ? wrapped.get("fixtures") : document;
      if (!(list instanceof List<?> items)) {
        throw new Failure(category + ".json declares no fixture array");
      }
      List<Map<String, @Nullable Object>> entries = new ArrayList<>();
      for (Object item : items) {
        Map<String, @Nullable Object> fixture = Json.object(item);
        if (fixture == null) {
          throw new Failure(category + ".json holds a fixture that is not an object");
        }
        entries.add(fixture);
      }
      fixtures.put(category, entries);
    }
    Map<String, @Nullable Object> manifest =
        Json.object(Json.parse(Files.readString(directory.resolve("manifest.json"))));
    if (manifest == null) {
      throw new Failure("manifest.json is not an object");
    }
    return new Catalogue(fixtures, manifest);
  }

  List<Map<String, @Nullable Object>> category(String name) {
    List<Map<String, @Nullable Object>> list = fixtures.get(name);
    if (list == null) {
      throw new IllegalArgumentException("unknown category " + name);
    }
    return list;
  }

  Map<String, @Nullable Object> manifest() {
    return manifest;
  }

  /** Every {@code <category>/<fixture id>} key. */
  Set<String> declared() {
    Set<String> declared = new TreeSet<>();
    fixtures.forEach(
        (category, list) -> list.forEach(fixture -> declared.add(key(category, fixture))));
    return declared;
  }

  static String key(String category, Map<String, @Nullable Object> fixture) {
    if (!(fixture.get("id") instanceof String id)) {
      throw new Failure("every fixture has a string id");
    }
    return category + "/" + id;
  }
}
