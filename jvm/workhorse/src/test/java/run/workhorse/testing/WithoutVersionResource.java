package run.workhorse.testing;

import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.net.URLClassLoader;
import java.util.Collections;
import java.util.Enumeration;
import org.jspecify.annotations.Nullable;
import run.workhorse.internal.SdkVersion;

/**
 * A class loader that loads the SDK classes again, but hides the version resource that the build
 * writes. A test uses it to call an SDK entry point as it runs when the build wrote no version, for
 * example after a compile that did not run Gradle.
 *
 * <p>The loader loads each {@code run.workhorse} class itself, apart from this test support
 * package. It gets all other classes from the test class loader, so a test can give an
 * OpenTelemetry instance to an SDK class that this loader loaded.
 */
public final class WithoutVersionResource extends URLClassLoader {
  /** The class path name of the resource that this loader hides. */
  public static final String RESOURCE = "run/workhorse/version.properties";

  public WithoutVersionResource() {
    super(
        new URL[] {SdkVersion.class.getProtectionDomain().getCodeSource().getLocation()},
        WithoutVersionResource.class.getClassLoader());
  }

  /** The class {@code name}, loaded and initialized by this loader. */
  public Class<?> sdkClass(String name) throws ClassNotFoundException {
    Class<?> loaded = Class.forName(name, true, this);
    if (loaded.getClassLoader() != this) {
      throw new IllegalStateException(name + " is not an SDK class of this loader");
    }
    return loaded;
  }

  @Override
  protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
    if (!name.startsWith("run.workhorse.") || name.startsWith("run.workhorse.testing.")) {
      return super.loadClass(name, resolve);
    }
    synchronized (getClassLoadingLock(name)) {
      Class<?> loaded = findLoadedClass(name);
      if (loaded == null) {
        loaded = findClass(name);
      }
      if (resolve) {
        resolveClass(loaded);
      }
      return loaded;
    }
  }

  @Override
  public @Nullable URL getResource(String name) {
    return RESOURCE.equals(name) ? null : super.getResource(name);
  }

  @Override
  public Enumeration<URL> getResources(String name) throws IOException {
    return RESOURCE.equals(name) ? Collections.emptyEnumeration() : super.getResources(name);
  }

  @Override
  public @Nullable InputStream getResourceAsStream(String name) {
    return RESOURCE.equals(name) ? null : super.getResourceAsStream(name);
  }
}
