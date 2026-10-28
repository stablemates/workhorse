package run.workhorse.spring;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.jspecify.annotations.Nullable;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * The {@code workhorse.*} properties (ADR 0103, "Spring Boot starter"). Each property has the
 * default of the core builder that it configures.
 */
@ConfigurationProperties("workhorse")
public class WorkhorseProperties {
  /**
   * The bean name of the DataSource that every Workhorse bean uses. When unset, the starter uses
   * the only DataSource bean or the @Primary one, and it builds no bean when neither exists.
   */
  private @Nullable String dataSource;

  private final QueueProperties queue = new QueueProperties();
  private final WorkerProperties worker = new WorkerProperties();
  private final DashboardProperties dashboard = new DashboardProperties();

  /**
   * The bean name of the {@code DataSource} that every Workhorse bean uses, or {@code null} for the
   * only {@code DataSource} bean or the {@code @Primary} one.
   */
  public @Nullable String getDataSource() {
    return dataSource;
  }

  /** Sets the bean name of the {@code DataSource} that every Workhorse bean uses. */
  public void setDataSource(@Nullable String dataSource) {
    this.dataSource = dataSource;
  }

  /** The properties of the {@code Queue} bean. */
  public QueueProperties getQueue() {
    return queue;
  }

  /** The properties of the {@code Worker} bean. */
  public WorkerProperties getWorker() {
    return worker;
  }

  /** The properties of the dashboard filter. */
  public DashboardProperties getDashboard() {
    return dashboard;
  }

  /** The {@code workhorse.queue.*} properties. */
  public static class QueueProperties {
    /** The queue of an enqueue request that names no queue. */
    private String defaultQueue = "default";

    /** The queue of an enqueue request that names no queue. */
    public String getDefaultQueue() {
      return defaultQueue;
    }

    /** Sets the default queue. */
    public void setDefaultQueue(String defaultQueue) {
      this.defaultQueue = defaultQueue;
    }
  }

  /** The {@code workhorse.worker.*} properties. */
  public static class WorkerProperties {
    /**
     * Whether the starter builds the worker, its lifecycle bean, and its health indicator. When
     * false, the application only enqueues, and no worker starts, whatever TaskHandler beans exist.
     */
    private boolean enabled;

    /** The queues the worker claims from, in claim order. */
    private List<String> queues = new ArrayList<>(List.of("default"));

    /**
     * The worker's ID in the fleet registry. The default is the host, the PID, and 8 hex digits.
     */
    private @Nullable String workerId;

    /** The most tasks the worker runs at once, from 1 to 100. */
    private int concurrency = 1;

    /** The lease that each claim and renewal grants, from 100 ms to 1 day. */
    private Duration lease = Duration.ofSeconds(30);

    /**
     * The interval between lease renewals. It must be less than the lease. The default is a third
     * of the lease. The smallest supported value is 100 ms. The worker accepts a shorter value, but
     * on a loaded host it can renew no lease.
     */
    private @Nullable Duration heartbeat;

    /**
     * The claim poll interval. Without it, a listening worker polls every 5 s, and a polling-only
     * worker starts at 250 ms and backs off toward 5 s while claims come back empty.
     */
    private @Nullable Duration pollInterval;

    /** Whether the worker polls only, with no LISTEN connection. */
    private boolean pollingOnly;

    /** The maintenance tick interval, at least 100 ms. */
    private Duration maintenanceInterval = Duration.ofSeconds(1);

    /** The retention routine offer interval, at least 100 ms. */
    private Duration maintenanceRoutineInterval = Duration.ofSeconds(60);

    /** The fleet registry interval, at least 100 ms. */
    private Duration registryInterval = Duration.ofSeconds(5);

    /**
     * Whether the worker stays out of the fleet registry, so that no operator can pause it
     * remotely.
     */
    private boolean disableRegistry;

    /** The schedule namespaces that the worker fires. */
    private List<String> scheduleNamespaces = new ArrayList<>();

