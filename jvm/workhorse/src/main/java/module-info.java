/**
 * Workhorse for Java: a durable task queue whose state lives in PostgreSQL.
 *
 * <p>The module exports the public packages only. {@code run.workhorse.internal} stays private to
 * the SDK.
 */
module run.workhorse {
  exports run.workhorse;
  exports run.workhorse.dashboard;

  requires transitive java.sql;
  requires transitive org.jspecify;
  requires org.postgresql.jdbc;
  requires static transitive jakarta.servlet;
  requires static io.opentelemetry.api;
  requires static io.opentelemetry.context;
}
