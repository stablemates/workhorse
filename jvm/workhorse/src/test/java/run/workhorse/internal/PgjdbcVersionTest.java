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
        new String[] {"42.7.8", "42.7.14", "42.8.0", "43.0.0", "42.7.9-SNAPSHOT"}) {
      assertDoesNotThrow(() -> PgjdbcVersion.require(version), version);
    }
  }

  @Test
  void refusesAReleaseBelowTheFloor() {
    for (String version : new String[] {"42.7.7", "42.6.2", "41.9.9"}) {
      IllegalStateException error =
          assertThrows(IllegalStateException.class, () -> PgjdbcVersion.require(version));
      assertEquals(
          "Workhorse needs PgJDBC 42.7.8 or later, but found PgJDBC " + version,
          error.getMessage());
    }
  }

  @Test
  void refusesAVersionItCannotRead() {
    assertThrows(IllegalStateException.class, () -> PgjdbcVersion.require("unknown"));
  }
}
