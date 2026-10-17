package dev.stablemates.workhorse.internal;

import dev.stablemates.workhorse.CompatibilityException;
import dev.stablemates.workhorse.DatabaseException;
import java.sql.Connection;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import org.jspecify.annotations.Nullable;

/** The startup check every SDK runs before its first mutation. Internal to the SDK. */
public final class Compatibility {
  private static final Set<String> NOT_INSTALLED = Set.of("42P01", "3F000");

  private Compatibility() {}

  /** The refusal code for observed state, or {@code null} when the client can continue. */
  public static CompatibilityException.@Nullable Code check(
      @Nullable Integer installedSchemaVersion,
      int clientProtocolVersion,
      List<Integer> servedProtocolVersions) {
    if (installedSchemaVersion == null) {
      return CompatibilityException.Code.SCHEMA_NOT_INSTALLED;
    }
    if (installedSchemaVersion < SqlCatalogue.MINIMUM_SCHEMA_VERSION) {
      return CompatibilityException.Code.SCHEMA_TOO_OLD;
    }
    if (clientProtocolVersion < SqlCatalogue.MINIMUM_PROTOCOL_VERSION) {
      return CompatibilityException.Code.CLIENT_PROTOCOL_TOO_OLD;
    }
    if (clientProtocolVersion > SqlCatalogue.MAXIMUM_PROTOCOL_VERSION) {
      return CompatibilityException.Code.CLIENT_PROTOCOL_TOO_NEW;
    }
    if (servedProtocolVersions.isEmpty()
        || servedProtocolVersions.contains(clientProtocolVersion)) {
      return null;
    }
    int oldest = servedProtocolVersions.stream().mapToInt(Integer::intValue).min().orElseThrow();
    return clientProtocolVersion < oldest
        ? CompatibilityException.Code.SCHEMA_TOO_NEW
        : CompatibilityException.Code.SCHEMA_TOO_OLD;
  }

  /** The refusal code for the database that {@code connection} reaches, or {@code null}. */
  public static CompatibilityException.@Nullable Code evaluate(Connection connection) {
    List<Row> rows;
    try {
      rows = Sql.rows(connection, SqlCatalogue.COMPATIBILITY_STATE);
    } catch (DatabaseException error) {
      String sqlState = error.sqlState();
      if (sqlState != null && NOT_INSTALLED.contains(sqlState)) {
        return CompatibilityException.Code.SCHEMA_NOT_INSTALLED;
      }
      throw error;
    }
    List<Integer> schemas = new ArrayList<>();
    List<Integer> served = new ArrayList<>();
    for (Row row : rows) {
      int version = row.requiredInteger("version");
      switch (row.requiredText("kind")) {
        case "schema" -> schemas.add(version);
        case "protocol" -> served.add(version);
        default -> {}
      }
    }
    return check(
        schemas.size() == 1 ? schemas.get(0) : null, SqlCatalogue.CLIENT_PROTOCOL_VERSION, served);
  }
}
