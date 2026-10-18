package dev.stablemates.workhorse.dashboard;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import dev.stablemates.workhorse.ConnectionSource;
import dev.stablemates.workhorse.EnqueueOptions;
import dev.stablemates.workhorse.Queue;
import dev.stablemates.workhorse.QueueOptions;
import dev.stablemates.workhorse.internal.Json;
import dev.stablemates.workhorse.testing.ScratchDatabase;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.Statement;
import java.sql.Types;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;

/**
 * Replays the shared {@code dashboard/v1} HTTP fixtures against the servlet filter in an embedded
 * Tomcat. The counterpart of Ruby's {@code dashboard_conformance_spec.rb}.
 */
@ExtendWith(ScratchDatabase.class)
class DashboardConformanceTest {
  private static final Pattern UUID_SHAPE =
      Pattern.compile(
          "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", Pattern.CASE_INSENSITIVE);
  private static final Pattern TIMESTAMP =
      Pattern.compile(
          "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?(Z|[+-]\\d{2}:\\d{2})");
  private static final Pattern PLACEHOLDER = Pattern.compile("\\$(\\d+)");

  private final Map<String, @Nullable Object> references = new HashMap<>();

  @Test
  void answersEverySharedExchangeAndReportsThePoliciesBehindAQueue() throws Exception {
    Map<String, @Nullable Object> fixture =
        object(
            Json.parse(
                Files.readString(
                    Path.of(System.getProperty("workhorse.schema"))
                        .getParent()
                        .getParent()
                        .getParent()
                        .resolve("dashboard/v1/conformance.json"))));
    Map<String, @Nullable Object> harness = object(fixture.get("harness"));
    String origin = (String) Objects.requireNonNull(harness.get("origin"));
    String hostName = origin.substring("http://".length());
    List<?> scenarios = (List<?>) Objects.requireNonNull(fixture.get("scenarios"));

    // The fixture counts rows database-wide, so the exchanges run on a database of their own.
    try (ScratchDatabase.Extra database = ScratchDatabase.extra("dashboard_conformance");
        Connection connection = database.connect()) {
      for (Object step : (List<?>) Objects.requireNonNull(object(scenarios.get(0)).get("seed"))) {
        seed(connection, object(step));
      }

      ConnectionSource source =
          new ConnectionSource() {
            @Override
            public Connection acquire() {
              return connection;
            }

            @Override
            public void release(Connection released, boolean transactional) {}
          };
      List<String> workers = new ArrayList<>();
      for (Object worker : (List<?>) Objects.requireNonNull(harness.get("configuredWorkers"))) {
        workers.add((String) worker);
      }
      Dashboard.Builder options =
          Dashboard.builder(
                  source,
                  request ->
                      DashboardAuthorization.principal(
                          (String) Objects.requireNonNull(harness.get("authenticatedActor"))))
              .path((String) Objects.requireNonNull(harness.get("basePath")))
              .environment((String) Objects.requireNonNull(harness.get("environment")))
              .configuredWorkers(workers)
              .maintenanceLoops(object(harness.get("maintenanceLoops")))
              .allowedHosts(List.of(hostName));
      Queue demo =
          new Queue(source, QueueOptions.builder().defaultQueue("conformance-demo").build());
      Dashboard host =
          options
              .enqueueTest(
                  (input, actor) -> {
                    Map<String, @Nullable Object> request = object(input);
                    long priority = request.get("priority") instanceof Long value ? value : 0L;
                    return Map.of(
                        "taskId",
                        demo.enqueue(
                                "conformance.demo-" + request.get("kind"),
                                Map.of(),
                                EnqueueOptions.builder().priority((int) priority).build())
                            .taskId()
                            .toString());
                  })
              .setSchedulePaused(
                  (input, actor) -> {
                    Map<String, @Nullable Object> request = object(input);
                    try (PreparedStatement statement =
                        connection.prepareStatement(
                            "SELECT workhorse.set_schedule_paused_v1(?, ?, ?::boolean, ?, ?) AS paused")) {
                      statement.setString(1, (String) request.get("namespace"));
                      statement.setString(2, (String) request.get("name"));
                      statement.setString(3, String.valueOf(request.get("paused")));
                      statement.setString(4, String.valueOf(actor));
                      statement.setString(5, "Dashboard operator request");
                      try (ResultSet rows = statement.executeQuery()) {
                        rows.next();
                        return Map.of("paused", rows.getBoolean("paused"));
                      }
                    }
                  })
              .build();
      Dashboard readOnlyHost = options.readOnly(true).build();

      try (TestServer server = new TestServer("", host);
          TestServer readOnly = new TestServer("", readOnlyHost)) {
        int count = 0;
        for (Object scenario : scenarios.subList(1, scenarios.size())) {
          for (Object item : (List<?>) Objects.requireNonNull(object(scenario).get("exchanges"))) {
            Map<String, @Nullable Object> exchange = object(item);
            exchange(
                "read-only".equals(exchange.get("mode")) ? readOnly : server, exchange, harness);
            count++;
          }
        }
        assertTrue(count > 100, "replayed " + count + " exchanges");

        policies(connection, server, harness);
      }
    }
  }

