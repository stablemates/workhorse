package run.workhorse.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.sql.Connection;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.SpringBootVersion;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.context.annotation.ImportCandidates;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import run.workhorse.Admin;
import run.workhorse.ConnectionSource;
import run.workhorse.JsonCodec;
import run.workhorse.Queue;
import run.workhorse.dashboard.Dashboard;
import run.workhorse.dashboard.DashboardAuthorization;
import run.workhorse.dashboard.DashboardAuthorizer;

/** The beans the starter builds without a database. */
@ExtendWith(OutputCaptureExtension.class)
class AutoConfigurationTest {
  private static WebApplicationContextRunner web() {
    return new WebApplicationContextRunner()
        .withConfiguration(AutoConfigurations.of(WorkhorseAutoConfiguration.class))
        .withBean(DataSource.class, () -> mock(DataSource.class));
  }

  @Test
  void runsOnTheSelectedSpringBootLine() {
    // The build passes -Pworkhorse.springBoot to the tests, so each CI job proves its line.
    String line = System.getProperty("workhorse.springBoot", "4.0");
    String version = SpringBootVersion.getVersion();
    if (line.equals("snapshot")) {
      assertThat(version).endsWith("-SNAPSHOT");
    } else {
      assertThat(version).startsWith(line + ".");
    }
  }

  @Test
  void registersTheAutoConfigurationInTheImportsFile() {
    // Spring Boot finds the starter only through this file, so it must name the class exactly.
    List<String> candidates =
        ImportCandidates.load(AutoConfiguration.class, getClass().getClassLoader()).getCandidates();
    assertThat(candidates).contains(WorkhorseAutoConfiguration.class.getName());
  }

  @Test
  void keepsEveryBeanMethodOutOfThePublicApi() throws NoSuchMethodException {
    // An application names the class in `exclude`, so the class and its constructor stay public.
    assertThat(Modifier.isPublic(WorkhorseAutoConfiguration.class.getModifiers())).isTrue();
    assertThat(Modifier.isPublic(WorkhorseAutoConfiguration.class.getConstructor().getModifiers()))
        .isTrue();
    List<Method> beans = new ArrayList<>();
    Deque<Class<?>> classes = new ArrayDeque<>(List.of(WorkhorseAutoConfiguration.class));
    while (!classes.isEmpty()) {
      Class<?> type = classes.pop();
      classes.addAll(List.of(type.getDeclaredClasses()));
      for (Method method : type.getDeclaredMethods()) {
        if (method.isAnnotationPresent(Bean.class)) {
          beans.add(method);
        }
      }
    }
    assertThat(beans)
        .extracting(Method::getName)
        .contains("workhorseConnectionSource", "workhorseQueue", "workhorseAdmin");
    assertThat(beans)
        .filteredOn(method -> Modifier.isPublic(method.getModifiers()))
        .extracting(Method::getName)
        .isEmpty();
  }

  @Test
  void buildsTheClientBeansOnTheTransactionAwareSource() {
    Contexts.runner()
        .withBean(DataSource.class, () -> mock(DataSource.class))
        .run(
            context -> {
              assertThat(context).hasSingleBean(Queue.class).hasSingleBean(Admin.class);
              assertThat(context.getBean(ConnectionSource.class))
                  .isInstanceOf(TransactionAwareConnectionSource.class);
              assertThat(context.getBean(JsonCodec.class)).isInstanceOf(JacksonJsonCodec.class);
            });
  }

  @Test
  void buildsNothingWithoutADataSource() {
    Contexts.runner().run(context -> assertThat(context).doesNotHaveBean(Queue.class));
  }

  @Test
  void backsOffForTheApplicationsOwnBeans() {
    ConnectionSource own = mock(ConnectionSource.class);
    JsonCodec codec = JsonCodec.standard();
    Contexts.runner()
        .withBean(DataSource.class, () -> mock(DataSource.class))
        .withBean(ConnectionSource.class, () -> own)
        .withBean(JsonCodec.class, () -> codec)
        .run(
            context -> {
              assertThat(context.getBean(ConnectionSource.class)).isSameAs(own);
              assertThat(context.getBean(JsonCodec.class)).isSameAs(codec);
            });
  }

