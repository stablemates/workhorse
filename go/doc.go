// Package workhorse provides the Go client and worker for the Workhorse durable task queue for
// PostgreSQL. From 1.0.0 the module follows Semantic Versioning: a 1.x minor or patch release does
// not break the exported API. The schema upgrades in place: migrations are ordered, and inside a
// major line a migration only adds.
package workhorse
