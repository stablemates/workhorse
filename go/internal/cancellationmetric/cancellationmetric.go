// Package cancellationmetric counts the cancel_v1 results of the queue and of the dashboard.
//
// A worker binds its instruments when it is constructed. A queue has no such moment that every
// caller passes before it registers a meter provider, and the dashboard runs cancel_v1 itself. Thus
// Record reads the global meter provider on each call. A cancellation is an operator action, so
// the lookup costs little.
package cancellationmetric

import (
	"context"
	"fmt"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	otelmetric "go.opentelemetry.io/otel/metric"
)

const (
	instrumentationName = "github.com/stablemates/workhorse/go"
	instrumentName      = "workhorse.tasks.cancellation"
	description         = "Task cancellation requests by durable result"
	unit                = "{request}"
	statusAttribute     = "workhorse.cancellation.status"
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

// Record counts one cancel_v1 result by its durable status. The provider belongs to the caller. If
// it panics or refuses the instrument, the count is lost and the cancel result does not change.
func Record(ctx context.Context, status string) {
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
	counter.Add(ctx, 1, otelmetric.WithAttributes(attribute.String(statusAttribute, status)))
}