  @Test
  void registersNoDashboardByDefault() {
    web()
        .withBean(DashboardAuthorizer.class, () -> request -> DashboardAuthorization.allow())
        .run(context -> assertThat(context).doesNotHaveBean(FilterRegistrationBean.class));
  }

  @Test
  void registersTheDashboardWhenEnabled() {
    web()
        .withBean(DashboardAuthorizer.class, () -> request -> DashboardAuthorization.allow())
        .withBean(DashboardCustomizer.class, () -> builder -> builder.readOnly(true))
        .withPropertyValues(
            "workhorse.dashboard.enabled=true", "workhorse.dashboard.path=/ops/jobs")
        .run(
            context -> {
              FilterRegistrationBean<?> registration =
                  context.getBean("workhorseDashboard", FilterRegistrationBean.class);
              assertThat(registration.getUrlPatterns()).containsExactly("/*");
              Dashboard dashboard = (Dashboard) registration.getFilter();
              assertThat(dashboard.basePath()).isEqualTo("/ops/jobs");
            });
  }

  @Test
  void refusesAnEnabledDashboardWithoutAnAuthorizer() {
    web()
        .withPropertyValues("workhorse.dashboard.enabled=true")
        .run(
            context ->
                assertThat(context)
                    .getFailure()
                    .rootCause()
                    .hasMessageContaining("DashboardAuthorizer"));
  }

  @Test
  void registersNoDashboardOutsideAServletApplication() {
    Contexts.runner()
        .withBean(DataSource.class, () -> mock(DataSource.class))
        .withBean(DashboardAuthorizer.class, () -> request -> DashboardAuthorization.allow())
        .withPropertyValues("workhorse.dashboard.enabled=true")
        .run(context -> assertThat(context).doesNotHaveBean(FilterRegistrationBean.class));
  }

  /** A data source whose connections are mocks, so a test can see which source served a call. */
  private static DataSource dataSource() throws Exception {
    DataSource dataSource = mock(DataSource.class);
    when(dataSource.getConnection()).thenAnswer(invocation -> mock(Connection.class));
    return dataSource;
  }

  @Test
  void backsOffWithOneWarningForSeveralDataSourcesAndNoSelection(CapturedOutput output) {
    Contexts.runner()
        .withBean("ordersDataSource", DataSource.class, () -> mock(DataSource.class))
        .withBean("reportsDataSource", DataSource.class, () -> mock(DataSource.class))
        .run(
            context -> {
              assertThat(context).hasNotFailed();
              assertThat(context)
                  .doesNotHaveBean(Queue.class)
                  .doesNotHaveBean(Admin.class)
                  .doesNotHaveBean(ConnectionSource.class)
                  .doesNotHaveBean(JsonCodec.class);
            });
    assertThat(output)
        .containsOnlyOnce("workhorse.data-source")
        .contains("@Primary")
        .contains("ordersDataSource")
        .contains("reportsDataSource");
  }

  @Test
  void logsNoBackOffWarningForASingleDataSource(CapturedOutput output) {
    Contexts.runner()
        .withBean(DataSource.class, () -> mock(DataSource.class))
        .run(context -> assertThat(context).hasSingleBean(Queue.class));
    assertThat(output).doesNotContain("workhorse.data-source");
  }

  @Test
  void usesTheDataSourceThatThePropertyNames() throws Exception {
    DataSource orders = dataSource();
    DataSource jobs = dataSource();
    Contexts.runner()
        .withBean("ordersDataSource", DataSource.class, () -> orders)
        .withBean("jobsDataSource", DataSource.class, () -> jobs)
        .withPropertyValues("workhorse.data-source=jobsDataSource")
        .run(
            context -> {
              assertThat(context).hasSingleBean(Queue.class).hasSingleBean(Admin.class);
              ConnectionSource connections = context.getBean(ConnectionSource.class);
              connections.release(connections.acquire(), false);
              verify(jobs).getConnection();
              verify(orders, never()).getConnection();
            });
  }

  @Test
  void thePropertyWinsOverAPrimaryDataSource() throws Exception {
    DataSource orders = dataSource();
    DataSource jobs = dataSource();
    Contexts.runner()
        .withBean("ordersDataSource", DataSource.class, () -> orders, bean -> bean.setPrimary(true))
        .withBean("jobsDataSource", DataSource.class, () -> jobs)
        .withPropertyValues("workhorse.data-source=jobsDataSource")
        .run(
            context -> {
              ConnectionSource connections = context.getBean(ConnectionSource.class);
              connections.release(connections.acquire(), false);
              verify(jobs).getConnection();
              verify(orders, never()).getConnection();
            });
  }

