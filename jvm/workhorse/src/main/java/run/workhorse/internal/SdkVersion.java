package run.workhorse.internal;

import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.Properties;
import org.jspecify.annotations.Nullable;

/**
 * The SDK version that a worker registers as {@code sdk_version}.
 *
 * <p>The build writes {@code project.version}, the train version, into the class path resource
 * {@code run/workhorse/version.properties}. The other SDKs compile their version into a source
 * constant, so they always know it. The JVM SDK reads the resource instead, because Gradle owns the
 * train version. The resource is present in the jar and in every Gradle build output, also on the
 * module path, where a jar manifest does not give a {@code Package} its implementation version.
 *
 * <p>If the resource is absent or empty, for example after a compile that did not run Gradle, the
 * version is {@code null}. The registry stores {@code NULL}, which tells an operator that the
 * version is unknown. A guessed string would look like a real version.
 */
public final class SdkVersion {
  private static final String RESOURCE = "/run/workhorse/version.properties";
  private static final @Nullable String CURRENT =
      read(SdkVersion.class.getResourceAsStream(RESOURCE));

  private SdkVersion() {}

  /** The train version of this SDK, or {@code null} if the build wrote no version resource. */
  public static @Nullable String current() {
    return CURRENT;
  }

  /** Reads the {@code version} property, or {@code null} when the stream is absent or empty. */
  static @Nullable String read(@Nullable InputStream resource) {
    if (resource == null) {
      return null;
    }
    try (InputStream stream = resource) {
      Properties properties = new Properties();
      properties.load(new InputStreamReader(stream, StandardCharsets.UTF_8));
      String version = properties.getProperty("version", "").trim();
      return version.isEmpty() ? null : version;
    } catch (IOException error) {
      return null;
    }
  }
}
