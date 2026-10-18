package run.workhorse.dashboard;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
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
