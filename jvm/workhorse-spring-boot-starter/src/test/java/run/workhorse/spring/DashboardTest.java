package run.workhorse.spring;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.test.context.assertj.AssertableWebApplicationContext;
import org.springframework.boot.test.context.runner.WebApplicationContextRunner;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import run.workhorse.dashboard.Dashboard;
import run.workhorse.dashboard.DashboardAuthorization;
import run.workhorse.dashboard.DashboardAuthorizer;
import run.workhorse.testing.ScratchDatabase;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** The dashboard filter on the scratch database. */
@ExtendWith(ScratchDatabase.class)
class DashboardTest {
  private static WebApplicationContextRunner dashboard() {
    return Contexts.webDatabase()
        .withBean(DashboardAuthorizer.class, () -> request -> DashboardAuthorization.allow())
        .withPropertyValues("workhorse.dashboard.enabled=true");
  }

  /** The {@code tickIntervalMs} that the {@code cron} procedure reports. */
  private static long tickIntervalMs(Dashboard dashboard) throws Exception {
    MockHttpServletRequest request =
        new MockHttpServletRequest("POST", "/workhorse/rpc/dashboard/cron");
    request.setContentType("application/json");
    request.setContent("{}".getBytes(StandardCharsets.UTF_8));
    MockHttpServletResponse response = new MockHttpServletResponse();
    dashboard.doFilter(request, response, new MockFilterChain());
    assertThat(response.getStatus()).as(response.getContentAsString()).isEqualTo(200);
    JsonNode body = JsonMapper.builder().build().readTree(response.getContentAsString());
    JsonNode tick = body.findValue("tickIntervalMs");
    assertThat(tick).as(response.getContentAsString()).isNotNull();
    return tick.asLong();
  }

  private static Dashboard filter(AssertableWebApplicationContext context) {
    return (Dashboard)
        context.getBean("workhorseDashboard", FilterRegistrationBean.class).getFilter();
  }

  @Test
  void theDashboardReportsTheConfiguredMaintenanceInterval() {
    dashboard()
        .withPropertyValues("workhorse.worker.maintenance-interval=250ms")
        .run(context -> assertThat(tickIntervalMs(filter(context))).isEqualTo(250));
  }

  @Test
  void theDashboardReportsTheDefaultMaintenanceInterval() {
    dashboard().run(context -> assertThat(tickIntervalMs(filter(context))).isEqualTo(1000));
  }

  @Test
  void aCustomizerCanReplaceTheMaintenanceLoops() {
    dashboard()
        .withPropertyValues("workhorse.worker.maintenance-interval=250ms")
        .withBean(
            DashboardCustomizer.class,
            () -> builder -> builder.maintenanceLoops(Map.of("tickIntervalMs", 5000L)))
        .run(context -> assertThat(tickIntervalMs(filter(context))).isEqualTo(5000));
  }
}