    /** The most missed occurrences that one schedule fires, from 1 to 10,000. */
    private int scheduleCatchupLimit = 100;

    /**
     * How long a stopping worker waits for its handlers, up to 1 day. Keep
     * spring.lifecycle.timeout-per-shutdown-phase above this value and the unwind window.
     */
    private Duration shutdownGrace = Duration.ofSeconds(25);

    /**
     * The maximum size of the pool behind the DataSource, which a DataSource does not report. A
     * size below 3 stops the startup. Unset means an unknown size, and the readiness check of the
     * worker then checks the pool when it starts.
     */
    private @Nullable Integer poolMaxSize;

    /** Whether the starter builds the worker. */
    public boolean isEnabled() {
      return enabled;
    }

    /** Sets whether the starter builds the worker. */
    public void setEnabled(boolean enabled) {
      this.enabled = enabled;
    }

    /** The queues to claim from. */
    public List<String> getQueues() {
      return queues;
    }

    /** Sets the queues to claim from. */
    public void setQueues(List<String> queues) {
      this.queues = queues;
    }

    /** The worker ID, or {@code null} for the generated one. */
    public @Nullable String getWorkerId() {
      return workerId;
    }

    /** Sets the worker ID. */
    public void setWorkerId(@Nullable String workerId) {
      this.workerId = workerId;
    }

    /** The concurrency. */
    public int getConcurrency() {
      return concurrency;
    }

    /** Sets the concurrency. */
    public void setConcurrency(int concurrency) {
      this.concurrency = concurrency;
    }

    /** The lease. */
    public Duration getLease() {
      return lease;
    }

    /** Sets the lease. */
    public void setLease(Duration lease) {
      this.lease = lease;
    }

    /** The heartbeat interval, or {@code null} for a third of the lease. */
    public @Nullable Duration getHeartbeat() {
      return heartbeat;
    }

    /** Sets the heartbeat interval. */
    public void setHeartbeat(@Nullable Duration heartbeat) {
      this.heartbeat = heartbeat;
    }

    /** The poll interval, or {@code null} for the default. */
    public @Nullable Duration getPollInterval() {
      return pollInterval;
    }

    /** Sets the poll interval. */
    public void setPollInterval(@Nullable Duration pollInterval) {
      this.pollInterval = pollInterval;
    }

    /** Whether the worker polls only. */
    public boolean isPollingOnly() {
      return pollingOnly;
    }

    /** Sets whether the worker polls only. */
    public void setPollingOnly(boolean pollingOnly) {
      this.pollingOnly = pollingOnly;
    }

    /** The maintenance tick interval. */
    public Duration getMaintenanceInterval() {
      return maintenanceInterval;
    }

    /** Sets the maintenance tick interval. */
    public void setMaintenanceInterval(Duration maintenanceInterval) {
      this.maintenanceInterval = maintenanceInterval;
    }

    /** The retention routine offer interval. */
    public Duration getMaintenanceRoutineInterval() {
      return maintenanceRoutineInterval;
    }

    /** Sets the retention routine offer interval. */
    public void setMaintenanceRoutineInterval(Duration maintenanceRoutineInterval) {
      this.maintenanceRoutineInterval = maintenanceRoutineInterval;
    }

    /** The fleet registry interval. */
    public Duration getRegistryInterval() {
      return registryInterval;
    }

    /** Sets the fleet registry interval. */
    public void setRegistryInterval(Duration registryInterval) {
      this.registryInterval = registryInterval;
    }

    /** Whether the worker stays out of the fleet registry. */
    public boolean isDisableRegistry() {
      return disableRegistry;
    }

    /** Sets whether the worker stays out of the fleet registry. */
    public void setDisableRegistry(boolean disableRegistry) {
      this.disableRegistry = disableRegistry;
    }

    /** The schedule namespaces. */
    public List<String> getScheduleNamespaces() {
      return scheduleNamespaces;
    }

    /** Sets the schedule namespaces. */
    public void setScheduleNamespaces(List<String> scheduleNamespaces) {
      this.scheduleNamespaces = scheduleNamespaces;
    }

