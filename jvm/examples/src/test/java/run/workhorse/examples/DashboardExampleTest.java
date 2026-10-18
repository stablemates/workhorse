package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;

import jakarta.servlet.http.HttpServletRequest;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.testing.ScratchDatabase;

/** Runs the Java and Kotlin dashboard snippets in an embedded Tomcat. */
@ExtendWith(ScratchDatabase.class)
class DashboardExampleTest {
  /** The application session of the test: the {@code X-User} header. */
  private static @Nullable String session(HttpServletRequest request) {
    return request.getHeader("X-User");
  }

  @Test
  void theJavaFilterServesItsPathAndPassesTheOthers() throws Exception {
    try (ExampleServer server =
        new ExampleServer(
            context ->
                new DashboardExample(ExampleDatabase.dataSource(), DashboardExampleTest::session)
                    .register(context))) {
      assertServes(server);
    }
  }

  @Test
  void theKotlinFilterServesItsPathAndPassesTheOthers() throws Exception {
    try (ExampleServer server =
        new ExampleServer(
            context ->
                DashboardExampleKt.registerDashboard(
                    context, ExampleDatabase.dataSource(), DashboardExampleTest::session))) {
      assertServes(server);
    }
  }

  private static void assertServes(ExampleServer server) throws Exception {
    assertEquals(401, server.get("/workhorse", ""), "deny answers 401");
    assertEquals(302, server.get("/workhorse", "dana"), "a principal reaches the dashboard");
    assertEquals(200, server.get("/other", ""), "another path reaches the application");
  }
}
