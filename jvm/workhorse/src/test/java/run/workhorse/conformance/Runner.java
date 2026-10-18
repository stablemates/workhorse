package run.workhorse.conformance;

import static run.workhorse.conformance.Failure.check;

import java.math.BigInteger;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import org.jspecify.annotations.Nullable;
import org.postgresql.util.PSQLException;
import run.workhorse.CatchupPolicy;
import run.workhorse.CompatibilityException;
import run.workhorse.DatabaseException;
import run.workhorse.EnqueueOptions;
import run.workhorse.Idempotency;
import run.workhorse.Queue;
import run.workhorse.QueueOptions;
import run.workhorse.ScheduleDefinition;
import run.workhorse.ScheduledTask;
import run.workhorse.TaskContractVersion;
import run.workhorse.TaskTypeContracts;
import run.workhorse.WorkhorseException;
import run.workhorse.internal.Compatibility;
import run.workhorse.internal.ContractSchema;
import run.workhorse.internal.Json;
import run.workhorse.internal.Row;
import run.workhorse.internal.Sql;
import run.workhorse.internal.SqlCatalogue;
import run.workhorse.testing.ScratchDatabase;

/**
 * Executes every {@code protocol/v1} fixture through the Java SDK and reconciles the outcomes with
 * the expected-unsupported list. The counterpart of Ruby's {@code Conformance::Runner}.
 */
final class Runner {
  /** The categories that need PostgreSQL. */
  static final List<String> DATABASE_CATEGORIES =
      List.of(
          "scenarios",
          "cron-occurrences",
          "requests",
          "schedules",
          "compatibility",
          "failures",
          "runtime");

  private static final String CRON =
      "SELECT occurrence_at::text FROM workhorse.cron_occurrences_v1(?::text, ?::timestamptz,"
          + " ?::timestamptz, ?::integer, ?::text) occurrence_at";

  /** A fixture body that may fail. */
  @FunctionalInterface
  interface Attempt {
    void run() throws Exception;
  }

  private final Catalogue catalogue;
  private final List<Ledger.Entry> entries;
  private final Path protocol;
  private final Map<String, Outcome> outcomes = new LinkedHashMap<>();

  Runner(Catalogue catalogue, List<Ledger.Entry> entries, Path protocol) {
    this.catalogue = catalogue;
    this.entries = entries;
    this.protocol = protocol;
  }

  Map<String, Outcome> outcomes() {
    return outcomes;
  }

  /** The disagreements between the fixtures and the list. An empty result is a clean run. */
  List<String> run() throws Exception {
    eachFixture("interpreter", Runner::runInterpreter);
    eachFixture("contracts", Runner::runContract);
    List<String> problems = new ArrayList<>();
    try (ScratchDatabase.Extra scenarios = ScratchDatabase.extra("protocol_conformance_scenarios");
        Connection connection = scenarios.connect()) {
      Database.textResults(connection);
      problems.addAll(runScenarios(connection));
    }
    try (ScratchDatabase.Extra adapters = ScratchDatabase.extra("protocol_conformance_adapters");
        Connection setup = adapters.connect()) {
      Database.textResults(setup);
      runCron(setup);
      runRequests(adapters, setup);
      runSchedules(adapters, setup);
      // Compatibility rewrites the version tables, so it runs after every other adapter.
      runCompatibility(adapters, setup);
    }
    try (ScratchDatabase.Extra runtime = ScratchDatabase.extra("protocol_conformance_runtime");
        Connection setup = runtime.connect()) {
      Database.textResults(setup);
      RuntimeFixtures adapter = new RuntimeFixtures(runtime::connect, setup, protocol);
      eachFixture("failures", adapter::failure);
      for (Map<String, @Nullable Object> fixture : catalogue.category("runtime")) {
        String gap = RuntimeFixtures.gap(fixture);
        record(
            "runtime",
            fixture,
            gap != null ? Outcome.unsupported(gap) : attempt(() -> adapter.run(fixture)));
      }
    }
    problems.addAll(Ledger.reconcile(catalogue.declared(), outcomes, entries));
    return problems;
  }

