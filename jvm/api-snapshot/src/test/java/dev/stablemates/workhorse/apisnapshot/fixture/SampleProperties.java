package dev.stablemates.workhorse.apisnapshot.fixture;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.jspecify.annotations.Nullable;

/** A properties class in the shape of the starter's, for the property reader tests. */
public class SampleProperties {
  private final Group group = new Group();

  public Group getGroup() {
    return group;
  }

  /** One nested group. */
  public static class Group {
    private boolean enabled;
    private List<String> names = new ArrayList<>(List.of("default"));
    private List<String> extras = new ArrayList<>();
    private Duration lease = Duration.ofSeconds(30);
    private @Nullable String id;

    public boolean isEnabled() {
      return enabled;
    }

    public List<String> getNames() {
      return names;
    }

    public List<String> getExtras() {
      return extras;
    }

    public Duration getLease() {
      return lease;
    }

    public @Nullable String getId() {
      return id;
    }
  }
}