  /** The checks after the fixture that Ruby's spec also runs: policies, batches, retry storms. */
  private void policies(
      Connection connection, TestServer server, Map<String, @Nullable Object> harness)
      throws Exception {
    try (Statement statement = connection.createStatement()) {
      statement.execute(
          """
          INSERT INTO workhorse.concurrency_policy(queue_name,namespace,max_active,max_active_per_key)
            VALUES ('conformance-demo','dashboard-test',7,2)
            ON CONFLICT(queue_name) DO UPDATE SET namespace=excluded.namespace,
              max_active=excluded.max_active,max_active_per_key=excluded.max_active_per_key;
          INSERT INTO workhorse.rate_limit_policy(queue_name,namespace,rate_limit,rate_interval_ms,rate_burst,
              per_key_limit,per_key_interval_ms,per_key_burst)
            VALUES ('conformance-demo','dashboard-test',10,1000,12,3,2000,4)
            ON CONFLICT(queue_name) DO UPDATE SET namespace=excluded.namespace,
              rate_limit=excluded.rate_limit,rate_interval_ms=excluded.rate_interval_ms,
              rate_burst=excluded.rate_burst,per_key_limit=excluded.per_key_limit,
              per_key_interval_ms=excluded.per_key_interval_ms,per_key_burst=excluded.per_key_burst;
          INSERT INTO workhorse.admission_shard(queue_name,shard,tokens,refilled_at)
            VALUES ('conformance-demo',0,0.5,clock_timestamp()+interval '1 hour')
            ON CONFLICT(queue_name,shard) DO UPDATE SET tokens=excluded.tokens,refilled_at=excluded.refilled_at;
          """);
    }
    String taskId;
    long attempt;
    try (Statement statement = connection.createStatement();
        ResultSet rows =
            statement.executeQuery(
                """
                SELECT task.id,runtime.current_attempt FROM workhorse.dashboard_task_v1 task
                  JOIN workhorse.dashboard_task_runtime_v1 runtime ON runtime.task_id=task.id
                 WHERE task.queue_name='conformance-demo' ORDER BY task.created_at LIMIT 1
                """)) {
      assertTrue(rows.next());
      taskId = rows.getString("id");
      attempt = rows.getLong("current_attempt");
    }
    try (PreparedStatement statement =
        connection.prepareStatement(
            """
            INSERT INTO workhorse.task_event(task_id,attempt,event_type,details)
              VALUES (?::uuid,?::integer,'batch_dispatched',jsonb_build_object(
                'batch_id','dashboard-semantic-batch','members',jsonb_build_array(
                  jsonb_build_object('task_id',?::uuid,'attempt',?::integer))))
            """)) {
      statement.setString(1, taskId);
      statement.setLong(2, attempt);
      statement.setString(3, taskId);
      statement.setLong(4, attempt);
      statement.execute();
    }

    // Outlast the queue health cache, so the next read sees the policies.
    Thread.sleep(3_100);
    Map<String, @Nullable Object> queues = rpc(server, harness, "queues", null);
    Map<String, @Nullable Object> demo = null;
    for (Object row : (List<?>) Objects.requireNonNull(queues.get("queues"))) {
      if ("conformance-demo".equals(object(row).get("queue"))) {
        demo = object(row);
      }
    }
    assertNotNull(demo);
    Map<String, @Nullable Object> concurrency = object(demo.get("concurrencyPolicy"));
    assertEquals(7L, concurrency.get("maxActive"));
    assertEquals(2L, concurrency.get("maxActivePerKey"));
    Map<String, @Nullable Object> rate = object(demo.get("rateLimitPolicy"));
    assertEquals(Map.of("limit", 10L, "intervalMs", 1000L, "burst", 12L), rate.get("rate"));
    assertEquals(0.5, rate.get("availableTokens"));

    Map<String, @Nullable Object> detail = rpc(server, harness, "taskDetail", Map.of("id", taskId));
    assertEquals(7L, object(detail.get("concurrencyPolicy")).get("maxActive"));
    assertEquals(
        "dashboard-semantic-batch",
        object(((List<?>) Objects.requireNonNull(detail.get("batchExecutions"))).get(0)).get("id"));

    try (Statement statement = connection.createStatement()) {
      statement.execute(
          """
          WITH task AS (
            INSERT INTO workhorse.task(queue_name,task_type,payload,max_attempts)
            VALUES ('conformance-demo','conformance.retry-summary','{}',3) RETURNING id
          ) INSERT INTO workhorse.task_runtime(task_id,queue_name,state,current_attempt,run_at)
            SELECT id,'conformance-demo','scheduled',2,clock_timestamp()+interval '30 seconds' FROM task
          """);
    }
    Map<String, @Nullable Object> system = rpc(server, harness, "system", Map.of("window", "1h"));
    Map<String, @Nullable Object> storm = object(system.get("retryStorm"));
    long bucket =
        (Long)
            Objects.requireNonNull(
                object(((List<?>) Objects.requireNonNull(storm.get("buckets"))).get(0))
                    .get("count"));
    long topType =
        (Long)
            Objects.requireNonNull(
                object(((List<?>) Objects.requireNonNull(storm.get("topTypes"))).get(0))
                    .get("count"));
    assertTrue(bucket >= 1);
    assertTrue(topType >= 1);
  }