    /** The schedule catch-up limit. */
    public int getScheduleCatchupLimit() {
      return scheduleCatchupLimit;
    }

    /** Sets the schedule catch-up limit. */
    public void setScheduleCatchupLimit(int scheduleCatchupLimit) {
      this.scheduleCatchupLimit = scheduleCatchupLimit;
    }

    /** The shutdown grace. */
    public Duration getShutdownGrace() {
      return shutdownGrace;
    }

    /** Sets the shutdown grace. */
    public void setShutdownGrace(Duration shutdownGrace) {
      this.shutdownGrace = shutdownGrace;
    }

    /** The declared pool maximum size, or null when it is unknown. */
    public @Nullable Integer getPoolMaxSize() {
      return poolMaxSize;
    }

    /** Sets the declared pool maximum size. */
    public void setPoolMaxSize(@Nullable Integer poolMaxSize) {
      this.poolMaxSize = poolMaxSize;
    }
  }

  /** The {@code workhorse.dashboard.*} properties. */
  public static class DashboardProperties {
    /**
     * Whether the starter registers the dashboard filter in a servlet application. It needs a
     * DashboardAuthorizer bean.
     */
    private boolean enabled;

    /** The request path below the context path that the dashboard answers under. */
    private String path = "/workhorse";

    /** The environment name that the dashboard shows. */
    private String environment = "development";

    /** The audit actor for a request that the authorizer accepts with a bare allow. */
    private String auditActor = "dashboard";

    /** Whether the dashboard refuses every control and offers none in the browser. */
    private boolean readOnly;

    /** Extra browser module URLs that the dashboard shell loads. */
    private List<String> browserModules = new ArrayList<>();

    /** The worker IDs that the host expects, so that the dashboard can show a missing one. */
    private List<String> configuredWorkers = new ArrayList<>();

    /**
     * The host[:port] values that the dashboard answers to. When set, a request for another Host
     * receives 421 Misdirected Request. Leave it empty when the application already checks Host.
     */
    private List<String> allowedHosts = new ArrayList<>();

    /** Whether the starter registers the dashboard filter. */
    public boolean isEnabled() {
      return enabled;
    }

    /** Sets whether the starter registers the dashboard filter. */
    public void setEnabled(boolean enabled) {
      this.enabled = enabled;
    }

    /** The mount path. */
    public String getPath() {
      return path;
    }

    /** Sets the mount path. */
    public void setPath(String path) {
      this.path = path;
    }

    /** The environment name. */
    public String getEnvironment() {
      return environment;
    }

    /** Sets the environment name. */
    public void setEnvironment(String environment) {
      this.environment = environment;
    }

    /** The fallback audit actor. */
    public String getAuditActor() {
      return auditActor;
    }

    /** Sets the fallback audit actor. */
    public void setAuditActor(String auditActor) {
      this.auditActor = auditActor;
    }

    /** Whether the dashboard is read-only. */
    public boolean isReadOnly() {
      return readOnly;
    }

    /** Sets whether the dashboard is read-only. */
    public void setReadOnly(boolean readOnly) {
      this.readOnly = readOnly;
    }

    /** The extra browser module URLs. */
    public List<String> getBrowserModules() {
      return browserModules;
    }

    /** Sets the extra browser module URLs. */
    public void setBrowserModules(List<String> browserModules) {
      this.browserModules = browserModules;
    }

    /** The expected worker IDs. */
    public List<String> getConfiguredWorkers() {
      return configuredWorkers;
    }

    /** Sets the expected worker IDs. */
    public void setConfiguredWorkers(List<String> configuredWorkers) {
      this.configuredWorkers = configuredWorkers;
    }

    /** The allowed hosts. */
    public List<String> getAllowedHosts() {
      return allowedHosts;
    }

    /** Sets the allowed hosts. */
    public void setAllowedHosts(List<String> allowedHosts) {
      this.allowedHosts = allowedHosts;
    }
  }
}
