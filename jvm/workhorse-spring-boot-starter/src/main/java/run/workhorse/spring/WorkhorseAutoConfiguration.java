package run.workhorse.spring;

import io.opentelemetry.api.OpenTelemetry;
import jakarta.servlet.Filter;
import java.util.List;
import javax.sql.DataSource;
import org.apache.commons.logging.Log;
import org.apache.commons.logging.LogFactory;
import org.springframework.beans.factory.ListableBeanFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.SmartInitializingSingleton;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBooleanProperty;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnSingleCandidate;
import org.springframework.boot.autoconfigure.condition.ConditionalOnWebApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.health.autoconfigure.contributor.ConditionalOnEnabledHealthIndicator;
import org.springframework.boot.health.contributor.HealthIndicator;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
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
@ConditionalOnSingleCandidate(DataSource.class)
@EnableConfigurationProperties(WorkhorseProperties.class)
public final class WorkhorseAutoConfiguration {
  private static final Log LOG = LogFactory.getLog(WorkhorseAutoConfiguration.class);

  /** Created by Spring. */
  public WorkhorseAutoConfiguration() {}

  // The class stays public, so an application can name it in `exclude`. Each @Bean method is
  // package-private, so a new bean dependency does not change the public API in api/java.txt.

  /** The connection source that joins the current Spring transaction. */
  @Bean
  @ConditionalOnMissingBean
  ConnectionSource workhorseConnectionSource(DataSource dataSource) {
    return new TransactionAwareConnectionSource(dataSource);
  }

  /**
   * The queue. Its codec is the {@code JsonCodec} bean, or the core's default codec. Its telemetry
   * is the {@code WorkhorseTelemetry} bean, or the core's default telemetry.
   */
  @Bean
  @ConditionalOnMissingBean
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
  Admin workhorseAdmin(ConnectionSource connections) {
    return new Admin(connections);
  }

  /** The codec on the application's Jackson {@code JsonMapper}. */
  @Configuration(proxyBeanMethods = false)
  @ConditionalOnClass(JsonMapper.class)
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
  static class WorkerConfiguration {
    // Worker is AutoCloseable, so Spring calls close() when it destroys the bean. That runs before
    // the DataSource closes, and it waits for a drain that the lifecycle stop did not finish.
    @Bean
    @ConditionalOnMissingBean
    Worker workhorseWorker(
        DataSource dataSource,
        WorkhorseProperties properties,
        ObjectProvider<JsonCodec> codec,
        ObjectProvider<WorkhorseTelemetry> telemetry,
        ObjectProvider<TaskHandler<?>> handlers,
        ObjectProvider<WorkerCustomizer> customizers) {
      WorkhorseProperties.WorkerProperties options = properties.getWorker();
      Worker.Builder builder =
          Worker.builder(dataSource)
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
              .sharedHeartbeats(options.isSharedHeartbeats())
              .codec(codec.getIfAvailable(JsonCodec::standard));
      String workerId = options.getWorkerId();
      if (workerId != null) {
        builder.workerId(workerId);
      }
      var heartbeat = options.getHeartbeat();
      if (heartbeat != null) {
        builder.heartbeat(heartbeat);
      }
      var pollInterval = options.getPollInterval();
      if (pollInterval != null) {
        builder.pollInterval(pollInterval);
      }
      telemetry.ifAvailable(builder::telemetry);
      handlers.orderedStream().forEach(builder::handle);
      customizers.orderedStream().forEach(customizer -> customizer.customize(builder));
      return builder.build();
    }

    @Bean
    @ConditionalOnMissingBean
    WorkerLifecycle workhorseWorkerLifecycle(Worker worker) {
      return new WorkerLifecycle(worker);
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
   * TaskHandler} beans, but the worker is off.
   */
  @Configuration(proxyBeanMethods = false)
  @ConditionalOnBooleanProperty(
      name = "workhorse.worker.enabled",
      havingValue = false,
      matchIfMissing = true)
  static class WorkerOffConfiguration {
    @Bean
    static SmartInitializingSingleton workhorseWorkerOffWarning(ListableBeanFactory beans) {
      return () -> {
        String[] names = beans.getBeanNamesForType(TaskHandler.class, true, false);
        if (names.length > 0) {
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
