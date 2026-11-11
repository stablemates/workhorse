package run.workhorse.conformance;

import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.sql.Connection;
import java.sql.DriverManager;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Properties;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;
import run.workhorse.internal.Json;

/**
 * The entry point of {@code scripts/cross-sdk-replay.ts}. It runs one phase of a {@code
 * durable-script} fixture against a database that the harness owns, and the harness sets its
 * environment.
 */
class CrossSdkPhaseTest {
  @Test
  @SuppressWarnings("unchecked")
  void runsOnePhaseOfACrossSdkDurableScriptFixture() throws Exception {
    String phase = System.getenv("WORKHORSE_CROSS_SDK_PHASE");
    assumeTrue(phase != null, "scripts/cross-sdk-replay.ts sets WORKHORSE_CROSS_SDK_PHASE");
    String id = Objects.requireNonNull(System.getenv("WORKHORSE_CROSS_SDK_FIXTURE"));
    URI uri = URI.create(Objects.requireNonNull(System.getenv("WORKHORSE_CROSS_SDK_DATABASE_URL")));
    Properties credentials = new Properties();
    String userInfo = uri.getRawUserInfo();
    if (userInfo != null) {
      String[] parts = userInfo.split(":", 2);
      credentials.setProperty("user", URLDecoder.decode(parts[0], StandardCharsets.UTF_8));
      if (parts.length > 1) {
        credentials.setProperty("password", URLDecoder.decode(parts[1], StandardCharsets.UTF_8));
      }
    }
    String url =
        "jdbc:postgresql://"
            + uri.getHost()
            + (uri.getPort() < 0 ? "" : ":" + uri.getPort())
            + uri.getPath()
            // Query options, such as sslmode, reach pgjdbc as the scratch-database helper passes
            // them.
            + (uri.getRawQuery() == null ? "" : "?" + uri.getRawQuery());
    List<Object> fixtures =
        (List<Object>)
            Objects.requireNonNull(
                Json.parse(
                    Files.readString(ProtocolConformanceTest.protocol().resolve("runtime.json"))));
    Map<String, @Nullable Object> fixture =
        fixtures.stream()
            .map(entry -> (Map<String, @Nullable Object>) entry)
            .filter(entry -> id.equals(entry.get("id")))
            .findFirst()
            .orElseThrow();
    try (Connection connection = DriverManager.getConnection(url, credentials)) {
      new DurableScript(() -> DriverManager.getConnection(url, credentials), connection)
          .run(fixture, phase);
    }
  }
}