  /** The per-status counts and every fixture that did not pass, for standard error. */
  String report() {
    Map<Outcome.Status, Integer> counts = new TreeMap<>();
    outcomes.values().forEach(outcome -> counts.merge(outcome.status(), 1, Integer::sum));
    StringBuilder report = new StringBuilder("JVM protocol conformance: " + counts);
    new TreeMap<>(outcomes)
        .forEach(
            (fixture, outcome) -> {
              if (outcome.status() != Outcome.Status.PASSED) {
                report
                    .append("\n  ")
                    .append(
                        String.format("%-11s", outcome.status().name().toLowerCase(Locale.ROOT)))
                    .append(' ')
                    .append(fixture)
                    .append(": ")
                    .append(outcome.reason());
              }
            });
    return report.toString();
  }

  // ----- contracts ---------------------------------------------------------------------------

  /**
   * A contract fixture compiles its schema the way {@code Queue.syncContracts} does, then checks
   * each instance's verdict.
   */
  static void runContract(Map<String, @Nullable Object> fixture) {
    ContractSchema schema;
    try {
      schema = new ContractSchema(fixture.get("schema"));
    } catch (IllegalArgumentException | WorkhorseException error) {
      if (Boolean.TRUE.equals(fixture.get("schemaError"))) {
        return;
      }
      throw new Failure("rejected a valid schema: " + error.getMessage());
    }
    check(
        !Boolean.TRUE.equals(fixture.get("schemaError")), "compiled a schema the protocol rejects");
    if (!(fixture.get("instances") instanceof List<?> instances)) {
      throw new Failure("fixture lists no instances");
    }
    for (int index = 0; index < instances.size(); index++) {
      Map<String, @Nullable Object> instance = object(instances.get(index), "instance");
      if (!(instance.get("valid") instanceof Boolean expected)) {
        throw new Failure("instance states no verdict");
      }
      check(
          schema.valid(instance.get("value")) == expected,
          "instance " + index + ": expected valid = " + expected);
    }
  }

  // ----- interpreter -------------------------------------------------------------------------

  static void runInterpreter(Map<String, @Nullable Object> fixture) {
    String id = String.valueOf(fixture.get("id"));
    Map<String, @Nullable Object> references = new LinkedHashMap<>();
    if (!(fixture.get("steps") instanceof List<?> steps)) {
      throw new Failure("interpreter fixture has no steps");
    }
    for (Object item : steps) {
      Map<String, @Nullable Object> step = object(item, "step");
      String location = id + "/" + step.get("id");
      Object actual = materialize(step.get("actual"));
      if (Boolean.TRUE.equals(step.get("rejects"))) {
        boolean accepted;
        try {
          Matcher.assertValue(step.get("expect"), actual, references, location);
          accepted = true;
        } catch (Failure rejected) {
          accepted = false;
        }
        check(!accepted, location + " accepted a value the fixture rejects");
      } else {
        Matcher.assertValue(step.get("expect"), actual, references, location);
      }
      capture(step, actual, references);
    }
    if (!(fixture.get("errors") instanceof List<?> errors)) {
      throw new Failure("interpreter fixture has no errors");
    }
    for (Object item : errors) {
      Map<String, @Nullable Object> error = object(item, "error");
      assertErrorValue(
          object(error.get("expect"), "expect"),
          object(error.get("actual"), "actual"),
          references,
          id + "/" + error.get("id"));
    }
  }

  /**
   * Turns {@code {"$native": kind, "value": text}} into the value a driver produces, then
   * normalizes it the way the scenario decoder does.
   */
  static @Nullable Object materialize(@Nullable Object value) {
    if (value instanceof List<?> list) {
      List<@Nullable Object> items = new ArrayList<>();
      list.forEach(item -> items.add(materialize(item)));
      return items;
    }
    Map<String, @Nullable Object> object = Json.object(value);
    if (object == null) {
      return value;
    }
    if (!object.keySet().equals(Set.of("$native", "value"))) {
      Map<String, @Nullable Object> items = new LinkedHashMap<>();
      object.forEach((key, item) -> items.put(key, materialize(item)));
      return items;
    }
    return nativeValue(object.get("$native"), object.get("value"));
  }

