# ADR 0065: Publish the verified SQLAlchemy transaction accessor

- **Status:** Accepted
- **Date:** 2026-09-12
- **Related:** SM-27, [ADR 0033](0033-maintain-site-docs-as-a-guide-consumer.md),
  [ADR 0049](0049-publish-one-agent-documentation-layer.md)

## Context

The Python `Queue` needs a Psycopg connection so an enqueue can join the caller's transaction.
SQLAlchemy applications instead hold a SQLAlchemy `Connection`, which wraps the driver connection.

The agent integration baseline guessed how to unwrap that connection. Publishing the guess would
make a private implementation detail look supported without proving its transaction behavior.

SQLAlchemy 2 exposes the pool-proxied connection as `Connection.connection`. Its documented
`driver_connection` attribute returns the connection used by the database driver.

## Decision

Workhorse supports SQLAlchemy's synchronous Psycopg dialect through
`sqlalchemy_connection.connection.driver_connection`. The application passes that object to
`Queue` while SQLAlchemy's transaction is open.

An integration test names the complete accessor chain. It proves a business row and task become
visible together after commit and remain absent together after rollback.

SQLAlchemy remains a Python development dependency. It is absent from the package's runtime
dependencies and optional dependencies, so applications that do not use it install nothing extra.

The result is published only on `/docs/enqueue`, including its generated Markdown twin. The agent
playbook already links there for exact transaction guidance, so repeating the snippet would create
a second owner. The guide remains driver-neutral and keeps the transaction concept as its subject.

## Consequences

Python applications using SQLAlchemy can enqueue without opening a second connection or owning an
outbox. SQLAlchemy continues to control commit, rollback, and pool return.

A SQLAlchemy release that removes or changes either accessor breaks the integration test. Workhorse
can then revise or withdraw the page before claiming support for that release.
