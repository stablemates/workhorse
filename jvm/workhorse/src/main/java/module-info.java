/**
 * Workhorse for Java: a durable task queue whose state lives in PostgreSQL.
 *
 * <p>The module exports the public packages only. {@code dev.stablemates.workhorse.internal} stays
 * private to the SDK.
 */
module dev.stablemates.workhorse {
  exports dev.stablemates.workhorse;
  exports dev.stablemates.workhorse.dashboard;

  requires transitive java.sql;
  requires transitive org.jspecify;
  requires org.postgresql.jdbc;
  requires static transitive jakarta.servlet;
  requires static io.opentelemetry.api;
  requires static io.opentelemetry.context;
}
