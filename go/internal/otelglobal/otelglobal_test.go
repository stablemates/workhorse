package otelglobal

import (
	"context"
	"testing"

	"github.com/stablemates/workhorse/go/internal/earlyprovider"
	"go.opentelemetry.io/otel"
	otelmetric "go.opentelemetry.io/otel/metric"
	noopmetric "go.opentelemetry.io/otel/metric/noop"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
	nooptrace "go.opentelemetry.io/otel/trace/noop"
)

type panickingMeterProvider struct{ noopmetric.MeterProvider }

func (panickingMeterProvider) Meter(string, ...otelmetric.MeterOption) otelmetric.Meter {
	panic("Meter failed")
}

type panickingTracerProvider struct{ nooptrace.TracerProvider }

func (panickingTracerProvider) Tracer(string, ...trace.TracerOption) trace.Tracer {
	panic("Tracer failed")
}

// Only a start delegate that sends its records to no provider means "no provider". A provider
// that the process registered, also one that does nothing, is a provider. A start delegate that a
// cleanup set back after a registration sends its records to that provider, so it is one too.
func TestOnlyAnUntouchedStartDelegateIsNoProvider(t *testing.T) {
	if earlyprovider.RunWithStartDelegates(t) {
		return
	}
	meterDelegate, tracerDelegate := otel.GetMeterProvider(), otel.GetTracerProvider()
	if !NoMeterProvider(meterDelegate) {
		t.Fatalf("the meter delegate %T is a provider", meterDelegate)
	}
	if !NoTracerProvider(tracerDelegate) {
		t.Fatalf("the tracer delegate %T is a provider", tracerDelegate)
	}

	meterProvider := sdkmetric.NewMeterProvider()
	tracerProvider := sdktrace.NewTracerProvider()
	t.Cleanup(func() {
		_ = meterProvider.Shutdown(context.Background())
		_ = tracerProvider.Shutdown(context.Background())
	})
	if NoMeterProvider(meterProvider) || NoMeterProvider(noopmetric.NewMeterProvider()) || NoMeterProvider(nil) {
		t.Fatal("a meter provider is no provider")
	}
	if NoTracerProvider(tracerProvider) || NoTracerProvider(nooptrace.NewTracerProvider()) || NoTracerProvider(nil) {
		t.Fatal("a tracer provider is no provider")
	}

	otel.SetMeterProvider(meterProvider)
	otel.SetTracerProvider(tracerProvider)
	if NoMeterProvider(otel.GetMeterProvider()) || NoTracerProvider(otel.GetTracerProvider()) {
		t.Fatal("a registered global provider is no provider")
	}
	otel.SetMeterProvider(meterDelegate)
	otel.SetTracerProvider(tracerDelegate)
	if NoMeterProvider(otel.GetMeterProvider()) || NoTracerProvider(otel.GetTracerProvider()) {
		t.Fatal("a start delegate that sends to a registered provider is no provider")
	}
}

// A start delegate that sends to a registered provider asks that provider for the meter or the
// tracer. If the provider panics, the check does not panic. The provider is registered, so the
// check finds a provider, and the caller records through its own recovery.
func TestARestoredDelegateWhoseProviderPanicsIsAProvider(t *testing.T) {
	if earlyprovider.RunWithStartDelegates(t) {
		return
	}
	meterDelegate, tracerDelegate := otel.GetMeterProvider(), otel.GetTracerProvider()
	otel.SetMeterProvider(panickingMeterProvider{})
	otel.SetTracerProvider(panickingTracerProvider{})
	otel.SetMeterProvider(meterDelegate)
	otel.SetTracerProvider(tracerDelegate)
	if NoMeterProvider(meterDelegate) {
		t.Error("a start delegate that sends to a panicking meter provider is no provider")
	}
	if NoTracerProvider(tracerDelegate) {
		t.Error("a start delegate that sends to a panicking tracer provider is no provider")
	}
}
