package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.sql.SQLException;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.extension.ExtendWith;
import run.workhorse.ConnectionSource;
import run.workhorse.ContractValidationException;
import run.workhorse.Queue;
import run.workhorse.testing.ScratchDatabase;

/** Runs the Java snippets of the site page about payload contracts. */
@ExtendWith(ScratchDatabase.class)
@Timeout(value = 120, unit = TimeUnit.SECONDS)
class ContractsExamplesTest {
  private final Queue queue = new Queue(ConnectionSource.of(ExampleDatabase.dataSource()));

  @AfterEach
  void removeContract() throws SQLException {
    PolicyExampleRows.removeMailContract();
  }

  @Test
  void theContractRejectsAPayloadWithoutARecipient() throws SQLException {
    new ContractsExamples(queue).syncContracts();
    ContractValidationException error =
        assertThrows(
            ContractValidationException.class,
            () -> queue.enqueue("mail.send", Map.of("to", "ada@example.com")));
    assertEquals("mail.send", error.taskType());
    assertEquals("mail-current", error.version());
    String recipient = "java-" + UUID.randomUUID() + "@example.com";
    queue.enqueue("mail.send", Map.of("recipient", recipient));
    assertEquals(
        "mail-current",
        ExampleDatabase.task("mail.send", "recipient", recipient).contractVersion());
  }
}
