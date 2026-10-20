package run.workhorse.dashboard;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.logging.Handler;
import java.util.logging.LogRecord;
import java.util.logging.Logger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.postgresql.util.PSQLException;
import org.postgresql.util.PSQLState;
import run.workhorse.ConnectionSource;
import run.workhorse.internal.Json;
import run.workhorse.testing.ScratchDataSource;
import run.workhorse.testing.ScratchDatabase;

/** The dashboard filter in an embedded Tomcat: mounting, authorization, and procedure calls. */
@ExtendWith(ScratchDatabase.class)
class DashboardServletTest {
  private final ConnectionSource source = ConnectionSource.of(new ScratchDataSource(true));

  private Dashboard.Builder builder(DashboardAuthorizer authorize) {
    return Dashboard.builder(source, authorize).environment("servlet-test");
  }

  private Dashboard.Builder builder() {
    return builder(request -> DashboardAuthorization.principal("operator"));
  }

  @Test
  void mountsUnderAPathPrefixAndPassesOtherRequestsThrough() throws Exception {
    Dashboard dashboard = builder().path("/ops/workhorse/").build();
    assertEquals("/ops/workhorse", dashboard.basePath());
    try (TestServer server = new TestServer("/app", dashboard)) {
      TestServer.Response root = server.get("/app/ops/workhorse");
      assertEquals(302, root.status());
      assertEquals("/app/ops/workhorse/tasks", root.header("Location"));
      assertEquals(302, server.get("/app/ops/workhorse/").status());

      TestServer.Response shell = server.get("/app/ops/workhorse/tasks/abc");
      assertEquals(200, shell.status());
      assertTrue(shell.header("Content-Type").startsWith("text/html"));
      assertTrue(shell.text().contains("\"basePath\":\"/app/ops/workhorse\""), shell.text());
      assertTrue(shell.text().contains("\"rpcUrl\":\"/app/ops/workhorse/rpc\""));

      TestServer.Response meta =
          server.post("/app/ops/workhorse/rpc/dashboard/meta", "{\"json\":null}");
      assertEquals(200, meta.status(), meta.text());
      assertEquals("{\"json\":{\"environment\":\"servlet-test\"}}", meta.text());

      for (String outside :
          List.of("/app/elsewhere", "/app/ops/workhorsex", "/app/workhorse", "/app/ops")) {
        TestServer.Response passed = server.get(outside);
        assertEquals(200, passed.status(), outside);
        assertEquals("host", passed.text(), outside);
      }
    }
  }

  @Test
  void servesABundledAssetWithAnImmutableCachePolicy() throws Exception {
    String asset =
        Bundle.files().keySet().stream()
            .filter(name -> name.startsWith("app/assets/") && name.endsWith(".js"))
            .findFirst()
            .orElseThrow();
    try (TestServer server = new TestServer("", builder().build())) {
      TestServer.Response response = server.get("/workhorse/" + asset.substring("app/".length()));
      assertEquals(200, response.status());
      assertEquals("public, max-age=31536000, immutable", response.header("Cache-Control"));
      assertTrue(response.header("Content-Type").startsWith("text/javascript"));
      assertEquals(404, server.get("/workhorse/assets/missing.js").status());
    }
  }

  @Test
  void refusesAHostOutsideAllowedHostsBeforeAuthorizing() throws Exception {
    AtomicInteger calls = new AtomicInteger();
    Dashboard dashboard =
        builder(
                request -> {
                  calls.incrementAndGet();
                  return DashboardAuthorization.allow();
                })
            .allowedHosts(List.of("Dashboard.test"))
            .build();
    try (TestServer server = new TestServer("", dashboard)) {
      TestServer.Response foreign =
          server.request("GET", "/workhorse/tasks", Map.of("Host", "evil.test"), new byte[0]);
      assertEquals(421, foreign.status());
      assertEquals("{\"error\":\"Misdirected Request\"}", foreign.text());
      assertEquals(0, calls.get());

      TestServer.Response allowed =
          server.request(
              "GET", "/workhorse/tasks", Map.of("Host", "DASHBOARD.test:80"), new byte[0]);
      assertEquals(200, allowed.status());
      assertEquals(1, calls.get());
    }
    for (String entry :
        List.of("user@dashboard.test", "dashboard.test/path", "dashboard.test:", "")) {
      assertThrows(
          IllegalArgumentException.class,
          () -> builder().allowedHosts(List.of(entry)).build(),
          entry);
    }
  }

