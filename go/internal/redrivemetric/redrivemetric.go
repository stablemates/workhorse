// Package redrivemetric counts the redrive_v1 and redrive_many_v1 results of the admin.
//
// It follows the cancellationmetric package. A worker binds its instruments when it is
// constructed. An admin has no such moment that every caller passes before it registers a meter
// provider. Thus Record reads the global meter provider on each call. A redrive is an operator
// action, so the lookup costs little. The dashboard calls the admin, so it counts the same result.
package redrivemetric

import (
	"context"
	"fmt"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"
)

const (
	instrumentationName = "github.com/stablemates/workhorse/go"
	instrumentName      = "workhorse.tasks.redrive"
	description         = "Task redrive requests by durable result"
	unit                = "{request}"
	statusAttribute     = "workhorse.redrive.status"
)

// initialProviderType is the type of the global delegate that OpenTelemetry installs before the
// process registers a provider. The check uses the type, not the value at package start, because
// another package can register a provider before this package starts.
const initialProviderType = "*global.meterProvider"

// isInitialProvider reports whether provider is the global delegate of OpenTelemetry. Record counts
// nothing while it is in place, so a process without a provider builds no instrument.
func isInitialProvider(provider otelmetric.MeterProvider) bool {
	return fmt.Sprintf("%T", provider) == initialProviderType
}

// Record adds count redrive results of one durable status. A count that is not positive adds
// nothing, as in TypeScript. The provider belongs to the caller. If it panics or refuses the
// instrument, the count is lost and the redrive result does not change.
func Record(ctx context.Context, status string, count int64) {
	if count <= 0 {
		return
	}
	defer func() { _ = recover() }()
	provider := otel.GetMeterProvider()
	if isInitialProvider(provider) {
		return
	}
	counter, err := provider.Meter(instrumentationName).Int64Counter(
		instrumentName,
		otelmetric.WithDescription(description),
		otelmetric.WithUnit(unit),
	)
	if err != nil {
		return
	}
	counter.Add(ctx, count, otelmetric.WithAttributes(attribute.String(statusAttribute, status)))
}
