package run.workhorse.internal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.ref.Reference;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

/** SM-1569: the registry of the shared listener and heartbeat of each {@code DataSource}. */
@Timeout(value = 60, unit = TimeUnit.SECONDS)
class IdentityRegistryTest {
  /** A key that equals every other key, as two equal pool configurations can. */
  private static final class EqualKey {
    @Override
    public boolean equals(@Nullable Object other) {
      return other instanceof EqualKey;
    }

    @Override
    public int hashCode() {
      return 1;
    }
  }

  /** A shared value that holds its key strongly, as a heartbeat holds its {@code DataSource}. */
  private record Holder(Object key) {}

  @Test
  void matchesKeysByIdentityNotByEquals() {
    IdentityRegistry<Object, Holder> registry = new IdentityRegistry<>();
    EqualKey first = new EqualKey();
    EqualKey second = new EqualKey();
    assertSame(registry.get(first, Holder::new), registry.get(first, Holder::new));
    assertNotSame(registry.get(first, Holder::new), registry.get(second, Holder::new));
  }

  /**
   * The registry holds each key and each value only through a weak reference, so it keeps neither
   * alive. The test reads the stored references instead of waiting for the garbage collector, which
   * gives no time bound.
   */
  @Test
  void holdsEveryKeyAndValueThroughAWeakReference() {
    IdentityRegistry<Object, Holder> registry = new IdentityRegistry<>();
    Object first = new Object();
    Object second = new Object();
    Holder firstValue = registry.get(first, Holder::new);
    Holder secondValue = registry.get(second, Holder::new);
    List<Reference<?>> references = registry.references();
    assertEquals(4, references.size(), "two keys and two values");
    for (Reference<?> reference : references) {
      assertEquals(
          WeakReference.class,
          weakBase(reference.getClass()),
          reference.getClass() + " is not a weak reference");
    }
    List<Object> referents = new ArrayList<>();
    references.forEach(reference -> referents.add(reference.get()));
    assertTrue(referents.contains(first) && referents.contains(firstValue));
    assertTrue(referents.contains(second) && referents.contains(secondValue));
  }

  /**
   * An entry whose key the collector cleared leaves the registry. The test clears and enqueues the
   * key reference itself, as the collector does, so the result does not depend on a collection.
   */
  @Test
  void dropsAnEntryWhoseKeyWasCleared() {
    IdentityRegistry<Object, Holder> registry = new IdentityRegistry<>();
    Object kept = new Object();
    Object dropped = new Object();
    registry.get(kept, Holder::new);
    registry.get(dropped, Holder::new);
    assertEquals(2, registry.size());
    for (Reference<?> reference : registry.references()) {
      @SuppressWarnings("unchecked")
      Reference<Object> typed = (Reference<Object>) reference;
      if (typed.refersTo(dropped)) {
        reference.clear();
        reference.enqueue();
      }
    }
    assertEquals(1, registry.size(), "the cleared entry left the registry");
    assertSame(registry.get(kept, Holder::new), registry.get(kept, Holder::new));
  }

  /** The nearest {@link WeakReference} superclass of {@code type}, or the type itself. */
  private static Class<?> weakBase(Class<?> type) {
    for (Class<?> current = type; current != null; current = current.getSuperclass()) {
      if (current.equals(WeakReference.class)) {
        return current;
      }
    }
    return type;
  }
}
