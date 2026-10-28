package run.workhorse.spring;

import io.opentelemetry.api.OpenTelemetry;
import jakarta.servlet.Filter;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import javax.sql.DataSource;
import org.apache.commons.logging.Log;
import org.apache.commons.logging.LogFactory;
import org.springframework.beans.factory.BeanFactoryUtils;
import org.springframework.beans.factory.ListableBeanFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.SmartInitializingSingleton;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.AllNestedConditions;
import org.springframework.boot.autoconfigure.condition.AnyNestedCondition;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBooleanProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnNotWebApplication;
import org.springframework.boot.autoconfigure.condition.ConditionalOnSingleCandidate;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.autoconfigure.condition.NoneNestedConditions;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.boot.health.autoconfigure.contributor.ConditionalOnEnabledHealthIndicator;
import org.springframework.boot.health.contributor.HealthIndicator;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Condition;
import org.springframework.context.annotation.ConditionContext;
import org.springframework.context.annotation.Conditional;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.Environment;
import org.springframework.core.type.AnnotatedTypeMetadata;
import org.springframework.transaction.PlatformTransactionManager;
import run.workhorse.Admin;
import run.workhorse.ConnectionSource;
import run.workhorse.JsonCodec;
import run.workhorse.Queue;
import run.workhorse.QueueOptions;
import run.workhorse.TaskHandler;
import run.workhorse.Worker;
import run.workhorse.WorkhorseTelemetry;
import run.workhorse.dashboard.Dashboard;
import run.workhorse.dashboard.DashboardAuthorizer;
import tools.jackson.databind.json.JsonMapper;

/**
 * Builds the Workhorse beans from the application's {@code DataSource} (ADR 0103, "Spring Boot
 * starter").
 *
 * <p>The starter uses the {@code DataSource} bean that {@code workhorse.data-source} names. When
 * that property is unset, it uses the only {@code DataSource} bean or the {@code @Primary} one. If
 * the context holds several {@code DataSource} beans and none of these rules selects one, the
 * starter builds no Workhorse bean and logs one warning.
 *
 * <ul>
 *   <li>A {@link TransactionAwareConnectionSource}, and {@link Queue} and {@link Admin} beans on
 *       it, so an enqueue inside {@code @Transactional} joins that transaction.
 *   <li>A {@link JacksonJsonCodec} on the application's {@code JsonMapper} when Jackson is present.
 *   <li>A {@link WorkhorseTelemetry} on the application's {@code OpenTelemetry} bean when the
 *       OpenTelemetry API is present. The queue and the worker report to it. Without that bean,
 *       they read {@code GlobalOpenTelemetry}.
 *   <li>Only when {@code workhorse.worker.enabled=true}: a {@link Worker} with every {@link
 *       TaskHandler} bean, its {@link WorkerLifecycle}, and a health indicator when Actuator is
 *       present.
 *   <li>Only when {@code workhorse.dashboard.enabled=true} in a servlet application: the dashboard
 *       filter, which needs a {@link DashboardAuthorizer} bean.
 * </ul>
 *
 * <p>Each bean backs off when the application defines its own bean of that type.
 */
@AutoConfiguration(
    afterName = {
      "org.springframework.boot.jdbc.autoconfigure.DataSourceAutoConfiguration",
      "org.springframework.boot.jackson.autoconfigure.JacksonAutoConfiguration",
      "org.springframework.boot.opentelemetry.autoconfigure.OpenTelemetrySdkAutoConfiguration"
    })
@EnableConfigurationProperties(WorkhorseProperties.class)
public final class WorkhorseAutoConfiguration {
  private static final Log LOG = LogFactory.getLog(WorkhorseAutoConfiguration.class);

  /** The class name that {@link #isJta} looks for in the class hierarchy of a manager. */
  static final String JTA_TRANSACTION_MANAGER =
      "org.springframework.transaction.jta.JtaTransactionManager";

  /** Created by Spring. */
  public WorkhorseAutoConfiguration() {}

  // The class stays public, so an application can name it in `exclude`. Each @Bean method is
  // package-private, so a new bean dependency does not change the public API in api/java.txt.
  // Each bean and nested configuration that builds a Workhorse bean carries
  // @Conditional(DataSourceSelected.class). The class itself carries no condition, so the
  // back-off warning can run when no DataSource is selected.

