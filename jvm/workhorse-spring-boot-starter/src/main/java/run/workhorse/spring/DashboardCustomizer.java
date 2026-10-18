package run.workhorse.spring;

import run.workhorse.dashboard.Dashboard;

/**
 * Changes the {@link Dashboard.Builder} of the starter's dashboard filter after the {@code
 * workhorse.dashboard.*} properties apply. A bean of this type can set the options that have no
 * property, such as procedures or maintenance loops.
 */
@FunctionalInterface
public interface DashboardCustomizer {
  /** Changes {@code builder}. */
  void customize(Dashboard.Builder builder);
}
