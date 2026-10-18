package dev.stablemates.workhorse.dashboard;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** The jar carries the committed browser bundle as class path resources. */
class BundleTest {
  @Test
  void loadsTheManifestAndTheArchiveFromTheClassPath() {
    Map<String, Object> manifest = Bundle.manifest();
    assertEquals(1L, manifest.get("formatVersion"));
    assertEquals(
        "read-surface-" + manifest.get("readSurfaceVersion") + ".tar.gz", manifest.get("archive"));

    Map<String, byte[]> files = Bundle.files();
    byte[] index = files.get("app/index.html");
    assertNotNull(index);
    String html = new String(index, StandardCharsets.UTF_8);
    assertTrue(html.contains("/*__WORKHORSE_RUNTIME_CONFIG__*/"));
    assertTrue(html.contains("<!--__WORKHORSE_BROWSER_MODULES__-->"));
    assertTrue(files.keySet().stream().anyMatch(name -> name.startsWith("app/assets/")));
  }
}
