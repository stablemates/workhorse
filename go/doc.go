// Package workhorse provides the public beta Go client and worker for the Workhorse durable job
// queue for PostgreSQL. During 0.x, a minor release may change behaviour, but the schema upgrades
// in place: migrations are ordered, and inside a major line a migration only adds.
package workhorse
