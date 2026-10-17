/**
 * Workhorse for Java: a durable task queue whose state lives in PostgreSQL.
 *
 * <p>The module exports the public packages only. {@code dev.stablemates.workhorse.internal} stays
 * private to the SDK. The first public type adds {@code exports dev.stablemates.workhorse}, because
 * a module cannot export an empty package.
 */
module dev.stablemates.workhorse {
  requires transitive java.sql;
  requires transitive org.jspecify;
  requires org.postgresql.jdbc;
}
