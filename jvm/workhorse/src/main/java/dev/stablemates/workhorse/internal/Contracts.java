package dev.stablemates.workhorse.internal;

import dev.stablemates.workhorse.TaskContractVersion;
import dev.stablemates.workhorse.TaskTypeContracts;
import dev.stablemates.workhorse.WorkhorseException;
import java.sql.Connection;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/** Loads and renders payload contracts. Internal to the SDK. */
public final class Contracts {
  private Contracts() {}

  /**
   * The current contract PostgreSQL holds for one task type.
   *
   * @param version the contract version that new tasks stamp
   * @param schema the compiled payload schema
   * @param payloadMaxBytes the payload limit
   * @param resultMaxBytes the result limit
   * @param payloadRedactKeys the payload keys that reads redact
   * @param resultRedactKeys the result keys that reads redact
   */
  public record PayloadContract(
      String version,
      ContractSchema schema,
      long payloadMaxBytes,
      long resultMaxBytes,
      List<String> payloadRedactKeys,
      List<String> resultRedactKeys) {}

  /**
   * The current contract of {@code taskType}, or its {@code version} when it is not {@code null},
   * or {@code null} when there is none.
   */
  public static @Nullable PayloadContract load(
      Connection connection, String taskType, @Nullable String version) {
    List<Row> rows =
        Sql.rows(connection, SqlCatalogue.GET_CONTRACT_DEFINITION_V1, taskType, version);
    if (rows.isEmpty()) {
      return null;
    }
    if (rows.size() != 1) {
      throw invalidDefinition(null);
    }
    return decode(rows.get(0));
  }

  private static PayloadContract decode(Row row) {
    try {
      Map<String, @Nullable Object> schema = Json.object(row.json("schema"));
      if (schema == null || !schema.containsKey("payload")) {
        throw invalidDefinition(null);
      }
      List<String> payloadKeys = row.textList("payload_redact_keys");
      List<String> resultKeys = row.textList("result_redact_keys");
      return new PayloadContract(
          row.requiredText("version"),
          new ContractSchema(schema.get("payload")),
          row.requiredLong("payload_max_bytes"),
          row.requiredLong("result_max_bytes"),
          payloadKeys == null ? List.of() : payloadKeys,
          resultKeys == null ? List.of() : resultKeys);
    } catch (IllegalArgumentException | WorkhorseException error) {
      throw invalidDefinition(error);
    }
  }

  private static WorkhorseException invalidDefinition(@Nullable Exception cause) {
    String message = "invalid contract definition returned by PostgreSQL";
    return cause == null ? new WorkhorseException(message) : new WorkhorseException(message, cause);
  }

  /**
   * Compiles every schema, then renders the {@code sync_contract_definitions_v1} document.
   *
   * @param schemas parses a schema value into the core's tree
   * @throws IllegalArgumentException if a schema is outside the profile
   */
  public static List<Object> document(
      Map<String, TaskTypeContracts> contracts,
      java.util.function.Function<@Nullable Object, @Nullable Object> schemas) {
    List<Object> document = new ArrayList<>();
    for (Map.Entry<String, TaskTypeContracts> entry : contracts.entrySet()) {
      Map<String, @Nullable Object> versions = new LinkedHashMap<>();
      for (Map.Entry<String, TaskContractVersion> version :
          entry.getValue().versions().entrySet()) {
        versions.put(version.getKey(), versionDocument(version.getValue(), schemas));
      }
      Map<String, @Nullable Object> item = new LinkedHashMap<>();
      item.put("taskType", entry.getKey());
      item.put("currentVersion", entry.getValue().currentVersion());
      item.put("versions", versions);
      document.add(item);
    }
    return document;
  }

  private static Map<String, @Nullable Object> versionDocument(
      TaskContractVersion contract,
      java.util.function.Function<@Nullable Object, @Nullable Object> schemas) {
    Object payload = schemas.apply(contract.payloadSchema());
    Object result = schemas.apply(contract.resultSchema());
    new ContractSchema(payload);
    new ContractSchema(result);
    Map<String, @Nullable Object> document = new LinkedHashMap<>();
    document.put("payloadSchema", payload);
    document.put("resultSchema", result);
    document.put("maxPayloadBytes", limit(contract.maxPayloadBytes()));
    document.put("maxResultBytes", limit(contract.maxResultBytes()));
    document.put("sensitivePayloadKeys", contract.sensitivePayloadKeys());
    document.put("sensitiveResultKeys", contract.sensitiveResultKeys());
    return document;
  }

  private static long limit(@Nullable Long value) {
    return value == null || value == 0 ? SqlCatalogue.DEFAULT_TASK_VALUE_MAX_BYTES : value;
  }
}
