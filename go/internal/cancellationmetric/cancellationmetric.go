// Package cancellationmetric counts the cancel_v1 results of the queue and of the dashboard.
//
// A worker binds its instruments when it is constructed. A queue has no such moment that every
// caller passes before it registers a meter provider, and the dashboard runs cancel_v1 itself. Thus
// Record reads the global meter provider on each call. A cancellation is an operator action, so
// the lookup costs little.
package cancellationmetric

import (
	"context"

	"github.com/stablemates/workhorse/go/internal/otelglobal"
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

// Record counts one cancel_v1 result by its durable status. The provider belongs to the caller. If
// it panics or refuses the instrument, the count is lost and the cancel result does not change.
func Record(ctx context.Context, status string) {
	defer func() { _ = recover() }()
	provider := otel.GetMeterProvider()
	// If the process registered no meter provider, Record builds no instrument.
	if otelglobal.NoMeterProvider(provider) {
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
