package run.workhorse;

import java.util.Map;

/**
 * Every retained contract version of one task type, keyed by version, and the version that new
 * tasks use.
 *
 * @param currentVersion the version that new tasks use
 * @param versions every retained version
 */
public record TaskTypeContracts(String currentVersion, Map<String, TaskContractVersion> versions) {
  /** Copies the versions in their iteration order. */
  public TaskTypeContracts {
    versions = java.util.Collections.unmodifiableMap(new java.util.LinkedHashMap<>(versions));
  }
}