  @Test
  void answers401OnADenyAndUsesTheAuditActorOnlyForABareAllow() throws Exception {
    try (TestServer denied =
        new TestServer("", builder(r -> DashboardAuthorization.deny()).build())) {
      TestServer.Response response = denied.get("/workhorse/tasks");
      assertEquals(401, response.status());
      assertEquals("{\"error\":\"Unauthorized\"}", response.text());
    }
    Dashboard allowed =
        builder(request -> DashboardAuthorization.allow()).auditActor("ops-bot").build();
    try (TestServer server = new TestServer("", allowed)) {
      assertTrue(server.get("/workhorse/tasks").text().contains("\"auditActor\":\"ops-bot\""));
    }
    try (TestServer server = new TestServer("", builder().auditActor("ops-bot").build())) {
      assertTrue(server.get("/workhorse/tasks").text().contains("\"auditActor\":\"operator\""));
    }
  }

  // SM-1458: as in Ruby and Python, the authorizer can give a complete response.
  @Test
  void sendsTheAuthorizersResponseAsIsAndDoesNoOtherWork() throws Exception {
    ConnectionSource unreachable =
        new ConnectionSource() {
          @Override
          public Connection acquire() throws SQLException {
            throw new SQLException("the dashboard must not reach the database");
          }

          @Override
          public void release(Connection connection, boolean transactional) {}
        };
    Dashboard redirecting =
        Dashboard.builder(
                unreachable,
                request ->
                    DashboardAuthorization.response(
                        302, Map.of("Location", "/login?next=/workhorse"), new byte[0]))
            .build();
    try (TestServer server = new TestServer("", redirecting)) {
      for (String path :
          List.of("/workhorse", "/workhorse/tasks", "/workhorse/rpc/dashboard/meta")) {
        TestServer.Response response = server.get(path);
        assertEquals(302, response.status(), path);
        assertEquals("/login?next=/workhorse", response.header("Location"), path);
      }
    }
    Dashboard forbidding =
        Dashboard.builder(
                unreachable,
                request ->
                    DashboardAuthorization.response(
                        403,
                        Map.of("Content-Type", "text/plain; charset=utf-8"),
                        "forbidden".getBytes(StandardCharsets.UTF_8)))
            .build();
    try (TestServer server = new TestServer("", forbidding)) {
      TestServer.Response response = server.get("/workhorse/tasks");
      assertEquals(403, response.status());
      assertTrue(response.header("Content-Type").startsWith("text/plain"));
      assertEquals("forbidden", response.text());
    }
  }