  /**
   * Matches when {@code workhorse.data-source} has any value. Unlike
   * {@code @ConditionalOnProperty}, it treats the value {@code false} as a bean name.
   */
  static final class DataSourcePropertySet implements Condition {
    @Override
    public boolean matches(ConditionContext context, AnnotatedTypeMetadata metadata) {
      return context.getEnvironment().containsProperty("workhorse.data-source");
    }
  }

  /**
   * Matches when {@code workhorse.data-source} is set, or when the context has one {@code
   * DataSource} candidate: the only bean or the {@code @Primary} one.
   */
  static final class DataSourceSelected extends AnyNestedCondition {
    DataSourceSelected() {
      super(ConfigurationPhase.REGISTER_BEAN);
    }

    @Conditional(DataSourcePropertySet.class)
    static final class Named {}

    @ConditionalOnSingleCandidate(DataSource.class)
    static final class Single {}
  }

  /** Matches when neither rule of {@link DataSourceSelected} matches. */
  static final class NoDataSourceSelected extends NoneNestedConditions {
    NoDataSourceSelected() {
      super(ConfigurationPhase.REGISTER_BEAN);
    }

    @Conditional(DataSourcePropertySet.class)
    static final class Named {}

    @ConditionalOnSingleCandidate(DataSource.class)
    static final class Single {}
  }

  /** Matches when the context holds {@code DataSource} beans, but no rule selects one. */
  static final class SeveralDataSources extends AllNestedConditions {
    SeveralDataSources() {
      super(ConfigurationPhase.REGISTER_BEAN);
    }

    @ConditionalOnBean(DataSource.class)
    static final class Present {}

    @Conditional(NoDataSourceSelected.class)
    static final class NotSelected {}
  }

  /**
   * The {@code DataSource} of every Workhorse bean: the bean that {@code workhorse.data-source}
   * names, or else the only candidate.
   */
  static DataSource dataSource(
      WorkhorseProperties properties,
      ListableBeanFactory beans,
      ObjectProvider<DataSource> dataSources) {
    String name = properties.getDataSource();
    if (name == null) {
      return dataSources.getObject();
    }
    requireNamedDataSource(beans, name);
    return beans.getBean(name, DataSource.class);
  }

  /** Throws {@link IllegalStateException} when {@code name} names no {@code DataSource} bean. */
  static void requireNamedDataSource(ListableBeanFactory beans, String name) {
    if (!beans.containsBean(name) || !beans.isTypeMatch(name, DataSource.class)) {
      throw new IllegalStateException(
          "workhorse.data-source=" + name + " names no DataSource bean in the context");
    }
  }

  /**
   * The startup check of {@code workhorse.data-source}. It runs also when the application defines
   * every Workhorse bean itself, so no starter bean reads the property.
   */
  @Configuration(proxyBeanMethods = false)
  @Conditional(DataSourcePropertySet.class)
  static class DataSourcePropertyConfiguration {
    @Bean
    static SmartInitializingSingleton workhorseDataSourceCheck(
        ListableBeanFactory beans, ObjectProvider<WorkhorseProperties> properties) {
      return () -> {
        String name = properties.getObject().getDataSource();
        if (name != null) {
          requireNamedDataSource(beans, name);
        }
      };
    }
  }

  /**
   * The property that Workhorse 0.11.0 removed. Every worker now uses the dedicated heartbeat
   * connection (ADR 0071), so the property has no effect, and the starter refuses it.
   */
  static final String REMOVED_SHARED_HEARTBEATS = "workhorse.worker.shared-heartbeats";

  /**
   * The startup check of the removed {@code workhorse.worker.shared-heartbeats} property, in each
   * relaxed form. It runs whether or not the starter selects a DataSource.
   */
  @Bean
  static SmartInitializingSingleton workhorseRemovedPropertyCheck(Environment environment) {
    return () -> {
      if (Binder.get(environment)
          .bind(REMOVED_SHARED_HEARTBEATS, Bindable.of(String.class))
          .isBound()) {
        throw new IllegalStateException(
            REMOVED_SHARED_HEARTBEATS
                + " was removed in 0.11.0. Every worker now reserves a dedicated heartbeat"
                + " connection. Remove the property, and give the worker a pool with a known"
                + " maximum size of at least 3.");
      }
    };
  }

