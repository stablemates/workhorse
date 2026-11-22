// Package otelglobal tells the Workhorse packages whether the process registered an OpenTelemetry
// provider.
//
// Before the first registration, otel.GetMeterProvider and otel.GetTracerProvider return a
// delegate that OpenTelemetry installs at start. That delegate sends its records to no provider.
// Thus the Workhorse packages build no instrument and start no span while it is in place.
//
// The check uses the type of the delegate, not the provider at package start. Another package can
// register a provider before a Workhorse package starts. After the first registration, the delegate
// sends its records to that provider. A test cleanup can set the delegate back as the global
// provider. Thus the check also asks the delegate for a meter or a tracer. The delegate gives one of
// its own types only while it has no provider. This creates no instrument and no span.
package otelglobal

import (
	"reflect"

	otelmetric "go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
)

const (
	// delegatePackage is the package of the delegates that OpenTelemetry installs at start.
	delegatePackage = "go.opentelemetry.io/otel/internal/global"
	// instrumentationName is the scope that the Workhorse packages use for their meter and tracer.
	instrumentationName = "github.com/stablemates/workhorse/go"
)

// NoMeterProvider reports whether provider is the *global.meterProvider delegate of OpenTelemetry
// and the process registered no meter provider for it.
func NoMeterProvider(provider otelmetric.MeterProvider) bool {
	if !isDelegate(provider, "meterProvider") {
		return false
	}
	return gives(func() any { return provider.Meter(instrumentationName) }, "meter")
}

// NoTracerProvider reports whether provider is the *global.tracerProvider delegate of
// OpenTelemetry and the process registered no tracer provider for it.
func NoTracerProvider(provider trace.TracerProvider) bool {
	if !isDelegate(provider, "tracerProvider") {
		return false
	}
	return gives(func() any { return provider.Tracer(instrumentationName) }, "tracer")
}

// gives reports whether get returns the delegate type name. A delegate with a provider calls that
// provider, which belongs to the caller. If the provider panics, a provider is registered, so gives
// returns false. Each Workhorse caller recovers a panic when it then uses the provider.
func gives(get func() any, name string) (delegate bool) {
	defer func() {
		if recover() != nil {
			delegate = false
		}
	}()
	return isDelegate(get(), name)
}

func isDelegate(value any, name string) bool {
	kind := reflect.TypeOf(value)
	if kind == nil || kind.Kind() != reflect.Pointer {
		return false
	}
	kind = kind.Elem()
	return kind.PkgPath() == delegatePackage && kind.Name() == name
}