  private Map<String, @Nullable Object> rpc(
      TestServer server,
      Map<String, @Nullable Object> harness,
      String procedure,
      @Nullable Object input)
      throws Exception {
    Map<String, @Nullable Object> exchange = new LinkedHashMap<>();
    exchange.put("procedure", procedure);
    Map<String, @Nullable Object> request = new LinkedHashMap<>();
    request.put("json", input);
    exchange.put("request", request);
    TestServer.Response response = send(server, exchange, harness);
    assertEquals(200, response.status(), response.text());
    return object(object(Json.parse(response.text())).get("json"));
  }

  private void exchange(
      TestServer server,
      Map<String, @Nullable Object> exchange,
      Map<String, @Nullable Object> harness)
      throws Exception {
    String id = (String) Objects.requireNonNull(exchange.get("id"));
    TestServer.Response response = send(server, exchange, harness);
    // A servlet container may drop the optional space after the `;` of the media type.
    assertEquals(
        "application/json;charset=utf-8",
        response.header("Content-Type").replace(" ", "").toLowerCase(java.util.Locale.ROOT),
        id);
    Map<String, @Nullable Object> expect = object(exchange.get("expect"));
    assertEquals(
        number(expect.get("status")),
        BigDecimal.valueOf(response.status()),
        id + ": " + response.text());
    Object body = Json.parse(response.text());
    assertValue(expect.get("body"), body, id);
    Map<String, @Nullable Object> capture = Json.object(exchange.get("capture"));
    if (capture != null) {
      capture.forEach(
          (name, pointer) ->
              references.put(name, read(body, (String) Objects.requireNonNull(pointer))));
    }
  }