  private static @Nullable Object nativeValue(@Nullable Object kind, @Nullable Object raw) {
    if ("json".equals(kind)) {
      return raw;
    }
    if (!List.of("integer", "number", "timestamp", "uuid").contains(kind)) {
      throw new Failure("unknown interpreter native value " + Matcher.render(kind));
    }
    if (!(raw instanceof String text)) {
      throw new Failure("native value " + Matcher.render(raw) + " is not text");
    }
    try {
      return switch (String.valueOf(kind)) {
        // PostgreSQL numeric: integral values become integers, as the decoder does.
        case "integer" ->
            text.matches("[+-]?\\d+") ? integer(new BigInteger(text)) : Double.parseDouble(text);
        // A non-finite float has no JSON form, so the number matcher rejects it.
        case "number" -> {
          double number = Double.parseDouble(text);
          yield Double.isFinite(number) ? number : null;
        }
        case "timestamp" -> {
          check(Matcher.timestamp(text), text + " is not an RFC 3339 timestamp");
          yield Matcher.normalizeTimestamp(OffsetDateTime.parse(text).toInstant());
        }
        default -> {
          String compact = text.replace("-", "");
          check(compact.matches("\\p{XDigit}{32}"), text + " is not a UUID");
          yield UUID.fromString(
                  compact.replaceFirst(
                      "(\\p{XDigit}{8})(\\p{XDigit}{4})(\\p{XDigit}{4})(\\p{XDigit}{4})(\\p{XDigit}{12})",
                      "$1-$2-$3-$4-$5"))
              .toString();
        }
      };
    } catch (NumberFormatException error) {
      throw new Failure(String.valueOf(error.getMessage()));
    }
  }

  private static Object integer(BigInteger value) {
    return value.bitLength() < 64 ? (Object) value.longValue() : value;
  }

  static void capture(
      Map<String, @Nullable Object> step,
      @Nullable Object actual,
      Map<String, @Nullable Object> references) {
    Map<String, @Nullable Object> captures = Json.object(step.get("capture"));
    if (captures == null) {
      return;
    }
    captures.forEach(
        (name, pointer) -> {
          if (!(pointer instanceof String path)) {
            throw new Failure("capture " + name + " has no pointer");
          }
          references.put(name, Matcher.readPointer(actual, path));
        });
  }

  static void assertErrorValue(
      Map<String, @Nullable Object> expected,
      Map<String, @Nullable Object> actual,
      Map<String, @Nullable Object> references,
      String location) {
    for (String field : List.of("code", "message")) {
      if (!Matcher.same(expected.get(field), actual.get(field))) {
        throw new Failure(
            location
                + " expected error "
                + field
                + " "
                + Matcher.render(expected.get(field))
                + ", received "
                + Matcher.render(actual.get(field)));
      }
    }
    if (!expected.containsKey("detail")) {
      return;
    }
    check(actual.containsKey("detail"), location + " expected error detail, received none");
    Matcher.assertValue(
        expected.get("detail"), actual.get("detail"), references, location + ".detail");
  }

  // ----- scenarios ---------------------------------------------------------------------------

  /**
   * Runs every SQL scenario and returns coverage problems. A scenario that fails stops at its first
   * failing step; the next scenario still runs.
   */
  private List<String> runScenarios(Connection connection) {
    Set<String> listed = new HashSet<>();
    entries.forEach(entry -> listed.add(entry.fixture()));
    Set<String> coverage = new HashSet<>();
    for (Map<String, @Nullable Object> scenario : catalogue.category("scenarios")) {
      Outcome outcome = attempt(() -> runScenario(connection, scenario));
      // A listed scenario keeps the capabilities it declares, so the list reports its gap once.
      if (outcome.status() == Outcome.Status.PASSED
          || listed.contains(Catalogue.key("scenarios", scenario))) {
        coverage.addAll(covers(scenario));
      }
      record("scenarios", scenario, outcome);
    }
    String problem = manifestCoverage(catalogue.manifest(), coverage);
    return problem == null ? List.of() : List.of(problem);
  }

  static Set<String> covers(Map<String, @Nullable Object> scenario) {
    Set<String> covered = new HashSet<>();
    if (scenario.get("steps") instanceof List<?> steps) {
      for (Object item : steps) {
        Map<String, @Nullable Object> step = Json.object(item);
        if (step != null && step.get("covers") instanceof List<?> covers) {
          covers.stream().filter(String.class::isInstance).forEach(c -> covered.add((String) c));
        }
      }
    }
    return covered;
  }

