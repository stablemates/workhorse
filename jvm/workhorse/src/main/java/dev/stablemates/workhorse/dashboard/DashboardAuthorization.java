package dev.stablemates.workhorse.dashboard;

import java.util.Objects;

/**
 * What a {@link DashboardAuthorizer} decides for one request: a principal, a bare allow, or a deny.
 * The counterpart of the {@code Principal}, {@code true}, and {@code false} that Ruby's {@code
 * authorize} callable returns.
 */
public sealed interface DashboardAuthorization
    permits DashboardAuthorization.Principal,
        DashboardAuthorization.Allow,
        DashboardAuthorization.Deny {
  /** Accepts the request with the dashboard's audit actor. */
  static DashboardAuthorization allow() {
    return Allow.INSTANCE;
  }

  /** Refuses the request. The dashboard answers 401. */
  static DashboardAuthorization deny() {
    return Deny.INSTANCE;
  }

  /** Accepts the request for a verified identity, which names the actor of each control. */
  static DashboardAuthorization principal(String actor) {
    return new Principal(actor);
  }

  /**
   * An identity that the host application's authorization boundary established.
   *
   * @param actor the actor that PostgreSQL records for each control of the request
   */
  record Principal(String actor) implements DashboardAuthorization {
    /** Requires an actor. */
    public Principal {
      Objects.requireNonNull(actor, "actor");
    }
  }

  /** A bare allow. The dashboard uses its audit actor. */
  record Allow() implements DashboardAuthorization {
    private static final Allow INSTANCE = new Allow();
  }

  /** A deny. */
  record Deny() implements DashboardAuthorization {
    private static final Deny INSTANCE = new Deny();
  }
}
