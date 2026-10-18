package run.workhorse.dashboard;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.io.Reader;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Properties;
import org.junit.jupiter.api.Test;
import run.workhorse.internal.SdkVersion;
import run.workhorse.testing.WithoutVersionResource;

/**
 * The dashboard reports {@code project.version} when the jar runs on the class path, and {@code
 * unknown} when the build wrote no version resource.
 */
class VersionTest {
  @Test
  void readsTheProjectVersionOnTheClassPath() throws Exception {
    // Gradle runs these tests on the class path, where the module has no descriptor.
    assertFalse(Dashboard.class.getModule().isNamed());
    Path schema = Path.of(System.getProperty("workhorse.schema"));
    Properties gradle = new Properties();
    try (Reader reader =
        Files.newBufferedReader(
            schema.getParent().getParent().getParent().resolve("jvm/gradle.properties"))) {
      gradle.load(reader);
    }
    assertEquals(gradle.getProperty("version"), Dashboard.version());
  }

  @Test
  void reportsTheSdkVersion() {
    assertNotNull(SdkVersion.current());
    assertEquals(SdkVersion.current(), Dashboard.version());
  }

  @Test
  void reportsUnknownWithoutTheVersionResource() throws Exception {
    try (WithoutVersionResource loader = new WithoutVersionResource()) {
      assertNull(loader.getResource(WithoutVersionResource.RESOURCE));
      Method version = loader.sdkClass(Dashboard.class.getName()).getDeclaredMethod("version");
      version.setAccessible(true);
      assertEquals("unknown", version.invoke(null));
    }
  }
}
