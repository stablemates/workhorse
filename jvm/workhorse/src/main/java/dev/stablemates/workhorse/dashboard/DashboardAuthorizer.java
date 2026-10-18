package dev.stablemates.workhorse.dashboard;

import jakarta.servlet.http.HttpServletRequest;

/**
 * The host application's authorization boundary for the dashboard. The counterpart of Ruby's {@code
 * authorize} callable.
 *
 * <p>The dashboard calls it for each request under its mount path, after the {@code allowedHosts}
 * check and before any other work.
 */
@FunctionalInterface
public interface DashboardAuthorizer {
  /**
   * Decides one request.
   *
   * @param request the request, with the host's session and credentials
   * @return a principal, an allow, or a deny
   * @throws Exception if the decision fails; the dashboard reports it to the servlet container
   */
  DashboardAuthorization authorize(HttpServletRequest request) throws Exception;
}
