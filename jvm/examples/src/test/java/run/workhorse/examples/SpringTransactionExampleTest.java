package run.workhorse.examples;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.sql.SQLException;
import java.util.UUID;
import javax.sql.DataSource;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.EnableTransactionManagement;
import org.springframework.transaction.support.TransactionTemplate;
import run.workhorse.Queue;
import run.workhorse.spring.WorkhorseAutoConfiguration;
import run.workhorse.testing.ScratchDatabase;

/** Runs the {@code @Transactional} snippet in a Spring context with the starter. */
@ExtendWith(ScratchDatabase.class)
class SpringTransactionExampleTest {
  private final ApplicationContextRunner runner =
      new ApplicationContextRunner()
          .withConfiguration(AutoConfigurations.of(WorkhorseAutoConfiguration.class))
          .withUserConfiguration(Application.class);

  @BeforeAll
  static void accountTable() throws SQLException {
    ExampleDatabase.createAccountTable();
  }

  @Test
  void theServiceCommitsTheAccountAndTheTaskTogether() {
    String id = "spring-" + UUID.randomUUID();
    runner.run(
        context -> {
          context.getBean(Accounts.class).create(id, "person@example.com");
          assertEquals(1, ExampleDatabase.accounts(id));
          assertEquals(1, ExampleDatabase.tasks("account.created", "accountId", id).size());
        });
  }

  @Test
  void aRollbackRemovesTheTaskWithTheAccount() {
    String id = "spring-" + UUID.randomUUID();
    runner.run(
        context -> {
          Accounts accounts = context.getBean(Accounts.class);
          new TransactionTemplate(context.getBean(PlatformTransactionManager.class))
              .executeWithoutResult(
                  status -> {
                    accounts.create(id, "person@example.com");
                    status.setRollbackOnly();
                  });
          assertEquals(0, ExampleDatabase.accounts(id));
          assertEquals(0, ExampleDatabase.tasks("account.created", "accountId", id).size());
        });
  }

  @Configuration(proxyBeanMethods = false)
  @EnableTransactionManagement
  static class Application {
    @Bean
    DataSource dataSource() {
      return ExampleDatabase.dataSource();
    }

    @Bean
    PlatformTransactionManager transactionManager(DataSource dataSource) {
      return new DataSourceTransactionManager(dataSource);
    }

    @Bean
    JdbcTemplate jdbcTemplate(DataSource dataSource) {
      return new JdbcTemplate(dataSource);
    }

    @Bean
    Accounts accounts(JdbcTemplate jdbc, Queue queue) {
      return new Accounts(jdbc, queue);
    }
  }
}
