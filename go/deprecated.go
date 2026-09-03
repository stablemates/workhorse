package workhorse

import "context"

// The names in this file are the pre-rename spellings of symbols the TypeScript and Python SDKs
// already agreed on. Each one still works for the rest of the 0.x line so no caller has to change
// on this release. All of them are removed in 1.0.0.

// AssertCompatible reads the installed schema and reports whether this client may mutate it.
//
// Deprecated: renamed to AssertSchemaCompatible, which is the name the other two SDKs share.
func AssertCompatible(ctx context.Context, executor Executor) error {
	return AssertSchemaCompatible(ctx, executor)
}

// CreateChild creates one named child or joins its retained result after parent replay.
//
// Deprecated: renamed to RunChild, which is the name the other two SDKs share.
func (handler *HandlerContext) CreateChild(
	name string,
	jobType string,
	payload any,
	options ...EnqueueOptions,
) (any, error) {
	return handler.RunChild(name, jobType, payload, options...)
}

// CreateChildren creates one bounded child set or joins its results after parent replay.
//
// Deprecated: renamed to RunChildren, which is the name the other two SDKs share.
func (handler *HandlerContext) CreateChildren(children []ChildJobRequest) ([]ChildResult, error) {
	return handler.RunChildren(children)
}

// CreateChildrenAll preserves propagation semantics and returns only successful child results.
//
// Deprecated: renamed to RunChildrenAll, which is the name the other two SDKs share.
func (handler *HandlerContext) CreateChildrenAll(children []ChildJobRequest) ([]ChildSuccessResult, error) {
	return handler.RunChildrenAll(children)
}

// IncompatibleKeyMode, NotPending, and WindowElapsedPending name the three reasons PostgreSQL
// retains a debounced job. They carry the same values as the NonReplaceable-prefixed constants that
// replace them, so a comparison against either spelling behaves the same way.
//
// Deprecated: every other constant group in this package carries its enum prefix. Use the
// NonReplaceable-prefixed spelling of each reason.
const (
	IncompatibleKeyMode  EnqueueNonReplaceableReason = reasonIncompatibleKeyModeValue
	NotPending           EnqueueNonReplaceableReason = reasonNotPendingValue
	WindowElapsedPending EnqueueNonReplaceableReason = reasonWindowElapsedValue
)