  /** The coverage problem, or {@code null} when the scenarios cover every manifest capability. */
  static @Nullable String manifestCoverage(
      Map<String, @Nullable Object> manifest, Set<String> coverage) {
    Set<String> runtime = new HashSet<>(strings(manifest.get("runtimeCoverage")));
    List<String> missing =
        strings(manifest.get("coverage")).stream()
            .filter(capability -> !runtime.contains(capability) && !coverage.contains(capability))
            .toList();
    return missing.isEmpty()
        ? null
        : "SQL protocol fixtures lack coverage: " + String.join(", ", missing);
  }

  private static List<String> strings(@Nullable Object value) {
    if (!(value instanceof List<?> list)) {
      return List.of();
    }
    return list.stream().filter(String.class::isInstance).map(String.class::cast).toList();
  }

  private static void runScenario(Connection connection, Map<String, @Nullable Object> scenario)
      throws SQLException {
    Map<String, @Nullable Object> references = new LinkedHashMap<>();
    if (!(scenario.get("steps") instanceof List<?> steps)) {
      throw new Failure("scenario has no steps");
    }
    for (Object item : steps) {
      Map<String, @Nullable Object> step = object(item, "step");
      runStep(connection, step, references, scenario.get("id") + "/" + step.get("id"));
    }
  }

  private static void runStep(
      Connection connection,
      Map<String, @Nullable Object> step,
      Map<String, @Nullable Object> references,
      String location)
      throws SQLException {
    if (!(step.get("sql") instanceof String sql)) {
      throw new Failure(location + " has no SQL");
    }
    Object values =
        step.containsKey("parameters")
            ? Matcher.resolve(step.get("parameters"), references)
            : List.of();
    if (!(values instanceof List<?> parameters)) {
      throw new Failure(location + " parameters are not a list: " + Matcher.render(values));
    }
    Database.Result result = Database.execute(connection, sql, parameters, location);
    Map<String, @Nullable Object> expectedError = Json.object(step.get("error"));
    PSQLException error = result.error();
    if (error != null && expectedError != null) {
      Map<String, @Nullable Object> actual;
      try {
        actual = Database.databaseError(error);
      } catch (Failure failure) {
        throw new Failure(location + ": " + failure.getMessage());
      }
      assertErrorValue(expectedError, actual, references, location);
    } else if (expectedError != null) {
      List<?> rows = result.rows() == null ? List.of() : result.rows();
      throw new Failure(
          location
              + " expected error "
              + Matcher.render(expectedError)
              + ", received "
              + rows.size()
              + " rows");
    } else if (error != null) {
      throw new Failure(location + " failed: " + Database.describe(error));
    } else {
      Map<String, @Nullable Object> expect = Json.object(step.get("expect"));
      Object expected =
          expect != null && expect.containsKey("rows") ? expect.get("rows") : List.of();
      Matcher.assertValue(expected, result.rows(), references, location);
      capture(step, result.rows(), references);
    }
  }

  // ----- adapters ----------------------------------------------------------------------------

  private void runCron(Connection connection) {
    eachFixture(
        "cron-occurrences",
        fixture -> {
          if (!(fixture.get("limit") instanceof Long limit)) {
            throw new Failure("limit is not an integer");
          }
          List<Long> actual = new ArrayList<>();
          try (PreparedStatement statement = connection.prepareStatement(CRON)) {
            statement.setString(1, (String) fixture.get("expression"));
            // A new definition has no previous occurrence, which the fixture writes as null.
            statement.setString(2, (String) fixture.get("lastOccurrenceAt"));
            statement.setString(3, (String) fixture.get("now"));
            statement.setString(4, limit.toString());
            statement.setString(5, (String) fixture.get("timezone"));
            try (ResultSet rows = statement.executeQuery()) {
              while (rows.next()) {
                actual.add(Database.microseconds(Database.instant(rows.getString(1))));
              }
            }
          } catch (SQLException error) {
            throw new Failure(Database.describe(error));
          }
          if (!(fixture.get("expected") instanceof List<?> list)) {
            throw new Failure("expected is not a list");
          }
          List<Long> expected =
              list.stream()
                  .map(
                      instant ->
                          Database.microseconds(
                              OffsetDateTime.parse(String.valueOf(instant)).toInstant()))
                  .toList();
          check(
              actual.equals(expected),
              "expected occurrences "
                  + expected
                  + ", received "
                  + actual
                  + " (microseconds since the epoch)");
        });
  }

