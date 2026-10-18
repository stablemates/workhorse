package dev.stablemates.workhorse.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import dev.stablemates.workhorse.EnqueueOptions;
import dev.stablemates.workhorse.Queue;
import dev.stablemates.workhorse.testing.ScratchDataSource;
import dev.stablemates.workhorse.testing.ScratchDatabase;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.EnableTransactionManagement;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * An enqueue inside {@code @Transactional} joins that transaction (ADR 0103, "Connection model").
 */
@ExtendWith(ScratchDatabase.class)
class TransactionTest {
  private static boolean stored(UUID taskId) throws SQLException {
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement =
            connection.prepareStatement("SELECT 1 FROM workhorse.task WHERE id = ?")) {
      statement.setObject(1, taskId);
      try (ResultSet result = statement.executeQuery()) {
        return result.next();
      }
    }
  }

  private static long tasksIn(String queueName) throws SQLException {
    try (Connection connection = ScratchDatabase.connect();
        PreparedStatement statement =
            connection.prepareStatement(
                "SELECT count(*) FROM workhorse.task WHERE queue_name = ?")) {
      statement.setString(1, queueName);
      try (ResultSet result = statement.executeQuery()) {
        result.next();
        return result.getLong(1);
      }
    }
  }

  @Test
  void anEnqueueThatRollsBackLeavesNoTask() {
    String queueName = Contexts.unique("rollback");
    Contexts.database()
        .withUserConfiguration(Transactions.class)
        .run(
            context -> {
              Orders orders = context.getBean(Orders.class);
              assertThatThrownBy(() -> orders.placeThenFail(queueName))
                  .isInstanceOf(IllegalStateException.class);
              assertThat(orders.seenInside()).as("the enqueue ran").isNotNull();
              assertThat(tasksIn(queueName)).as("no task after the rollback").isZero();
            });
  }

  @Test
  void anEnqueueThatCommitsIsInvisibleUntilTheCommit() {
    String queueName = Contexts.unique("commit");
    Contexts.database()
        .withUserConfiguration(Transactions.class)
        .run(
            context -> {
              Orders orders = context.getBean(Orders.class);
              UUID taskId = orders.place(queueName);
              assertThat(orders.visibleInside()).as("invisible before the commit").isFalse();
              assertThat(stored(taskId)).as("visible after the commit").isTrue();
            });
  }

  @Test
  void anEnqueueOutsideATransactionCommitsAtOnce() {
    String queueName = Contexts.unique("autocommit");
    Contexts.database()
        .run(
            context -> {
              UUID taskId =
                  context
                      .getBean(Queue.class)
                      .enqueue(
                          "order.ship", Map.of(), EnqueueOptions.builder().queue(queueName).build())
                      .taskId();
              assertThat(stored(taskId)).isTrue();
            });
  }

  @Test
  void anEnqueueOutsideATransactionCommitsWhenThePoolTurnsAutocommitOff() {
    String queueName = Contexts.unique("manual");
    ScratchDataSource manual = new ScratchDataSource(false);
    Contexts.runner()
        .withBean(DataSource.class, () -> manual)
        .run(
            context -> {
              UUID taskId =
                  context
                      .getBean(Queue.class)
                      .enqueue(
                          "order.ship", Map.of(), EnqueueOptions.builder().queue(queueName).build())
                      .taskId();
              assertThat(stored(taskId)).as("committed in autocommit").isTrue();
              assertThat(manual.autoCommitAtClose())
                  .as("the pool's value comes back")
                  .containsOnly(false);
            });
  }

  @Test
  void anEnqueueInASupportsScopeCommitsWhenThePoolTurnsAutocommitOff() {
    String queueName = Contexts.unique("supports");
    Contexts.runner()
        .withBean(DataSource.class, () -> new ScratchDataSource(false))
        .withUserConfiguration(Transactions.class)
        .run(
            context -> {
              UUID taskId = context.getBean(Orders.class).placeWithSupports(queueName);
              assertThat(stored(taskId)).as("committed in autocommit").isTrue();
            });
  }

  @Test
  void anEnqueueInANotSupportedScopeCommitsWhenThePoolTurnsAutocommitOff() {
    String queueName = Contexts.unique("not-supported");
    Contexts.runner()
        .withBean(DataSource.class, () -> new ScratchDataSource(false))
        .withUserConfiguration(Transactions.class)
        .run(
            context -> {
              UUID taskId = context.getBean(Orders.class).placeWithNotSupported(queueName);
              assertThat(stored(taskId)).as("committed in autocommit").isTrue();
            });
  }

  @Configuration(proxyBeanMethods = false)
  @EnableTransactionManagement
  static class Transactions {
    @Bean
    PlatformTransactionManager transactionManager(DataSource dataSource) {
      return new DataSourceTransactionManager(dataSource);
    }

    @Bean
    Orders orders(Queue queue) {
      return new Orders(queue);
    }
  }

  /** An application service that enqueues inside its own transaction. */
  static class Orders {
    private final Queue queue;
    // A CGLIB proxy wraps this bean, so the test reads the state through public methods.
    private final AtomicReference<@Nullable UUID> seenInside = new AtomicReference<>();
    private volatile boolean visibleInside = true;

    Orders(Queue queue) {
      this.queue = queue;
    }

    @Transactional
    public UUID place(String queueName) throws SQLException {
      UUID taskId = enqueue(queueName);
      visibleInside = stored(taskId);
      return taskId;
    }

    @Transactional
    public void placeThenFail(String queueName) {
      seenInside.set(enqueue(queueName));
      throw new IllegalStateException("the order fails after the enqueue");
    }

    @Transactional(propagation = Propagation.SUPPORTS)
    public UUID placeWithSupports(String queueName) {
      // Two enqueues: the second one reuses the connection that the first one bound.
      enqueue(queueName);
      return enqueue(queueName);
    }

    @Transactional(propagation = Propagation.NOT_SUPPORTED)
    public UUID placeWithNotSupported(String queueName) {
      enqueue(queueName);
      return enqueue(queueName);
    }

    public @Nullable UUID seenInside() {
      return seenInside.get();
    }

    public boolean visibleInside() {
      return visibleInside;
    }

    private UUID enqueue(String queueName) {
      return queue
          .enqueue(
              "order.ship", Map.of("order", 7), EnqueueOptions.builder().queue(queueName).build())
          .taskId();
    }
  }
}