  /** The warning when the starter backs off because several DataSource beans exist. */
  @Configuration(proxyBeanMethods = false)
  @Conditional(SeveralDataSources.class)
  static class DataSourceBackOffConfiguration {
    @Bean
    static SmartInitializingSingleton workhorseDataSourceWarning(ListableBeanFactory beans) {
      return () -> {
        String[] names =
            BeanFactoryUtils.beanNamesForTypeIncludingAncestors(
                beans, DataSource.class, true, false);
        LOG.warn(
            "The context holds "
                + names.length
                + " DataSource beans ("
                + String.join(", ", names)
                + ") and none is @Primary, so the starter builds no Workhorse bean. Set"
                + " workhorse.data-source to the bean name of the DataSource for Workhorse, or"
                + " mark one DataSource bean @Primary.");
      };
    }
  }

  /**
   * The connection source that joins the current Spring transaction. With a {@code
   * JtaTransactionManager} bean, it joins any actual transaction that holds the connection.
   */
  @Bean
  @ConditionalOnMissingBean
  @Conditional(DataSourceSelected.class)
  ConnectionSource workhorseConnectionSource(
      WorkhorseProperties properties,
      ListableBeanFactory beans,
      ObjectProvider<DataSource> dataSources,
      ObjectProvider<PlatformTransactionManager> transactionManagers) {
    boolean jta = transactionManagers.orderedStream().anyMatch(WorkhorseAutoConfiguration::isJta);
    return new TransactionAwareConnectionSource(dataSource(properties, beans, dataSources), jta);
  }

  /**
   * Whether {@code manager} is a {@code JtaTransactionManager}. The check compares class names, so
   * it loads no JTA class when the application has no JTA API.
   */
  static boolean isJta(PlatformTransactionManager manager) {
    return extendsClassNamed(manager.getClass(), JTA_TRANSACTION_MANAGER);
  }

  /** Whether {@code type} or one of its superclasses has the name {@code name}. */
  static boolean extendsClassNamed(Class<?> type, String name) {
    for (Class<?> current = type; current != null; current = current.getSuperclass()) {
      if (current.getName().equals(name)) {
        return true;
      }
    }
    return false;
  }

  /**
   * The queue. Its codec is the {@code JsonCodec} bean, or the core's default codec. Its telemetry
   * is the {@code WorkhorseTelemetry} bean, or the core's default telemetry.
   */
  @Bean
  @ConditionalOnMissingBean
  @Conditional(DataSourceSelected.class)
  Queue workhorseQueue(
      ConnectionSource connections,
      WorkhorseProperties properties,
      ObjectProvider<JsonCodec> codec,
      ObjectProvider<WorkhorseTelemetry> telemetry) {
    QueueOptions.Builder options =
        QueueOptions.builder()
            .defaultQueue(properties.getQueue().getDefaultQueue())
            .codec(codec.getIfAvailable(JsonCodec::standard));
    telemetry.ifAvailable(options::telemetry);
    return new Queue(connections, options.build());
  }

  /** The operator API. */
  @Bean
  @ConditionalOnMissingBean
  @Conditional(DataSourceSelected.class)
  Admin workhorseAdmin(ConnectionSource connections) {
    return new Admin(connections);
  }

  /** The codec on the application's Jackson {@code JsonMapper}. */
  @Configuration(proxyBeanMethods = false)
  @ConditionalOnClass(JsonMapper.class)
  @Conditional(DataSourceSelected.class)
  static class JacksonCodecConfiguration {
    @Bean
    @ConditionalOnBean(JsonMapper.class)
    @ConditionalOnMissingBean
    JsonCodec workhorseJsonCodec(JsonMapper jsonMapper) {
      return new JacksonJsonCodec(jsonMapper);
    }
  }

  /**
   * The telemetry on the application's {@code OpenTelemetry} bean (ADR 0103, "Telemetry"). If the
   * context has no single {@code OpenTelemetry} bean, the starter defines no telemetry bean, and
   * the core's default telemetry applies. If the API is absent, the starter loads no OpenTelemetry
   * class.
   */
  @Configuration(proxyBeanMethods = false)
  @ConditionalOnClass(OpenTelemetry.class)
  @ConditionalOnSingleCandidate(OpenTelemetry.class)
  @Conditional(DataSourceSelected.class)
  static class OpenTelemetryConfiguration {
    @Bean
    @ConditionalOnMissingBean
    WorkhorseTelemetry workhorseTelemetry(OpenTelemetry openTelemetry) {
      return WorkhorseTelemetry.of(openTelemetry);
    }
  }