  private TestServer.Response send(
      TestServer server,
      Map<String, @Nullable Object> exchange,
      Map<String, @Nullable Object> harness)
      throws Exception {
    String origin = (String) Objects.requireNonNull(harness.get("origin"));
    byte[] body = Json.write(resolve(exchange.get("request"))).getBytes(StandardCharsets.UTF_8);
    Map<String, String> headers = new LinkedHashMap<>();
    headers.put(
        "Host",
        "foreign".equals(exchange.get("host"))
            ? "attacker.conformance.test"
            : origin.substring("http://".length()));
    headers.put("Content-Type", "application/json");
    Object mode = Objects.requireNonNullElse(exchange.get("origin"), "same");
    if (mode.equals("same")) {
      headers.put("Origin", origin);
    } else if (mode.equals("cross")) {
      headers.put("Origin", (String) Objects.requireNonNull(harness.get("crossOrigin")));
    }
    return server.request(
        (String) Objects.requireNonNullElse(exchange.get("method"), "POST"),
        harness.get("basePath") + "/rpc/dashboard/" + exchange.get("procedure"),
        headers,
        body);
  }

  /** Runs one seed statement, checks its rows, and captures the values it names. */
  private void seed(Connection connection, Map<String, @Nullable Object> step) throws Exception {
    String sql = (String) Objects.requireNonNull(step.get("sql"));
    List<@Nullable String> parameters = new ArrayList<>();
    if (step.get("parameters") instanceof List<?> values) {
      for (Object value : values) {
        Object resolved = resolve(value);
        parameters.add(
            resolved == null
                ? null
                : resolved instanceof Map<?, ?> || resolved instanceof List<?>
                    ? Json.write(resolved)
                    : resolved instanceof String text ? text : Json.write(resolved));
      }
    }
    boolean with = sql.stripLeading().regionMatches(true, 0, "WITH", 0, 4);
    String statement =
        with ? sql : "WITH step AS (" + sql + ") SELECT to_jsonb(step)::text AS row FROM step";
    List<Integer> order = new ArrayList<>();
    Matcher matcher = PLACEHOLDER.matcher(statement);
    StringBuilder jdbc = new StringBuilder();
    while (matcher.find()) {
      order.add(Integer.parseInt(matcher.group(1)));
      matcher.appendReplacement(jdbc, "?");
    }
    matcher.appendTail(jdbc);
    List<@Nullable Object> rows = new ArrayList<>();
    try (PreparedStatement prepared = connection.prepareStatement(jdbc.toString())) {
      for (int index = 0; index < order.size(); index++) {
        // An untyped parameter, as libpq sends text, so PostgreSQL infers its type.
        prepared.setObject(index + 1, parameters.get(order.get(index) - 1), Types.OTHER);
      }
      try (ResultSet result = prepared.executeQuery()) {
        ResultSetMetaData metadata = result.getMetaData();
        while (result.next()) {
          if (with) {
            Map<String, @Nullable Object> row = new LinkedHashMap<>();
            for (int column = 1; column <= metadata.getColumnCount(); column++) {
              Object value = result.getObject(column);
              row.put(
                  metadata.getColumnLabel(column),
                  value instanceof Integer number
                      ? Long.valueOf(number)
                      : value instanceof OffsetDateTime || value instanceof java.sql.Timestamp
                          ? result.getString(column)
                          : value);
            }
            rows.add(row);
          } else {
            rows.add(Json.parse(Objects.requireNonNull(result.getString("row"))));
          }
        }
      }
    }
    Map<String, @Nullable Object> expect = Json.object(step.get("expect"));
    assertValue(expect == null ? List.of() : expect.get("rows"), rows, "seed/" + step.get("id"));
    Map<String, @Nullable Object> capture = Json.object(step.get("capture"));
    if (capture != null) {
      capture.forEach(
          (name, pointer) ->
              references.put(name, read(rows, (String) Objects.requireNonNull(pointer))));
    }
  }

