package workhorse

import (
	"context"
	"errors"
	"fmt"
	"sync"
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

// Is matches compatibility errors by refusal code.
func (err *CompatibilityError) Is(target error) bool {
	other, ok := target.(*CompatibilityError)
	return ok && other != nil && err.Code == other.Code
}

// CheckCompatibility compares an installed schema and client protocol version.
//
// The client declares a floor and no ceiling. Inside a major line a migration only adds, so a
// schema newer than the one this build was compiled against still carries every function it calls.
// The ceiling comes from servedProtocolVersions, which the installed schema declares in
// workhorse.protocol_version: a major release drops the client protocols it stops serving.
func CheckCompatibility(installedSchemaVersion *int, clientProtocolVersion int, servedProtocolVersions []int) error {
	var code CompatibilityCode
	switch {
	case installedSchemaVersion == nil:
		code = SchemaNotInstalled
	case *installedSchemaVersion < minimumSchemaVersion:
		code = SchemaTooOld
	case clientProtocolVersion < minimumProtocolVersion:
		code = ClientProtocolTooOld
	case clientProtocolVersion > maximumProtocolVersion:
		code = ClientProtocolTooNew
	default:
		served, oldest := servedProtocol(servedProtocolVersions, clientProtocolVersion)
		switch {
		case served:
			return nil
		case clientProtocolVersion < oldest:
			// The database crossed a major boundary and stopped answering this client.
			code = SchemaTooNew
		default:
			// The database has not been migrated far enough to answer this client yet.
			code = SchemaTooOld
		}
	}
	return &CompatibilityError{Code: code}
}

// servedProtocol reports whether the installed schema answers this client, and the oldest protocol
// it still answers. An empty declaration is treated as serving every client, because a schema that
// records nothing has made no statement to enforce.
func servedProtocol(servedProtocolVersions []int, clientProtocolVersion int) (bool, int) {
	if len(servedProtocolVersions) == 0 {
		return true, clientProtocolVersion
	}
	oldest := servedProtocolVersions[0]
	for _, version := range servedProtocolVersions {
		if version < oldest {
			oldest = version
		}
		if version == clientProtocolVersion {
			return true, oldest
		}
	}
	return false, oldest
}

// AssertSchemaCompatible reads the installed schema on every call. One statement returns both the
// schema version and the client protocols the schema declares it serves, so the check stays one
// round trip.
func AssertSchemaCompatible(ctx context.Context, executor Executor) error {
	rows, err := executor.Query(ctx, internalStatementRegistry[compatibilityStateStatement])
	if err != nil {
		if hasSQLState(err, "42P01", "3F000") {
			return &CompatibilityError{Code: SchemaNotInstalled}
		}
		return err
	}

	var schemaVersions []int
	var served []int
	for _, row := range rows {
		version, ok := integer(row["version"])
		if !ok {
			continue
		}
		switch row[compatibilityKindColumn] {
		case compatibilityKindSchema:
			schemaVersions = append(schemaVersions, version)
		case compatibilityKindProtocol:
			served = append(served, version)
		}
	}

	var installed *int
	if len(schemaVersions) == 1 {
		installed = &schemaVersions[0]
	}
	return CheckCompatibility(installed, ProtocolVersion, served)
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
		check.err = AssertSchemaCompatible(ctx, check.executor)
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