  /** The worker. Only {@code workhorse.worker.enabled=true} builds it. */
  @Configuration(proxyBeanMethods = false)
  @ConditionalOnBooleanProperty("workhorse.worker.enabled")
  @Conditional(DataSourceSelected.class)
  static class WorkerConfiguration {
    // Worker is AutoCloseable, so Spring calls close() when it destroys the bean. That runs before
    // the DataSource closes, and it waits for a drain that the lifecycle stop did not finish.
    @Bean
    @ConditionalOnMissingBean
    Worker workhorseWorker(
        WorkhorseProperties properties,
        ListableBeanFactory beans,
        ObjectProvider<DataSource> dataSources,
        ObjectProvider<JsonCodec> codec,
        ObjectProvider<WorkhorseTelemetry> telemetry,
        ObjectProvider<TaskHandler<?>> handlers,
        ObjectProvider<WorkerCustomizer> customizers) {
      WorkhorseProperties.WorkerProperties options = properties.getWorker();
      Worker.Builder builder =
          Worker.builder(dataSource(properties, beans, dataSources))
              .queues(options.getQueues().toArray(String[]::new))
              .concurrency(options.getConcurrency())
              .lease(options.getLease())
              .pollingOnly(options.isPollingOnly())
              .maintenanceInterval(options.getMaintenanceInterval())
              .maintenanceRoutineInterval(options.getMaintenanceRoutineInterval())
              .registryInterval(options.getRegistryInterval())
              .disableRegistry(options.isDisableRegistry())
              .scheduleNamespaces(options.getScheduleNamespaces().toArray(String[]::new))
              .scheduleCatchupLimit(options.getScheduleCatchupLimit())
              .shutdownGrace(options.getShutdownGrace())
              .codec(codec.getIfAvailable(JsonCodec::standard));
      String workerId = options.getWorkerId();
      if (workerId != null) {
        builder.workerId(workerId);
      }
      var heartbeat = options.getHeartbeat();
      if (heartbeat != null) {
        builder.heartbeat(heartbeat);
      }
      Integer poolMaxSize = options.getPoolMaxSize();
      if (poolMaxSize != null) {
        builder.poolMaxSize(poolMaxSize);
      }
      var pollInterval = options.getPollInterval();
      if (pollInterval != null) {
        builder.pollInterval(pollInterval);
      }
      telemetry.ifAvailable(builder::telemetry);
      requireOneHandlerPerTaskType(beans);
      handlers.orderedStream().forEach(builder::handle);
      customizers.orderedStream().forEach(customizer -> customizer.customize(builder));
      return builder.build();
    }

    /**
     * Throws {@link IllegalStateException} when two {@code TaskHandler} beans name one task type.
     * The core builder keeps only the last registration of a task type, so the other bean would
     * never run.
     */
    @SuppressWarnings("rawtypes")
    static void requireOneHandlerPerTaskType(ListableBeanFactory beans) {
      Map<String, String> owners = new LinkedHashMap<>();
      Map<String, TaskHandler> handlers =
          BeanFactoryUtils.beansOfTypeIncludingAncestors(beans, TaskHandler.class, true, false);
      handlers.forEach(
          (name, handler) -> {
            String taskType = handler.taskType();
            String owner = owners.putIfAbsent(taskType, name);
            if (owner != null) {
              throw new IllegalStateException(
                  "The TaskHandler beans "
                      + owner
                      + " and "
                      + name
                      + " both handle task type "
                      + taskType
                      + ". Define one TaskHandler bean for each task type.");
            }
          });
    }

    /**
     * The lifecycle of an application that serves no web requests: a run that ends without a stop
     * exits the process with a non-zero status, so a supervisor can restart it.
     */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnNotWebApplication
    static class ProcessLifecycleConfiguration {
      @Bean
      @ConditionalOnMissingBean
      WorkerLifecycle workhorseWorkerLifecycle(
          Worker worker, ConfigurableApplicationContext context) {
        return new WorkerLifecycle(worker, failure -> ProcessExit.exit(context, System::exit));
      }
    }