  // SM-1473: as in the other hosts, a driver error stays in the log and out of the 503 body.
  @Test
  void answers503WithAGenericBodyAndLogsAnUnexpectedCompatibilityFailure() throws Exception {
    ConnectionSource unreachable =
        new ConnectionSource() {
          @Override
          public Connection acquire() throws SQLException {
            throw new PSQLException(
                "Connection to db.example.invalid:5432 refused.",
                PSQLState.CONNECTION_UNABLE_TO_CONNECT);
          }

          @Override
          public void release(Connection connection, boolean transactional) {}
        };
    List<LogRecord> records = new CopyOnWriteArrayList<>();
    Handler capture =
        new Handler() {
          @Override
          public void publish(LogRecord logRecord) {
            records.add(logRecord);
          }

          @Override
          public void flush() {}

          @Override
          public void close() {}
        };
    Logger logger = Logger.getLogger(Dashboard.class.getName());
    boolean parentHandlers = logger.getUseParentHandlers();
    logger.setUseParentHandlers(false);
    logger.addHandler(capture);
    try (TestServer server =
        new TestServer(
            "",
            Dashboard.builder(unreachable, request -> DashboardAuthorization.principal("operator"))
                .build())) {
      for (String path : List.of("/workhorse/tasks", "/workhorse/rpc/dashboard/meta")) {
        TestServer.Response response =
            path.contains("/rpc/") ? server.post(path, "{\"json\":null}") : server.get(path);
        assertEquals(503, response.status(), path);
        assertEquals(
            "{\"error\":\"Unable to verify Workhorse schema compatibility because the database"
                + " query failed.\"}",
            response.text(),
            path);
        assertFalse(response.text().contains("db.example.invalid"), path);
        assertFalse(response.text().contains("5432"), path);
      }
    } finally {
      logger.removeHandler(capture);
      logger.setUseParentHandlers(parentHandlers);
    }
    assertTrue(
        records.stream()
            .anyMatch(
                logged ->
                    logged.getThrown() != null
                        && String.valueOf(logged.getThrown().getMessage())
                            .contains("db.example.invalid:5432")),
        "the driver error reaches the log");
  }

  @Test
  void keepsTheContentLengthOfTheAuthorizersResponse() throws Exception {
    Dashboard dashboard =
        builder(
                request ->
                    DashboardAuthorization.response(
                        401, Map.of("content-length", "12"), new byte[0]))
            .build();
    try (TestServer server = new TestServer("", dashboard)) {
      TestServer.Response head =
          server.request("HEAD", "/workhorse/tasks", Map.of("Host", "localhost"), new byte[0]);
      assertEquals(401, head.status());
      assertEquals("12", head.header("Content-Length"));
    }
    Dashboard plain =
        builder(
                request ->
                    DashboardAuthorization.response(
                        403, Map.of(), "no".getBytes(StandardCharsets.UTF_8)))
            .build();
    try (TestServer server = new TestServer("", plain)) {
      assertEquals("2", server.get("/workhorse/tasks").header("Content-Length"));
    }
  }

  @Test
  void validatesAndCopiesAnAuthorizationResponse() {
    for (int status : new int[] {99, 600}) {
      assertThrows(
          IllegalArgumentException.class,
          () -> DashboardAuthorization.response(status, Map.of(), new byte[0]),
          Integer.toString(status));
    }
    byte[] body = {1, 2};
    DashboardAuthorization.Response response =
        (DashboardAuthorization.Response) DashboardAuthorization.response(401, Map.of(), body);
    body[0] = 9;
    assertEquals(1, response.body()[0]);
    response.body()[1] = 9;
    assertEquals(2, response.body()[1]);
  }

  @Test
  void escapesTheRuntimeConfigurationAndBrowserModules() throws Exception {
    Dashboard dashboard =
        builder(request -> DashboardAuthorization.principal("</script><b>&\u2028"))
            .browserModules(List.of("/x.js?a=1&b=\"2\""))
            .enqueueTest((input, actor) -> null)
            .build();
    try (TestServer server = new TestServer("", dashboard)) {
      String html = server.get("/workhorse/tasks").text();
      assertTrue(html.contains("\\u003c/script\\u003e\\u003cb\\u003e\\u0026\\u2028"), html);
      assertFalse(html.contains("</script><b>"));
      assertTrue(
          html.contains("<script type=\"module\" src=\"/x.js?a=1&amp;b=&quot;2&quot;\"></script>"));
      assertTrue(html.contains("\"demoTools\":true"));
    }
  }

