package dev.stablemates.workhorse.dashboard;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import java.io.Reader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Properties;
import org.junit.jupiter.api.Test;

/** The dashboard reports {@code project.version} when the jar runs on the class path. */
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
}