  private @Nullable Object resolve(@Nullable Object value) {
    if (value instanceof List<?> items) {
      List<@Nullable Object> resolved = new ArrayList<>();
      items.forEach(item -> resolved.add(resolve(item)));
      return resolved;
    }
    Map<String, @Nullable Object> object = Json.object(value);
    if (object == null) {
      return value;
    }
    if (object.size() == 1 && object.get("$ref") instanceof String reference) {
      if (!references.containsKey(reference)) {
        fail("unknown reference " + reference);
      }
      return references.get(reference);
    }
    Map<String, @Nullable Object> resolved = new LinkedHashMap<>();
    object.forEach((key, item) -> resolved.put(key, resolve(item)));
    return resolved;
  }

  private static @Nullable Object read(@Nullable Object value, String pointer) {
    Object current = value;
    for (String segment : pointer.split("\\.", -1)) {
      current =
          current instanceof List<?> items
              ? items.get(Integer.parseInt(segment))
              : object(current).get(segment);
    }
    return current;
  }

  private void assertValue(@Nullable Object expected, @Nullable Object actual, String location) {
    Map<String, @Nullable Object> object = Json.object(expected);
    if (object != null) {
      if (object.containsKey("$ref")) {
        Object reference = references.get((String) Objects.requireNonNull(object.get("$ref")));
        assertTrue(
            same(reference, actual), location + " expected " + reference + ", received " + actual);
      } else if (object.get("$type") instanceof String kind) {
        boolean accepted =
            switch (kind) {
              case "any" -> true;
              case "uuid" -> actual instanceof String text && UUID_SHAPE.matcher(text).matches();
              case "timestamp" ->
                  actual instanceof String text
                      && TIMESTAMP.matcher(text).matches()
                      && OffsetDateTime.parse(text) != null;
              case "string" -> actual instanceof String;
              case "integer" -> actual instanceof Long || actual instanceof BigInteger;
              case "number" ->
                  actual instanceof Long
                      || actual instanceof BigInteger
                      || actual instanceof Double;
              case "boolean" -> actual instanceof Boolean;
              default -> false;
            };
        assertTrue(accepted, location + " expected " + kind + ", received " + actual);
      } else {
        Map<String, @Nullable Object> map = Json.object(actual);
        assertNotNull(map, location + " expected an object, received " + actual);
        assertEquals(
            new java.util.TreeSet<>(object.keySet()),
            new java.util.TreeSet<>(map.keySet()),
            location);
        object.forEach((key, value) -> assertValue(value, map.get(key), location + "." + key));
      }
    } else if (expected instanceof List<?> items) {
      assertTrue(actual instanceof List<?>, location + " expected an array, received " + actual);
      List<?> list = (List<?>) actual;
      assertEquals(items.size(), list.size(), location + " length; received " + actual);
      for (int index = 0; index < items.size(); index++) {
        assertValue(items.get(index), list.get(index), location + "[" + index + "]");
      }
    } else {
      assertTrue(
          same(expected, actual), location + " expected " + expected + ", received " + actual);
    }
  }

  private static boolean same(@Nullable Object left, @Nullable Object right) {
    BigDecimal leftNumber = number(left);
    BigDecimal rightNumber = number(right);
    if (leftNumber != null || rightNumber != null) {
      return leftNumber != null && rightNumber != null && leftNumber.compareTo(rightNumber) == 0;
    }
    return Objects.equals(left, right);
  }

  private static @Nullable BigDecimal number(@Nullable Object value) {
    return switch (value) {
      case Long number -> BigDecimal.valueOf(number);
      case Integer number -> BigDecimal.valueOf(number);
      case BigInteger number -> new BigDecimal(number);
      case Double number -> BigDecimal.valueOf(number);
      case null, default -> null;
    };
  }

  private static Map<String, @Nullable Object> object(@Nullable Object value) {
    Map<String, @Nullable Object> object = Json.object(value);
    if (object == null) {
      throw new AssertionError("expected a JSON object, received " + value);
    }
    return object;
  }
}
