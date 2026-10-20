package run.workhorse.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.lang.invoke.MethodHandles;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.datasource.ConnectionHolder;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.EnableTransactionManagement;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;
import run.workhorse.ConnectionSource;
import run.workhorse.EnqueueOptions;
import run.workhorse.Queue;
import run.workhorse.testing.ScratchDataSource;
import run.workhorse.testing.ScratchDatabase;

/**
 * An enqueue inside {@code @Transactional} joins that transaction (ADR 0103, "Connection model").
 */
@ExtendWith({ScratchDatabase.class, OutputCaptureExtension.class})
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

  // SM-1518: a transaction of another transaction manager does not own this DataSource's
  // connection, so nothing would commit it.
  @Test
  void anEnqueueUnderAnotherTransactionManagerCommitsWhenThePoolTurnsAutocommitOff() {
    String queueName = Contexts.unique("other-manager");
    ScratchDataSource manual = new ScratchDataSource(false);
    Contexts.runner()
        .withBean(DataSource.class, () -> manual)
        .withUserConfiguration(OtherTransactions.class)
        .run(
            context -> {
              ForeignOrders orders = context.getBean(ForeignOrders.class);
              List<UUID> taskIds = orders.placeTwice(queueName);
              assertThat(orders.visibleInside())
                  .as("each enqueue commits at once inside the other transaction")
                  .isTrue();
              assertThat(taskIds).allSatisfy(taskId -> assertThat(stored(taskId)).isTrue());
              assertThat(tasksIn(queueName)).isEqualTo(2);
              assertThat(manual.autoCommitAtClose())
                  .as("the pool's value comes back")
                  .containsOnly(false);
            });
  }

  @Test
  void anEnqueueJoinsAConnectionThatAnOrmTransactionManagerBound() {
    // JpaTransactionManager and HibernateTransactionManager bind a ConnectionHolder for the
    // DataSource with neither the synchronized nor the transaction-active flag set.
    String queueName = Contexts.unique("orm");
    ScratchDataSource source = new ScratchDataSource(true);
    Contexts.runner()
        .withBean(DataSource.class, () -> source)
        .withUserConfiguration(OtherTransactions.class)
        .run(
            context -> {
              Queue queue = context.getBean(Queue.class);
              TransactionTemplate other =
                  new TransactionTemplate(
                      context.getBean("otherTransactionManager", PlatformTransactionManager.class));
              AtomicReference<@Nullable UUID> enqueued = new AtomicReference<>();
              other.executeWithoutResult(
                  status -> {
                    try (Connection connection = source.getConnection()) {
                      connection.setAutoCommit(false);
                      TransactionSynchronizationManager.bindResource(
                          source, new ConnectionHolder(connection));
                      try {
                        UUID taskId =
                            queue
                                .enqueue(
                                    "order.ship",
                                    Map.of(),
                                    EnqueueOptions.builder().queue(queueName).build())
                                .taskId();
                        enqueued.set(taskId);
                        assertThat(stored(taskId)).as("invisible before the commit").isFalse();
                        assertThat(connection.getAutoCommit())
                            .as("the source leaves the transaction's connection alone")
                            .isFalse();
                      } finally {
                        TransactionSynchronizationManager.unbindResource(source);
                        connection.rollback();
                      }
                    } catch (SQLException error) {
                      throw new IllegalStateException(error);
                    }
                  });
              UUID taskId = enqueued.get();
              assertThat(taskId).isNotNull();
              assertThat(stored(taskId)).as("absent after the rollback").isFalse();
            });
  }

  // The coordinator's SM-1518 decision: a JTA application keeps joining, as before SM-1518.
  @Test
  void theStarterFindsAJtaTransactionManagerByItsClassName() throws Exception {
    // Spring's JtaTransactionManager cannot be built here, because the test class path has no
    // JTA API. The class loads without initialization, so its name is right.
    assertThat(
            Class.forName(
                    WorkhorseAutoConfiguration.JTA_TRANSACTION_MANAGER,
                    false,
                    TransactionTest.class.getClassLoader())
                .getSimpleName())
        .isEqualTo("JtaTransactionManager");
    class Subclass extends DataSourceTransactionManager {
      private static final long serialVersionUID = 1L;
    }
    assertThat(
            WorkhorseAutoConfiguration.extendsClassNamed(
                Subclass.class, DataSourceTransactionManager.class.getName()))
        .as("a subclass of the named class matches")
        .isTrue();
    assertThat(WorkhorseAutoConfiguration.isJta(new DataSourceTransactionManager())).isFalse();
    Contexts.runner()
        .withBean(DataSource.class, () -> new ScratchDataSource(false))
        .withUserConfiguration(Transactions.class)
        .run(
            context ->
                assertThat(
                        ((TransactionAwareConnectionSource) context.getBean(ConnectionSource.class))
                            .joinsAnyTransaction())
                    .as("a JDBC transaction manager selects no JTA mode")
                    .isFalse());
  }

  @Test
  void inJtaModeASynchronizationOnlyConnectionJoinsTheTransaction() throws Exception {
    ScratchDataSource manual = new ScratchDataSource(false);
    assertThat(heldUnderAnotherManager(new TransactionAwareConnectionSource(manual, true)))
        .as("the source leaves autocommit off, as the container owns the connection")
        .isFalse();
  }

  @Test
  void outsideJtaModeASynchronizationOnlyConnectionRunsInAutocommit() throws Exception {
    ScratchDataSource manual = new ScratchDataSource(false);
    assertThat(heldUnderAnotherManager(new TransactionAwareConnectionSource(manual, false)))
        .isTrue();
  }

  @Test
  void aFailedLookupKeepsTheRuleBeforeTheFix(CapturedOutput output) throws Exception {
    // A public lookup has no private access, so the private lookup fails.
    assertThat(TransactionAwareConnectionSource.findTransactionActive(MethodHandles.publicLookup()))
        .isNull();
    assertThat(output).contains("cannot read ConnectionHolder.isTransactionActive");
    ScratchDataSource manual = new ScratchDataSource(false);
    assertThat(heldUnderAnotherManager(new TransactionAwareConnectionSource(manual, false, null)))
        .as("every connection of an actual transaction counts as owned")
        .isFalse();
  }

  /**
   * The autocommit value of a connection that {@code source} acquires inside a transaction of a
   * manager of another DataSource. There, {@code DataSourceUtils} binds the connection for
   * synchronization only.
   */
  private static boolean heldUnderAnotherManager(TransactionAwareConnectionSource source)
      throws Exception {
    TransactionTemplate other =
        new TransactionTemplate(new DataSourceTransactionManager(new ScratchDataSource(true)));
    AtomicReference<@Nullable Boolean> autoCommit = new AtomicReference<>();
    other.executeWithoutResult(
        status -> {
          try {
            Connection connection = source.acquire();
            try {
              autoCommit.set(connection.getAutoCommit());
            } finally {
              source.release(connection, false);
            }
          } catch (SQLException error) {
            throw new IllegalStateException(error);
          }
        });
    Boolean value = autoCommit.get();
    assertThat(value).isNotNull();
    return value;
  }

  /** A second transaction manager, over a second DataSource that is not a bean. */
  @Configuration(proxyBeanMethods = false)
  @EnableTransactionManagement
  static class OtherTransactions {
    @Bean
    PlatformTransactionManager otherTransactionManager() {
      return new DataSourceTransactionManager(new ScratchDataSource(true));
    }

    @Bean
    ForeignOrders foreignOrders(Queue queue) {
      return new ForeignOrders(queue);
    }
  }

  /** An application service that enqueues inside a transaction of the other manager. */
  static class ForeignOrders {
    private final Queue queue;
    private volatile boolean visibleInside;

    ForeignOrders(Queue queue) {
      this.queue = queue;
    }

    @Transactional("otherTransactionManager")
    public List<UUID> placeTwice(String queueName) throws SQLException {
      // Two enqueues: the second one reuses the connection that the first one bound.
      List<UUID> taskIds = new ArrayList<>();
      for (int i = 0; i < 2; i++) {
        taskIds.add(
            queue
                .enqueue("order.ship", Map.of(), EnqueueOptions.builder().queue(queueName).build())
                .taskId());
      }
      visibleInside = stored(taskIds.get(0)) && stored(taskIds.get(1));
      return taskIds;
    }

    public boolean visibleInside() {
      return visibleInside;
    }
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
