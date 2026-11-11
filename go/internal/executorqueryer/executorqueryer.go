// Package executorqueryer gives the packages of this module the driver value inside an Executor
// that NewPGXExecutor or NewSQLExecutor made. The dashboard uses it to hold one connection for a
// bounded read. It adds no public accessor to the workhorse package.
package executorqueryer

// Of returns the driver value that executor wraps and true. It returns nil and false for an
// Executor that this module did not make. The workhorse package sets it when it initializes.
var Of = func(executor any) (any, bool) { return nil, false }
