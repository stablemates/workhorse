package run.workhorse.conformance;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import run.workhorse.testing.ScratchDatabase;

/**
 * The JVM conformance lane: every {@code protocol/v1} fixture runs through the Java SDK, and the
 * run must agree with {@code expected-unsupported.json}. The counterpart of Ruby's {@code
 * protocol_conformance_spec.rb}.
 */
@ExtendWith(ScratchDatabase.class)
class ProtocolConformanceTest {
  /** The repository root, from the schema path that the build passes to every test. */
  static Path root() {
    String schema = System.getProperty("workhorse.schema");
    if (schema == null) {
      throw new IllegalStateException("The build sets the workhorse.schema system property");
    }
    return Path.of(schema).toAbsolutePath().getParent().getParent().getParent();
  }

  static Path protocol() {
    return root().resolve("protocol/v1");
  }

  static Path ledger() {
    return root().resolve("jvm/workhorse/src/test/resources/conformance/expected-unsupported.json");
  }

  @Test
  void executesEveryProtocolFixtureAndAgreesWithTheExpectedUnsupportedList() throws Exception {
    Runner runner = new Runner(Catalogue.load(protocol()), Ledger.load(ledger()), protocol());
    List<String> problems = runner.run();
    System.err.println(runner.report());
    assertEquals(
        List.of(),
        problems,
        "JVM protocol conformance disagrees with its list:\n  " + String.join("\n  ", problems));
  }

  /** The reconciliation rules. They need no database. */
  @Nested
  class TheExpectedUnsupportedList {
    private static List<Ledger.Entry> listed(String... pairs) {
      Stream.Builder<Ledger.Entry> entries = Stream.builder();
      for (int index = 0; index < pairs.length; index += 2) {
        entries.add(new Ledger.Entry(pairs[index], pairs[index + 1], "tracked"));
      }
      return entries.build().toList();
    }

    private static List<String> reconcile(
        Set<String> declared, Map<String, Outcome> outcomes, List<Ledger.Entry> entries) {
      return Ledger.reconcile(declared, outcomes, entries);
    }

    @Test
    void failsTheRunForAnUnlistedFailingFixture() {
      assertEquals(
          List.of("requests/a does not pass and is not listed: wrong column"),
          reconcile(
              Set.of("requests/a"),
              Map.of("requests/a", Outcome.failed("wrong column")),
              listed()));
    }

    @Test
    void failsTheRunForAnUnlistedUnsupportedFixture() {
      assertEquals(
          List.of("runtime/a does not pass and is not listed: no worker"),
          reconcile(
              Set.of("runtime/a"),
              Map.of("runtime/a", Outcome.unsupported("no worker")),
              listed()));
    }

    @Test
    void failsTheRunForAListedFixtureThatPasses() {
      assertEquals(
          List.of("requests/a now passes; remove it from the expected-unsupported list (SM-900)"),
          reconcile(
              Set.of("requests/a"),
              Map.of("requests/a", Outcome.passed()),
              listed("requests/a", "SM-900")));
    }

    @Test
    void acceptsAListedFailingFixtureAndASkippedFixture() {
      assertEquals(
          List.of(),
          reconcile(
              Set.of("requests/a", "scenarios/b"),
              Map.of(
                  "requests/a",
                  Outcome.failed("wrong column"),
                  "scenarios/b",
                  Outcome.skipped("no database")),
              listed("requests/a", "SM-900")));
    }

    @Test
    void requiresEachEntryToNameADeclaredFixtureOnceWithAnIssue() {
      assertEquals(
          List.of(
              "requests/a is listed twice",
              "requests/gone names tracking issue \"WH-12\", not SM-<number>",
              "requests/gone is listed but no protocol/v1 fixture declares it"),
          reconcile(
              Set.of("requests/a"),
              Map.of("requests/a", Outcome.failed("x")),
              listed("requests/a", "SM-900", "requests/a", "SM-900", "requests/gone", "WH-12")));
    }

    @Test
    void failsTheRunForADeclaredFixtureThatNeverRan() {
      assertEquals(
          List.of("requests/b was never executed"),
          reconcile(
              Set.of("requests/a", "requests/b"),
              Map.of("requests/a", Outcome.passed()),
              listed()));
    }

    @Test
    void listsOnlyRuntimeFixturesThatAnOpenSliceOwns() throws IOException {
      for (Ledger.Entry entry : Ledger.load(ledger())) {
        assertTrue(entry.fixture().startsWith("runtime/"), entry.fixture());
        assertTrue(RuntimeFixtures.OPEN_SLICES.contains(entry.issue()), entry.toString());
      }
    }
  }

  @Test
  void failsTheRunForAnUnclassifiedProtocolFile(@TempDir Path directory) throws IOException {
    try (Stream<Path> files = Files.list(protocol())) {
      for (Path file : (Iterable<Path>) files::iterator) {
        Files.copy(file, directory.resolve(file.getFileName()));
      }
    }
    Files.writeString(directory.resolve("leases.json"), "[]");
    Failure failure = assertThrows(Failure.class, () -> Catalogue.load(directory));
    assertEquals(
        "protocol/v1 holds files the JVM runner does not classify: leases.json; execute them or"
            + " name them as metadata",
        failure.getMessage());
  }

  @Test
  void failsTheRunForMissingManifestCoverage() {
    Map<String, @Nullable Object> manifest = new LinkedHashMap<>();
    manifest.put("coverage", List.of("enqueue", "claim"));
    manifest.put("runtimeCoverage", List.of());
    assertEquals(
        "SQL protocol fixtures lack coverage: claim",
        Runner.manifestCoverage(manifest, Set.of("enqueue")));
  }

  @Test
  void rejectsAnInterpreterStepThatAcceptsAValueTheFixtureRejects() {
    Map<String, @Nullable Object> step = new LinkedHashMap<>();
    step.put("id", "reject");
    step.put("expect", Map.of("$type", "any"));
    step.put("actual", true);
    step.put("rejects", true);
    Map<String, @Nullable Object> fixture = new LinkedHashMap<>();
    fixture.put("id", "self-test");
    fixture.put("steps", List.of(step));
    fixture.put("errors", List.of());
    Failure failure = assertThrows(Failure.class, () -> Runner.runInterpreter(fixture));
    assertEquals("self-test/reject accepted a value the fixture rejects", failure.getMessage());
  }

  @Test
  void comparesNumbersByValue() {
    assertTrue(Matcher.same(1L, 1.0));
  }
}
