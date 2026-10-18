package dev.stablemates.workhorse.apisnapshot.fixture;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import org.jspecify.annotations.NullUnmarked;
import org.jspecify.annotations.Nullable;

/** One of each declaration the Java reader prints. */
public class Sample<T extends @Nullable Object> {
  public static final String NAME = "sample \"one\"";
  public static final long LIMIT = 10L;
  public final int count = 1;

  public Sample() {}

  protected Sample(String name) {}

  Sample(int hidden) {}

  public @Nullable String find(List<? extends T> items, String @Nullable [] names) {
    return null;
  }

  public Map<String, @Nullable Object> map(Object... values) {
    return Map.of();
  }

  public static <R extends Comparable<? super R>> R max(R first, R second) throws IOException {
    return first;
  }

  @Deprecated
  public void old() {}

  public @Nullable Sample<String>.Inner<Integer> inner() {
    return null;
  }

  /** An inner class of a generic class, whose type carries the owner's arguments. */
  public class Inner<U> {
    public @Nullable T owner() {
      return null;
    }
  }

  @NullUnmarked
  public void loose(String value) {}

  void packagePrivate() {}

  @SuppressWarnings("UnusedMethod")
  private void secret() {}

  /** A nested record. */
  public record Entry(String key, @Nullable Integer value) {}

  /** A sealed interface with its two cases. */
  public sealed interface Shape permits Circle, Square {
    double area();

    default String label() {
      return "shape";
    }
  }

  /** A permitted case. */
  public record Circle(double radius) implements Shape {
    @Override
    public double area() {
      return radius;
    }
  }

  /** A permitted case a caller may extend. */
  public static non-sealed class Square implements Shape {
    @Override
    public double area() {
      return 0;
    }
  }

  /** An enum. */
  public enum Mode {
    ON,
    OFF
  }

  /** A class outside the JSpecify scope of its package. */
  @NullUnmarked
  public static class Legacy {
    public void run(String value) {}
  }

  /** An annotation whose default is a primitive array. */
  public @interface Tag {
    int[] value() default {1, 2};
  }

  static class Hidden {}
}
