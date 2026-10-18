package run.workhorse.conformance;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;
import run.workhorse.internal.Json;

/**
 * The reconciliation between fixture outcomes and the expected-unsupported list. The counterpart of
 * Ruby's {@code Conformance::Ledger}.
 *
 * <p>Every fixture must pass through a Java adapter or appear on the list with the Issue that owns
 * the gap. A listed fixture that passes also fails the run, so the list cannot outlive its fix.
 */
final class Ledger {
  private static final Pattern ISSUE = Pattern.compile("SM-\\d+");
  private static final Set<String> ENTRY_KEYS = Set.of("fixture", "issue", "reason");

  /** One list entry: a fixture key, the Issue that owns its gap, and why it does not pass. */
  record Entry(String fixture, String issue, String reason) {}

  private Ledger() {}

  /** The list's entries. */
  static List<Entry> load(Path path) throws IOException {
    Map<String, @Nullable Object> document = Json.object(Json.parse(Files.readString(path)));
    if (document == null || !document.keySet().equals(Set.of("$comment", "fixtures"))) {
      throw new IllegalStateException(path + " must hold exactly $comment and fixtures");
    }
    List<Entry> entries = new ArrayList<>();
    for (Object item : (List<?>) document.get("fixtures")) {
      Map<String, @Nullable Object> entry = Json.object(item);
      if (entry == null || !entry.keySet().equals(ENTRY_KEYS)) {
        throw new IllegalStateException(path + " entry " + item + " must hold " + ENTRY_KEYS);
      }
      entries.add(
          new Entry(
              String.valueOf(entry.get("fixture")),
              String.valueOf(entry.get("issue")),
              String.valueOf(entry.get("reason"))));
    }
    return entries;
  }

  /**
   * Every disagreement between the outcomes and the list. An empty result is a clean run.
   *
   * <p>{@code declared} holds every fixture the protocol files define, so a list entry for a
   * fixture that no longer exists is reported too.
   */
  static List<String> reconcile(
      Set<String> declared, Map<String, Outcome> outcomes, List<Entry> entries) {
    List<String> problems = new ArrayList<>();
    Map<String, Entry> listed = new HashMap<>();
    for (Entry entry : entries) {
      String fixture = entry.fixture();
      if (!ISSUE.matcher(entry.issue()).matches()) {
        problems.add(
            fixture + " names tracking issue " + Json.write(entry.issue()) + ", not SM-<number>");
      }
      if (entry.reason().isBlank()) {
        problems.add(fixture + " records no reason");
      }
      if (!declared.contains(fixture)) {
        problems.add(fixture + " is listed but no protocol/v1 fixture declares it");
      }
      if (listed.containsKey(fixture)) {
        problems.add(fixture + " is listed twice");
      }
      listed.put(fixture, entry);
    }
    for (String fixture : new TreeSet<>(declared)) {
      if (!outcomes.containsKey(fixture)) {
        problems.add(fixture + " was never executed");
      }
    }
    new TreeMap<>(outcomes)
        .forEach(
            (fixture, outcome) -> {
              if (!declared.contains(fixture)) {
                problems.add(fixture + " was executed but no protocol/v1 fixture declares it");
              }
              Entry entry = listed.get(fixture);
              switch (outcome.status()) {
                case PASSED -> {
                  if (entry != null) {
                    problems.add(
                        fixture
                            + " now passes; remove it from the expected-unsupported list ("
                            + entry.issue()
                            + ")");
                  }
                }
                case FAILED, UNSUPPORTED -> {
                  if (entry == null) {
                    problems.add(fixture + " does not pass and is not listed: " + outcome.reason());
                  }
                }
                case SKIPPED -> {}
              }
            });
    return problems;
  }
}
