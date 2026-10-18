package run.workhorse.internal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

class SdkVersionTest {
  private static InputStream resource(String text) {
    return new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8));
  }

  @Test
  void readsTheTrainVersionThatTheBuildWrites() {
    assertEquals(System.getProperty("workhorse.version"), SdkVersion.current());
  }

  @Test
  void readsTheVersionProperty() {
    assertEquals("1.2.3", SdkVersion.read(resource("version= 1.2.3 \n")));
  }

  @Test
  void isNullWithoutAResourceOrAVersion() {
    assertNull(SdkVersion.read(null));
    assertNull(SdkVersion.read(resource("")));
    assertNull(SdkVersion.read(resource("version=\n")));
    assertNull(SdkVersion.read(resource("other=1.2.3\n")));
  }
}