  /**
   * Routes calls to one SQL function through a wrapper that records its arguments first.
   *
   * <p>The Java client runs its statements on a connection the runner gives it, so the runner
   * interposes in the database as the Rust and Ruby lanes do: the real function keeps running, and
   * the runner reads the recorded arguments back.
   */
  static void recordCalls(Connection connection, String function) {
    List<Map<String, @Nullable Object>> overloads =
        sql(
            connection,
            """
            SELECT p.oid::regprocedure::text AS signature,
                   pg_get_function_arguments(p.oid) AS arguments,
                   pg_get_function_result(p.oid) AS result, p.proretset AS returns_set,
                   p.pronargs::integer AS arity
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'workhorse' AND p.proname = '%s'
            """
                .formatted(function));
    check(!overloads.isEmpty(), "workhorse." + function + " does not exist");
    sql(
        connection,
        "CREATE TABLE IF NOT EXISTS public.conformance_calls (sequence bigserial PRIMARY KEY,"
            + " function_name text NOT NULL, arguments jsonb NOT NULL)");
    for (int index = 0; index < overloads.size(); index++) {
      Map<String, @Nullable Object> overload = overloads.get(index);
      String inner = function + "__recorded_" + index;
      List<String> placeholders = new ArrayList<>();
      for (long position = 1; position <= (Long) overload.get("arity"); position++) {
        placeholders.add("$" + position);
      }
      String arguments = String.join(", ", placeholders);
      String call =
          Boolean.TRUE.equals(overload.get("returns_set"))
              ? "SELECT * FROM workhorse." + inner + "(" + arguments + ")"
              : "SELECT workhorse." + inner + "(" + arguments + ")";
      try (Statement statement = connection.createStatement()) {
        statement.execute("ALTER FUNCTION " + overload.get("signature") + " RENAME TO " + inner);
        statement.execute(
            "CREATE FUNCTION workhorse."
                + function
                + "("
                + overload.get("arguments")
                + ") RETURNS "
                + overload.get("result")
                + " LANGUAGE sql AS $recorded$ INSERT INTO public.conformance_calls"
                + " (function_name, arguments) VALUES ('"
                + function
                + "', jsonb_build_array("
                + arguments
                + ")); "
                + call
                + "; $recorded$");
      } catch (SQLException error) {
        throw new Failure(
            "interpose " + overload.get("signature") + ": " + Database.describe(error));
      }
    }
  }

  /** The arguments of every recorded call to {@code function} since the last read. */
  static List<@Nullable Object> recorded(Connection connection, String function) {
    List<Map<String, @Nullable Object>> rows =
        sql(
            connection,
            "WITH taken AS (DELETE FROM public.conformance_calls WHERE function_name = '"
                + function
                + "' RETURNING sequence, arguments) SELECT arguments FROM taken ORDER BY sequence");
    List<@Nullable Object> calls = new ArrayList<>();
    rows.forEach(row -> calls.add(row.get("arguments")));
    return calls;
  }

  /** The rows of one runner statement on a text-result connection. */
  static List<Map<String, @Nullable Object>> sql(Connection connection, String sql) {
    try (Statement statement = connection.createStatement()) {
      if (!statement.execute(sql)) {
        return List.of();
      }
      try (ResultSet resultSet = statement.getResultSet()) {
        return Database.rows(resultSet);
      }
    } catch (SQLException error) {
      throw new Failure(Database.describe(error));
    }
  }

