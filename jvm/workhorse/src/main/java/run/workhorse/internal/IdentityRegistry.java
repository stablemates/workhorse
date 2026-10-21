package run.workhorse.internal;

import java.lang.ref.Reference;
import java.lang.ref.ReferenceQueue;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Function;
import org.jspecify.annotations.Nullable;

/**
 * The shared object of each key, such as the one heartbeat of a {@code DataSource} (ADR 0071). Keys
 * match by reference identity, never by {@code equals}: two pools that compare equal are still two
 * pools, and each one gets its own shared object. A wrapper of a pool is a key of its own.
 *
 * <p>The registry holds each key and each value through a weak reference, so it keeps neither
 * alive. A shared object usually holds its key, so a strong value would keep its weak key alive
 * forever. The callers that use a shared object keep it alive.
 */
final class IdentityRegistry<K, V> {
  private final ReentrantLock lock = new ReentrantLock();
  private final ReferenceQueue<K> cleared = new ReferenceQueue<>();
  private final Map<Key<K>, WeakReference<V>> entries = new HashMap<>();

  /** The shared object of {@code key}. {@code create} makes it when none is alive. */
  V get(K key, Function<K, V> create) {
    lock.lock();
    try {
      expunge();
      WeakReference<V> reference = entries.get(new Key<>(key, null));
      V value = reference == null ? null : reference.get();
      if (value == null) {
        value = create.apply(key);
        entries.put(new Key<>(key, cleared), new WeakReference<>(value));
      }
      return value;
    } finally {
      lock.unlock();
    }
  }

  /**
   * Every reference that the registry stores, keys and values, for a test that checks that each one
   * is weak. The registry holds nothing else.
   */
  List<Reference<?>> references() {
    lock.lock();
    try {
      List<Reference<?>> references = new ArrayList<>();
      for (Map.Entry<Key<K>, WeakReference<V>> entry : entries.entrySet()) {
        references.add(entry.getKey());
        references.add(entry.getValue());
      }
      return references;
    } finally {
      lock.unlock();
    }
  }

  /** The number of entries, after it removes the entries whose key was cleared. */
  int size() {
    lock.lock();
    try {
      expunge();
      return entries.size();
    } finally {
      lock.unlock();
    }
  }

  /** Removes the entries whose key the garbage collector cleared. The caller holds the lock. */
  private void expunge() {
    Reference<? extends K> reference;
    while ((reference = cleared.poll()) != null) {
      entries.remove(reference);
    }
  }

  /**
   * A weak key with the identity hash code of its referent. Two keys are equal when they are one
   * object, or when both still refer to one object.
   */
  private static final class Key<K> extends WeakReference<K> {
    private final int hash;

    Key(K referent, @Nullable ReferenceQueue<K> queue) {
      super(referent, queue);
      this.hash = System.identityHashCode(referent);
    }

    // The registry matches keys by reference identity on purpose, never by equals.
    @SuppressWarnings("ReferenceEquality")
    @Override
    public boolean equals(@Nullable Object other) {
      if (this == other) {
        return true;
      }
      if (!(other instanceof Key<?> that)) {
        return false;
      }
      Object referent = get();
      return referent != null && referent == that.get();
    }

    @Override
    public int hashCode() {
      return hash;
    }
  }
}
