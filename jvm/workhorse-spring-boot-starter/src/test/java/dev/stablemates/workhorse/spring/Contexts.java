package dev.stablemates.workhorse.spring;

import dev.stablemates.workhorse.testing.ScratchDataSource;
import java.util.UUID;
import javax.sql.DataSource;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.jackson.autoconfigure.JacksonAutoConfiguration;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** The application contexts that the starter tests run. */
final class Contexts {
  private Contexts() {}

  /** A context with the starter and Jackson, and no DataSource. */
  static ApplicationContextRunner runner() {
    return new ApplicationContextRunner()
        .withConfiguration(
            AutoConfigurations.of(
                JacksonAutoConfiguration.class, WorkhorseAutoConfiguration.class));
  }

  /** A context on the scratch database. The test class extends {@code ScratchDatabase}. */
  static ApplicationContextRunner database() {
    return runner().withUserConfiguration(ScratchDataSourceConfiguration.class);
  }

  /** A queue name that no other test uses. */
  static String unique(String prefix) {
    return prefix + "-" + UUID.randomUUID();
  }

  @Configuration(proxyBeanMethods = false)
  static class ScratchDataSourceConfiguration {
    @Bean
    DataSource dataSource() {
      return new ScratchDataSource(true);
    }
  }
}