  @Test
  void refusesAPropertyThatNamesNoDataSourceBean() {
    Contexts.runner()
        .withBean("ordersDataSource", DataSource.class, () -> mock(DataSource.class))
        .withPropertyValues("workhorse.data-source=jobsDataSource")
        .run(
            context ->
                assertThat(context)
                    .getFailure()
                    .rootCause()
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("workhorse.data-source")
                    .hasMessageContaining("jobsDataSource"));
  }

  @Test
  void refusesAMissingNamedDataSourceWhenTheApplicationDefinesEveryBean() {
    Contexts.runner()
        .withBean("ordersDataSource", DataSource.class, () -> mock(DataSource.class))
        .withBean(ConnectionSource.class, () -> mock(ConnectionSource.class))
        .withBean(Queue.class, () -> new Queue(mock(ConnectionSource.class)))
        .withBean(Admin.class, () -> new Admin(mock(ConnectionSource.class)))
        .withPropertyValues("workhorse.data-source=jobsDataSource")
        .run(
            context ->
                assertThat(context)
                    .getFailure()
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("workhorse.data-source")
                    .hasMessageContaining("jobsDataSource"));
  }

  @Test
  void refusesTheValueFalseWhenNoDataSourceBeanHasThatName() {
    Contexts.runner()
        .withBean("ordersDataSource", DataSource.class, () -> mock(DataSource.class))
        .withBean("reportsDataSource", DataSource.class, () -> mock(DataSource.class))
        .withPropertyValues("workhorse.data-source=false")
        .run(
            context ->
                assertThat(context)
                    .getFailure()
                    .hasRootCauseInstanceOf(IllegalStateException.class)
                    .hasStackTraceContaining("workhorse.data-source=false"));
  }

  /**
   * SM-1902: {@code workhorse.worker.shared-heartbeats} is removed. In each relaxed form and with
   * each value, the context does not start, also when the starter selects no DataSource.
   */
  @Test
  void refusesTheRemovedSharedHeartbeatsProperty() {
    for (String property :
        List.of(
            "workhorse.worker.shared-heartbeats=true",
            "workhorse.worker.sharedHeartbeats=false",
            "workhorse.worker.shared_heartbeats=true")) {
      Contexts.runner()
          .withPropertyValues(property)
          .run(
              context ->
                  assertThat(context)
                      .getFailure()
                      .as(property)
                      .isInstanceOf(IllegalStateException.class)
                      .hasMessageContaining("workhorse.worker.shared-heartbeats")
                      .hasMessageContaining("removed")
                      .hasMessageContaining("a known maximum size of at least 3"));
    }
    Contexts.runner()
        .withPropertyValues("workhorse.worker.pool-max-size=3")
        .run(context -> assertThat(context).hasNotFailed());
  }

  @Test
  void acceptsAPrimaryDashboardAuthorizerAmongSeveral() {
    web()
        .withBean(
            "primaryAuthorizer",
            DashboardAuthorizer.class,
            () -> request -> DashboardAuthorization.allow(),
            bean -> bean.setPrimary(true))
        .withBean(
            "otherAuthorizer",
            DashboardAuthorizer.class,
            () -> request -> DashboardAuthorization.deny())
        .withPropertyValues("workhorse.dashboard.enabled=true")
        .run(context -> assertThat(context).hasBean("workhorseDashboard"));
  }

  @Test
  void refusesSeveralDashboardAuthorizersWithoutAPrimaryOne() {
    web()
        .withBean(
            "firstAuthorizer",
            DashboardAuthorizer.class,
            () -> request -> DashboardAuthorization.allow())
        .withBean(
            "otherAuthorizer",
            DashboardAuthorizer.class,
            () -> request -> DashboardAuthorization.deny())
        .withPropertyValues("workhorse.dashboard.enabled=true")
        .run(
            context ->
                assertThat(context)
                    .getFailure()
                    .rootCause()
                    .hasMessageContaining("DashboardAuthorizer"));
  }
}
