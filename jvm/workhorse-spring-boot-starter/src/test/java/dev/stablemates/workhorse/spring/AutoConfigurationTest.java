package dev.stablemates.workhorse.spring;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import dev.stablemates.workhorse.Admin;
import dev.stablemates.workhorse.ConnectionSource;
import dev.stablemates.workhorse.JsonCodec;
import dev.stablemates.workhorse.Queue;
import dev.stablemates.workhorse.dashboard.Dashboard;
import dev.stablemates.workhorse.dashboard.DashboardAuthorization;
import dev.stablemates.workhorse.dashboard.DashboardAuthorizer;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import javax.sql.DataSource;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringBootVersion;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;

/** The beans the starter builds without a database. */
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
}