  @Test
  void answersProcedureErrorsWithTheRpcEnvelope() throws Exception {
    Dashboard dashboard =
        builder()
            .procedures(
                Map.of(
                    "queues",
                    (input, actor) -> {
                      throw new DashboardRpcException(
                          409, "CONFLICT", "busy", Map.of("retry", true));
                    },
                    "taskCounts",
                    (input, actor) -> {
                      throw new IllegalStateException("secret detail");
                    },
                    "workers",
                    (input, actor) -> Map.of("actor", String.valueOf(actor)),
                    "humanWaits",
                    (input, actor) -> new Object()))
            .build();
    try (TestServer server = new TestServer("", dashboard)) {
      String rpc = "/workhorse/rpc/dashboard/";
      assertEquals(
          "{\"json\":{\"defined\":false,\"code\":\"CONFLICT\",\"status\":409,\"message\":\"busy\",\"data\":{\"retry\":true}}}",
          server.post(rpc + "queues", "{}").text());
      TestServer.Response failed = server.post(rpc + "taskCounts", "{}");
      assertEquals(500, failed.status());
      assertFalse(failed.text().contains("secret"));
      assertEquals(
          "{\"json\":{\"actor\":\"operator\"}}", server.post(rpc + "workers", "{}").text());

      TestServer.Response unencodable = server.post(rpc + "humanWaits", "{}");
      assertEquals(500, unencodable.status());
      assertTrue(unencodable.text().contains("\"Internal server error\""));

      for (String page : List.of("0", "-9223372036854775809")) {
        TestServer.Response small =
            server.post(rpc + "tasks", "{\"json\":{\"page\":" + page + "}}");
        assertEquals(400, small.status(), page);
        assertTrue(small.text().contains("\"code\":\"too_small\""), small.text());
      }

      assertEquals(405, server.get(rpc + "meta").status());
      assertEquals(404, server.post(rpc + "nothing", "{}").status());
      TestServer.Response optional = server.post(rpc + "enqueueTest", "{}");
      assertEquals(403, optional.status());
      assertTrue(optional.text().contains("This procedure is not available"));
      assertEquals(400, server.post(rpc + "meta", "[1]").status());
      assertEquals(400, server.post(rpc + "meta", "{").status());
      assertEquals(400, server.post(rpc + "meta", "{\"json\":{}}").status());

      TestServer.Response large =
          server.request(
              "POST",
              rpc + "meta",
              Map.of("Host", "localhost:" + server.port(), "Content-Length", "3000000"),
              new byte[0]);
      assertEquals(413, large.status());
      assertEquals(
          "PAYLOAD_TOO_LARGE",
          Json.object(Json.object(Json.parse(large.text())).get("json")).get("code"));
    }
  }

  @Test
  void refusesALongNumberInTheRequestBodyQuickly() throws Exception {
    try (TestServer server = new TestServer("", builder().build())) {
      String tasks = "/workhorse/rpc/dashboard/tasks";
      String limit = "1".repeat(1000);
      TestServer.Response accepted = server.post(tasks, "{\"json\":{\"page\":" + limit + "}}");
      assertFalse(accepted.text().contains("a number longer than"), accepted.text());

      TestServer.Response refused = server.post(tasks, "{\"json\":{\"page\":" + limit + "1}}");
      assertEquals(400, refused.status());
      assertTrue(refused.text().contains("a number longer than 1000 characters"), refused.text());

      // A body of about 2 MB with one integer. Without the limit, its parse takes many seconds.
      String body = "{\"json\":{\"page\":" + "9".repeat(2_000_000) + "}}";
      long started = System.nanoTime();
      TestServer.Response large = server.post(tasks, body);
      long elapsed = Duration.ofNanos(System.nanoTime() - started).toMillis();
      assertEquals(400, large.status());
      assertEquals(
          "BAD_REQUEST",
          Json.object(Json.object(Json.parse(large.text())).get("json")).get("code"));
      assertTrue(elapsed < 2000, "the dashboard answered after " + elapsed + " ms");
    }
  }

  @Test
  void readsTheEmptyBodyAsAnEmptyEnvelope() throws Exception {
    try (TestServer server = new TestServer("", builder().build())) {
      TestServer.Response response =
          server.request(
              "POST",
              "/workhorse/rpc/dashboard/meta",
              Map.of("Host", "localhost:" + server.port()),
              "".getBytes(StandardCharsets.UTF_8));
      assertEquals(200, response.status(), response.text());
    }
  }
}
