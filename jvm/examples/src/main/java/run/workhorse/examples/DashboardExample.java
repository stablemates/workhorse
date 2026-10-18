package run.workhorse.examples;

import jakarta.servlet.DispatcherType;
import jakarta.servlet.ServletContext;
import jakarta.servlet.http.HttpServletRequest;
import java.util.EnumSet;
import java.util.List;
import java.util.function.Function;
import javax.sql.DataSource;
import org.jspecify.annotations.Nullable;
import run.workhorse.ConnectionSource;
import run.workhorse.dashboard.Dashboard;
import run.workhorse.dashboard.DashboardAuthorization;

/** The Java dashboard filter: guide 370 and the site page about the dashboard. */
public final class DashboardExample {
  private final DataSource dataSource;
  private final Function<HttpServletRequest, @Nullable String> session;

  /** {@code session} reads the user name of the application session, or null. */
  public DashboardExample(
      DataSource dataSource, Function<HttpServletRequest, @Nullable String> session) {
    this.dataSource = dataSource;
    this.session = session;
  }

  private @Nullable String applicationAdminSession(HttpServletRequest request) {
    return session.apply(request);
  }

  /** Registers the dashboard filter on {@code servletContext}. */
  public void register(ServletContext servletContext) {
    // docs:start java-dashboard-filter
    Dashboard dashboard =
        Dashboard.builder(
                ConnectionSource.of(dataSource),
                request -> {
                  String username = applicationAdminSession(request);
                  return username != null
                      ? DashboardAuthorization.principal(username)
                      : DashboardAuthorization.deny();
                })
            .path("/workhorse")
            .environment("production")
            .allowedHosts(List.of("ops.example.com"))
            .build();
    servletContext
        .addFilter("workhorse-dashboard", dashboard)
        .addMappingForUrlPatterns(EnumSet.of(DispatcherType.REQUEST), false, "/*");
    // docs:end
  }
}