  /**
   * Translates a fixture's application options into {@link EnqueueOptions}, refusing any option the
   * adapter does not know, so a new fixture option cannot pass by being ignored.
   */
  static EnqueueOptions enqueueOptions(Map<String, @Nullable Object> options) {
    EnqueueOptions.Builder builder = EnqueueOptions.builder();
    options.forEach(
        (name, value) -> {
          switch (name) {
            case "queue" -> builder.queue((String) value);
            case "priority" -> builder.priority(intValue(value));
            case "concurrencyKey" -> builder.concurrencyKey((String) value);
            case "budget" -> builder.budget((String) value);
            case "maxAttempts" -> builder.maxAttempts(intValue(value));
            case "retryPolicy" -> builder.retryPolicy(retryPolicy(value));
            case "executionTimeoutMs" -> builder.executionTimeout(Duration.ofMillis((Long) value));
            case "tags" -> builder.tags(strings(value));
            case "idempotency" -> {
              Map<String, @Nullable Object> fields = object(value, "idempotency");
              builder.idempotency(
                  new Idempotency(
                      (String) fields.get("key"),
                      fields.get("scope") instanceof String scope ? scope : "default",
                      fields.get("ttlMs") instanceof Long ttl
                          ? Duration.ofMillis(ttl)
                          : Duration.ofDays(1)));
            }
            default -> throw new Failure("the adapter does not translate option " + name);
          }
        });
    return builder.build();
  }

  static @Nullable Map<String, ?> retryPolicy(@Nullable Object value) {
    if (value == null) {
      return null;
    }
    Map<String, @Nullable Object> policy = Json.object(value);
    if (policy == null) {
      throw new Failure("retryPolicy is neither null nor an object");
    }
    return policy;
  }

  static @Nullable Integer intValue(@Nullable Object value) {
    return value == null ? null : Math.toIntExact((Long) value);
  }

  /**
   * A request fixture records the JSON request every client sends to {@code enqueue_many_v1}, so
   * {@code Queue.enqueue} passes only when it sends that call with that request.
   */
  private void runRequests(ScratchDatabase.Extra database, Connection setup) {
    Outcome interposed = attempt(() -> recordCalls(setup, "enqueue_many_v1"));
    eachFixture(
        "requests",
        fixture -> {
          try {
            check(
                interposed.status() == Outcome.Status.PASSED, String.valueOf(interposed.reason()));
            Map<String, @Nullable Object> application =
                object(fixture.get("application"), "application");
            Map<String, @Nullable Object> options = Json.object(application.get("options"));
            EnqueueOptions translated = enqueueOptions(options == null ? Map.of() : options);
            try (Connection connection = database.connect()) {
              clientCall(
                  () ->
                      new Queue(Connections.borrowed(connection))
                          .enqueue(
                              (String) application.get("type"),
                              application.get("payload"),
                              translated));
            }
            List<@Nullable Object> calls = recorded(setup, "enqueue_many_v1");
            check(calls.size() == 1, "expected one enqueue_many_v1 call, recorded " + calls.size());
            Matcher.assertValue(
                List.of(fixture.get("postgres")),
                ((List<?>) calls.get(0)).get(0),
                new LinkedHashMap<>(),
                "enqueue_many_v1.p_requests");
          } finally {
            // A failed attempt may have recorded a call; the next fixture must start clean.
            attempt(() -> recorded(setup, "enqueue_many_v1"));
          }
        });
  }

  static ScheduleDefinition scheduleDefinition(Map<String, @Nullable Object> definition) {
    Map<String, @Nullable Object> task = object(definition.get("task"), "task");
    Integer priority = intValue(task.get("priority"));
    ScheduledTask scheduled =
        new ScheduledTask(
            (String) task.get("type"),
            task.get("payload"),
            (String) task.get("queue"),
            priority == null ? 0 : priority,
            (String) task.get("concurrencyKey"),
            intValue(task.get("maxAttempts")),
            retryPolicy(task.get("retryPolicy")));
    CatchupPolicy catchup =
        switch (String.valueOf(definition.get("catchupPolicy"))) {
          case "skip" -> CatchupPolicy.SKIP;
          case "latest" -> CatchupPolicy.LATEST;
          case "all" -> CatchupPolicy.ALL;
          default ->
              throw new Failure(
                  "unknown catchup policy " + Matcher.render(definition.get("catchupPolicy")));
        };
    return new ScheduleDefinition(
        (String) definition.get("name"),
        (String) definition.get("schedule"),
        scheduled,
        (String) definition.get("timezone"),
        catchup,
        Boolean.TRUE.equals(definition.get("enabled")));
  }

