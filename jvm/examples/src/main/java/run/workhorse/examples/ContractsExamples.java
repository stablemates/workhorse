package run.workhorse.examples;

import java.util.List;
import java.util.Map;
import run.workhorse.Queue;
import run.workhorse.TaskContractVersion;
import run.workhorse.TaskTypeContracts;

/** The Java tabs of the site page about payload contracts. */
public final class ContractsExamples {
  private final Queue queue;

  /** The snippets run on this queue. */
  public ContractsExamples(Queue queue) {
    this.queue = queue;
  }

  void syncContracts() {
    // docs:start java-contracts-sync
    Map<String, TaskTypeContracts> contracts =
        Map.of(
            "mail.send",
            new TaskTypeContracts(
                "mail-current",
                Map.of(
                    "mail-current",
                    new TaskContractVersion(
                        Map.of("type", "object", "required", List.of("recipient")),
                        Map.of("type", "object"),
                        null,
                        null,
                        List.of("accessToken"),
                        List.of()))));
    queue.syncContracts(contracts);
    // docs:end
  }
}
