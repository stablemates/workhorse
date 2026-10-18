package run.workhorse.internal;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

class PgjdbcVersionTest {
  @Test
  void acceptsTheDriverOnTheClassPath() {
    assertDoesNotThrow(() -> PgjdbcVersion.require());
  }

  @Test
  void acceptsTheFloorAndEveryLaterRelease() {
    for (String version :
        new String[] {"42.7.12", "42.7.14", "42.8.0", "43.0.0", "42.7.13-SNAPSHOT"}) {
      assertDoesNotThrow(() -> PgjdbcVersion.require(version), version);
    }
  }

  @Test
  void refusesAReleaseBelowTheFloor() {
    for (String version : new String[] {"42.7.11", "42.7.8", "42.6.2", "41.9.9"}) {
      IllegalStateException error =
          assertThrows(IllegalStateException.class, () -> PgjdbcVersion.require(version));
      assertEquals(
          "Workhorse needs PgJDBC 42.7.12 or later, but found PgJDBC "
              + version
              + ". In Spring Boot, use Spring Boot 4.0.8 or later, or set the postgresql.version"
              + " property to 42.7.12 or later.",
          error.getMessage());
    }
  }

  @Test
  void refusesAVersionItCannotRead() {
    assertThrows(IllegalStateException.class, () -> PgjdbcVersion.require("unknown"));
  }
}