  /** The contracts a schedule fixture syncs before its schedules. */
  static Map<String, TaskTypeContracts> taskContracts(Map<String, @Nullable Object> contracts) {
    Map<String, TaskTypeContracts> translated = new LinkedHashMap<>();
    contracts.forEach(
        (taskType, item) -> {
          Map<String, @Nullable Object> contract = object(item, "contract");
          Map<String, TaskContractVersion> versions = new LinkedHashMap<>();
          object(contract.get("versions"), "versions")
              .forEach(
                  (name, entry) -> {
                    Map<String, @Nullable Object> version = object(entry, "version");
                    versions.put(
                        name,
                        new TaskContractVersion(
                            nonNull(version.get("payloadSchema")),
                            nonNull(version.get("resultSchema")),
                            (Long) version.get("maxPayloadBytes"),
                            (Long) version.get("maxResultBytes"),
                            strings(version.get("sensitivePayloadKeys")),
                            strings(version.get("sensitiveResultKeys"))));
                  });
          translated.put(
              taskType, new TaskTypeContracts((String) contract.get("currentVersion"), versions));
        });
    return translated;
  }

  private void runSchedules(ScratchDatabase.Extra database, Connection setup) {
    Outcome interposed = attempt(() -> recordCalls(setup, "sync_schedule_definitions_v2"));
    eachFixture(
        "schedules",
        fixture -> {
          try {
            check(
                interposed.status() == Outcome.Status.PASSED, String.valueOf(interposed.reason()));
            String namespace = (String) fixture.get("namespace");
            if (!(fixture.get("prune") instanceof Boolean prune)) {
              throw new Failure("fixture sets no prune flag");
            }
            List<ScheduleDefinition> definitions = new ArrayList<>();
            if (fixture.get("application") instanceof List<?> application) {
              application.forEach(
                  item -> definitions.add(scheduleDefinition(object(item, "definition"))));
            }
            try (Connection connection = database.connect()) {
              Queue queue =
                  new Queue(
                      Connections.borrowed(connection),
                      QueueOptions.builder()
                          .defaultQueue((String) fixture.get("defaultQueue"))
                          .build());
              Map<String, @Nullable Object> contracts = Json.object(fixture.get("contracts"));
              if (contracts != null) {
                queue.syncContracts(taskContracts(contracts));
              }
              clientCall(() -> queue.syncSchedules(namespace, definitions, prune));
            }
            List<@Nullable Object> calls = recorded(setup, "sync_schedule_definitions_v2");
            check(
                calls.size() == 1,
                "expected one sync_schedule_definitions_v2 call, recorded " + calls.size());
            List<@Nullable Object> expected = new ArrayList<>();
            expected.add(namespace);
            expected.add(fixture.get("postgres"));
            expected.add(prune);
            Matcher.assertValue(
                expected, calls.get(0), new LinkedHashMap<>(), "sync_schedule_definitions_v2");
          } finally {
            attempt(() -> recorded(setup, "sync_schedule_definitions_v2"));
          }
        });
  }

  // ----- compatibility -----------------------------------------------------------------------

  /**
   * Installs the versions a compatibility fixture describes, reads them back the way the client
   * does, and compares the verdict and refusal code. A fixture that presents this client's protocol
   * runs through {@code Queue.assertCompatible}; another protocol runs the same decision directly.
   */
  private void runCompatibility(ScratchDatabase.Extra database, Connection setup) {
    eachFixture(
        "compatibility",
        fixture -> {
          Object installed = fixture.get("installedSchemaVersion");
          if (!(fixture.get("servedProtocolVersions") instanceof List<?> served)) {
            throw new Failure("fixture lists no served protocols");
          }
          installVersions(setup, installed, served);
          String code;
          try (Connection connection = database.connect()) {
            code = refusal(connection, (Long) fixture.get("clientProtocolVersion"));
          } finally {
            if (installed == null) {
              sql(setup, "ALTER SCHEMA workhorse_hidden RENAME TO workhorse");
            }
          }
          compareRefusal(fixture, code);
        });
  }

