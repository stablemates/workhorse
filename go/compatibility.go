package workhorse

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

const (
	// ProtocolVersion is the SQL protocol version implemented by this module.
	ProtocolVersion        = 1
	minimumProtocolVersion = 1
	maximumProtocolVersion = 1
	minimumSchemaVersion   = 47
	maximumSchemaVersion   = 47
)

// CompatibilityCode identifies why a client must refuse a mutation.
type CompatibilityCode string

const (
	SchemaNotInstalled   CompatibilityCode = "schema-not-installed"
	SchemaTooOld         CompatibilityCode = "schema-too-old"
	SchemaTooNew         CompatibilityCode = "schema-too-new"
	ClientProtocolTooOld CompatibilityCode = "client-protocol-too-old"
	ClientProtocolTooNew CompatibilityCode = "client-protocol-too-new"
)

// CompatibilityError refuses a mutation against an incompatible SQL protocol.
type CompatibilityError struct {
	Code CompatibilityCode
}

func (err *CompatibilityError) Error() string {
	return fmt.Sprintf("SQL protocol compatibility check refused mutation: %s", err.Code)
}

// CheckCompatibility compares an installed schema and client protocol version.
func CheckCompatibility(installedSchemaVersion *int, clientProtocolVersion int) error {
	var code CompatibilityCode
	switch {
	case installedSchemaVersion == nil:
		code = SchemaNotInstalled
	case *installedSchemaVersion < minimumSchemaVersion:
		code = SchemaTooOld
	case *installedSchemaVersion > maximumSchemaVersion:
		code = SchemaTooNew
	case clientProtocolVersion < minimumProtocolVersion:
		code = ClientProtocolTooOld
	case clientProtocolVersion > maximumProtocolVersion:
		code = ClientProtocolTooNew
	default:
		return nil
	}
	return &CompatibilityError{Code: code}
}

// AssertCompatible reads the installed schema on every call.
func AssertCompatible(ctx context.Context, executor Executor) error {
	rows, err := executor.Query(ctx, internalStatementRegistry[schemaVersionStatement])
	if err != nil {
		if hasSQLState(err, "42P01", "3F000") {
			return &CompatibilityError{Code: SchemaNotInstalled}
		}
		return err
	}

	var installed *int
	if len(rows) == 1 {
		if version, ok := integer(rows[0]["version"]); ok {
			installed = &version
		}
	}
	return CheckCompatibility(installed, ProtocolVersion)
}

// CachedCompatibilityCheck runs one compatibility query and reuses its result.
type CachedCompatibilityCheck struct {
	executor Executor
	once     sync.Once
	err      error
}

// NewCachedCompatibilityCheck builds the opt-in one-shot gate for hot worker loops.
func NewCachedCompatibilityCheck(executor Executor) *CachedCompatibilityCheck {
	return &CachedCompatibilityCheck{executor: executor}
}

// Assert returns the result of the first compatibility query for every call.
func (check *CachedCompatibilityCheck) Assert(ctx context.Context) error {
	check.once.Do(func() {
		check.err = AssertCompatible(ctx, check.executor)
	})
	return check.err
}

type sqlStateCarrier interface {
	SQLState() string
}

func hasSQLState(err error, states ...string) bool {
	var carrier sqlStateCarrier
	if !errors.As(err, &carrier) {
		return false
	}
	for _, state := range states {
		if carrier.SQLState() == state {
			return true
		}
	}
	return false
}

func integer(value any) (int, bool) {
	switch value := value.(type) {
	case int:
		return value, true
	case int16:
		return int(value), true
	case int32:
		return int(value), true
	case int64:
		return int(value), true
	default:
		return 0, false
	}
}
