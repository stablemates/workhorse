// The dashboard filter from Kotlin: the site page about the dashboard.

package run.workhorse.examples

import jakarta.servlet.DispatcherType
import jakarta.servlet.ServletContext
import jakarta.servlet.http.HttpServletRequest
import java.util.EnumSet
import javax.sql.DataSource
import run.workhorse.ConnectionSource
import run.workhorse.dashboard.Dashboard
import run.workhorse.dashboard.DashboardAuthorization

/** Registers the dashboard filter on [servletContext]. [session] reads the application user. */
fun registerDashboard(
  servletContext: ServletContext,
  dataSource: DataSource,
  session: (HttpServletRequest) -> String?,
) {
  fun applicationAdminSession(request: HttpServletRequest): String? = session(request)
  // docs:start kotlin-dashboard-filter
  val dashboard =
    Dashboard.builder(ConnectionSource.of(dataSource)) { request ->
        val username = applicationAdminSession(request)
        if (username != null) DashboardAuthorization.principal(username)
        else DashboardAuthorization.deny()
      }
      .path("/workhorse")
      .environment("production")
      .allowedHosts(listOf("ops.example.com"))
      .build()
  servletContext
    .addFilter("workhorse-dashboard", dashboard)
    .addMappingForUrlPatterns(EnumSet.of(DispatcherType.REQUEST), false, "/*")
  // docs:end
}