  /** The refusal code as the fixture spells it, or {@code null} when the client may proceed. */
  private static @Nullable String refusal(Connection connection, long clientProtocol) {
    CompatibilityException.Code code;
    if (clientProtocol == SqlCatalogue.CLIENT_PROTOCOL_VERSION) {
      try {
        new Queue(Connections.borrowed(connection)).assertCompatible();
        return null;
      } catch (CompatibilityException error) {
        code = error.code();
      }
    } else {
      Integer schema = null;
      boolean missing = false;
      List<Integer> served = new ArrayList<>();
      try {
        for (Row row : Sql.rows(connection, SqlCatalogue.COMPATIBILITY_STATE)) {
          int version = row.requiredInteger("version");
          if (row.requiredText("kind").equals("schema")) {
            schema = version;
          } else {
            served.add(version);
          }
        }
      } catch (DatabaseException error) {
        if (!List.of("42P01", "3F000").contains(error.sqlState())) {
          throw new Failure("postgres: " + error.getMessage() + " (" + error.sqlState() + ")");
        }
        missing = true;
      }
      code = Compatibility.check(missing ? null : schema, Math.toIntExact(clientProtocol), served);
    }
    return code == null ? null : code.name().toLowerCase(Locale.ROOT).replace('_', '-');
  }

  private static void compareRefusal(Map<String, @Nullable Object> fixture, @Nullable String code) {
    if (!(fixture.get("compatible") instanceof Boolean expected)) {
      throw new Failure("fixture states no verdict");
    }
    String refusal = Matcher.render(fixture.get("refusalCode"));
    if (code == null) {
      check(expected, "accepted; expected refusal " + refusal);
    } else if (expected) {
      throw new Failure("refused a compatible installation: " + code);
    } else {
      check(
          code.equals(fixture.get("refusalCode")),
          "refused with " + code + "; expected " + refusal);
    }
  }

  private static void installVersions(
      Connection connection, @Nullable Object installed, List<?> served) {
    sql(connection, "DELETE FROM workhorse.schema_version");
    sql(connection, "DELETE FROM workhorse.protocol_version");
    for (Object version : served) {
      sql(
          connection,
          "INSERT INTO workhorse.protocol_version (version) VALUES (" + (Long) version + ")");
    }
    if (installed == null) {
      // No installed schema: the client must find no `workhorse` schema at all.
      sql(connection, "ALTER SCHEMA workhorse RENAME TO workhorse_hidden");
    } else {
      sql(
          connection,
          "INSERT INTO workhorse.schema_version (version) VALUES (" + (Long) installed + ")");
    }
  }

  // ----- support -----------------------------------------------------------------------------

  /** A client call, with an SDK error reported the way the other lanes do. */
  static void clientCall(Attempt call) throws Exception {
    try {
      call.run();
    } catch (DatabaseException error) {
      throw new Failure(
          "postgres: "
              + String.valueOf(error.getMessage()).strip()
              + " ("
              + error.sqlState()
              + ")");
    } catch (WorkhorseException | IllegalArgumentException error) {
      throw new Failure(String.valueOf(error.getMessage()));
    }
  }

  static Map<String, @Nullable Object> object(@Nullable Object value, String name) {
    Map<String, @Nullable Object> object = Json.object(value);
    if (object == null) {
      throw new Failure(name + " is not an object: " + Matcher.render(value));
    }
    return object;
  }

  private static Object nonNull(@Nullable Object value) {
    if (value == null) {
      throw new Failure("a contract schema is null");
    }
    return value;
  }

  /** A fixture body over one fixture. */
  @FunctionalInterface
  interface FixtureBody {
    void run(Map<String, @Nullable Object> fixture) throws Exception;
  }

  private void eachFixture(String category, FixtureBody body) {
    for (Map<String, @Nullable Object> fixture : catalogue.category(category)) {
      record(category, fixture, attempt(() -> body.run(fixture)));
    }
  }

  /** The outcome of {@code body}: a {@link Failure} or any other error fails the fixture. */
  static Outcome attempt(Attempt body) {
    try {
      body.run();
      return Outcome.passed();
    } catch (Failure failure) {
      return Outcome.failed(String.valueOf(failure.getMessage()));
    } catch (Exception | AssertionError error) {
      return Outcome.failed(error.getClass().getSimpleName() + ": " + error.getMessage());
    }
  }

  private void record(String category, Map<String, @Nullable Object> fixture, Outcome outcome) {
    outcomes.put(Catalogue.key(category, fixture), outcome);
  }
}