    /**
     * The lifecycle of a web application: a run that ends without a stop leaves the application
     * running, and the health indicator reports the worker as down.
     */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnWebApplication
    static class WebLifecycleConfiguration {
      @Bean
      @ConditionalOnMissingBean
      WorkerLifecycle workhorseWorkerLifecycle(Worker worker) {
        return new WorkerLifecycle(worker);
      }
    }

    /**
     * The worker health. Actuator's {@code management.health.workhorse.enabled} can turn it off.
     */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass({HealthIndicator.class, ConditionalOnEnabledHealthIndicator.class})
    @ConditionalOnEnabledHealthIndicator("workhorse")
    static class HealthConfiguration {
      @Bean
      @ConditionalOnMissingBean(name = "workhorseHealthIndicator")
      HealthIndicator workhorseHealthIndicator(WorkerLifecycle lifecycle) {
        return new WorkerHealthIndicator(lifecycle);
      }
    }
  }

  /**
   * The warning for a worker process that forgot the property: the context holds {@code
   * TaskHandler} beans, but no {@code Worker} bean. The check reads the beans, not the property, so
   * a value such as {@code on} that builds no worker also logs the warning.
   */
  @Configuration(proxyBeanMethods = false)
  @Conditional(DataSourceSelected.class)
  static class WorkerOffConfiguration {
    @Bean
    static SmartInitializingSingleton workhorseWorkerOffWarning(ListableBeanFactory beans) {
      return () -> {
        // The worker registers handler beans of a parent context too, so the check reads them.
        String[] names =
            BeanFactoryUtils.beanNamesForTypeIncludingAncestors(
                beans, TaskHandler.class, true, false);
        String[] workers =
            BeanFactoryUtils.beanNamesForTypeIncludingAncestors(beans, Worker.class, true, false);
        if (names.length > 0 && workers.length == 0) {
          LOG.warn(
              "The context holds "
                  + names.length
                  + " TaskHandler bean(s), but no Workhorse worker runs. Set"
                  + " workhorse.worker.enabled=true to start the worker in this process.");
        }
      };
    }
  }

  /** The dashboard filter. Only {@code workhorse.dashboard.enabled=true} registers it. */
  @Configuration(proxyBeanMethods = false)
  @ConditionalOnWebApplication(type = ConditionalOnWebApplication.Type.SERVLET)
  @ConditionalOnClass({Filter.class, FilterRegistrationBean.class})
  @ConditionalOnBooleanProperty("workhorse.dashboard.enabled")
  @Conditional(DataSourceSelected.class)
  static class DashboardConfiguration {
    @Bean
    @ConditionalOnMissingBean(name = "workhorseDashboard")
    FilterRegistrationBean<Dashboard> workhorseDashboard(
        ConnectionSource connections,
        WorkhorseProperties properties,
        ObjectProvider<DashboardAuthorizer> authorizer,
        ObjectProvider<JsonCodec> codec,
        ObjectProvider<DashboardCustomizer> customizers) {
      DashboardAuthorizer authorize = authorizer.getIfUnique();
      if (authorize == null) {
        throw new IllegalStateException(
            "workhorse.dashboard.enabled=true needs exactly one DashboardAuthorizer bean");
      }
      WorkhorseProperties.DashboardProperties options = properties.getDashboard();
      Dashboard.Builder builder =
          Dashboard.builder(connections, authorize)
              .path(options.getPath())
              .environment(options.getEnvironment())
              .auditActor(options.getAuditActor())
              .readOnly(options.isReadOnly())
              .browserModules(List.copyOf(options.getBrowserModules()))
              .configuredWorkers(List.copyOf(options.getConfiguredWorkers()))
              .allowedHosts(List.copyOf(options.getAllowedHosts()))
              // The worker's tick interval, so the cron page shows the configured value.
              .maintenanceLoops(
                  Map.of(
                      "tickIntervalMs", properties.getWorker().getMaintenanceInterval().toMillis()))
              .codec(codec.getIfAvailable(JsonCodec::standard));
      customizers.orderedStream().forEach(customizer -> customizer.customize(builder));
      // The filter passes every request outside its path to the rest of the chain.
      FilterRegistrationBean<Dashboard> registration =
          new FilterRegistrationBean<>(builder.build());
      registration.setName("workhorseDashboard");
      registration.addUrlPatterns("/*");
      return registration;
    }
  }
}
