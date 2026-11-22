package workhorse

import (
	"context"
	"errors"
	"testing"

	"github.com/stablemates/workhorse/go/internal/earlyprovider"
	"go.opentelemetry.io/otel"
	otelmetric "go.opentelemetry.io/otel/metric"
	noopmetric "go.opentelemetry.io/otel/metric/noop"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"
	nooptrace "go.opentelemetry.io/otel/trace/noop"
)

type meterPanickingProvider struct{ noopmetric.MeterProvider }

func (meterPanickingProvider) Meter(string, ...otelmetric.MeterOption) otelmetric.Meter {
	panic("Meter failed")
}

type instrumentPanickingMeter struct{ noopmetric.Meter }

func (instrumentPanickingMeter) Int64Counter(
	string,
	...otelmetric.Int64CounterOption,
) (otelmetric.Int64Counter, error) {
	panic("Int64Counter failed")
}

type instrumentPanickingProvider struct{ noopmetric.MeterProvider }

func (instrumentPanickingProvider) Meter(string, ...otelmetric.MeterOption) otelmetric.Meter {
	return instrumentPanickingMeter{}
}

// The meter provider belongs to the caller. If it panics while the worker builds its instruments,
// the worker records no metric, and the worker is still built. This is true for a registered
// provider and for a restored start delegate that sends to it.
func TestWorkerMetricsRecoverFromAPanicOfTheMeterProvider(t *testing.T) {
	if earlyprovider.RunWithStartDelegates(t) {
		return
	}
	meterDelegate := otel.GetMeterProvider()
	for _, provider := range []otelmetric.MeterProvider{meterPanickingProvider{}, instrumentPanickingProvider{}} {
		for _, restore := range []bool{false, true} {
			otel.SetMeterProvider(provider)
			if restore {
				otel.SetMeterProvider(meterDelegate)
			}
			func() {
				defer func() {
					if recovered := recover(); recovered != nil {
						t.Errorf("%T, restored %v: the provider panic left newWorkerMetrics: %v", provider, restore, recovered)
					}
				}()
				metrics, err := newWorkerMetrics()
				if err != nil {
					t.Errorf("%T, restored %v: newWorkerMetrics() error = %v", provider, restore, err)
				} else if metrics.enabled {
					t.Errorf("%T, restored %v: a panicking provider gave the worker metrics", provider, restore)
				}
			}()
		}
	}
}

type tracerPanickingProvider struct{ nooptrace.TracerProvider }

func (tracerPanickingProvider) Tracer(string, ...trace.TracerOption) trace.Tracer {
	panic("Tracer failed")
}

// A restored start delegate sends Tracer to the registered provider. If that provider panics, the
// worker starts no span and does not panic, as for a registered provider that panics.
func TestWorkerSpansRecoverFromARestoredDelegateWhoseProviderPanics(t *testing.T) {
	if earlyprovider.RunWithStartDelegates(t) {
		return
	}
	tracerDelegate := otel.GetTracerProvider()
	otel.SetTracerProvider(tracerPanickingProvider{})
	otel.SetTracerProvider(tracerDelegate)
	task := ClaimedTask{ID: "task", Queue: "early", Type: "early-type", Attempt: 1}
	for name, start := range map[string]func(context.Context, ClaimedTask) (context.Context, trace.Span){
		handlerSpanName: startHandlerSpan,
		retrySpanName:   startRetrySpan,
	} {
		func() {
			defer func() {
				if recovered := recover(); recovered != nil {
					t.Errorf("%s: the provider panic left the worker: %v", name, recovered)
				}
			}()
			_, span := start(context.Background(), task)
			span.End()
		}()
	}
}

// An application can register its providers in the init function of a package that starts before
// the Workhorse package. The worker then gets the metrics and the spans of those providers.
func TestWorkerTelemetryUsesAProviderThatAnotherPackageRegisteredFirst(t *testing.T) {
	if earlyprovider.RunWithEarlyProviders(t) {
		return
	}
	assertWorkerTelemetry(t, earlyprovider.Reader, earlyprovider.Recorder)
}

// While the global providers are the start delegates of OpenTelemetry, the worker builds no
// instrument and starts no span. A provider that the application registers after the Workhorse
// package started also gets the worker telemetry.
func TestWorkerTelemetryUsesNoStartDelegateAndALaterProvider(t *testing.T) {
	if earlyprovider.RunWithStartDelegates(t) {
		return
	}
	assertNoWorkerTelemetry(t)
	reader, recorder := registerTestProviders(t)
	assertWorkerTelemetry(t, reader, recorder)
}

// A test cleanup can set a start delegate back after a provider was registered. The delegate then
// sends its records to that provider, so the worker records through it.
func TestWorkerTelemetryUsesARestoredDelegateThatSendsToAProvider(t *testing.T) {
	if earlyprovider.RunWithStartDelegates(t) {
		return
	}
	meterDelegate, tracerDelegate := otel.GetMeterProvider(), otel.GetTracerProvider()
	reader, recorder := registerTestProviders(t)
	otel.SetMeterProvider(meterDelegate)
	otel.SetTracerProvider(tracerDelegate)
	assertWorkerTelemetry(t, reader, recorder)
}

// Without a tracer provider, the worker starts no handler span. It must not give the span of the
// caller as the handler span, because the worker sets attributes on the handler span and ends it.
func TestHandlerSpanWithoutAProviderLeavesTheCallerSpan(t *testing.T) {
	if earlyprovider.RunWithStartDelegates(t) {
		return
	}
	recorder := tracetest.NewSpanRecorder()
	callerProvider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	t.Cleanup(func() { _ = callerProvider.Shutdown(context.Background()) })
	callerCtx, callerSpan := callerProvider.Tracer("caller").Start(context.Background(), "caller")

	task := ClaimedTask{ID: "task", Queue: "early", Type: "early-type", Attempt: 1}
	ctx, handlerSpan := startHandlerSpan(callerCtx, task)
	finishHandlerSpan(ctx, handlerSpan, handlerOutcomeFailed, errors.New("handler failed"))

	if ended := recorder.Ended(); len(ended) != 0 {
		t.Fatalf("the worker ended the caller span %q", ended[0].Name())
	}
	if !callerSpan.IsRecording() {
		t.Fatal("the caller span stopped recording")
	}
	callerSpan.End()
}

func assertNoWorkerTelemetry(t *testing.T) {
	t.Helper()
	metrics, err := newWorkerMetrics()
	if err != nil {
		t.Fatal(err)
	}
	if metrics.enabled {
		t.Errorf("the start delegate %T gave the worker metrics", otel.GetMeterProvider())
	}
	task := ClaimedTask{ID: "task", Queue: "early", Type: "early-type", Attempt: 1}
	if _, span := startHandlerSpan(context.Background(), task); span.IsRecording() {
		t.Errorf("the start delegate %T started a handler span", otel.GetTracerProvider())
	}
	if _, span := startRetrySpan(context.Background(), task); span.IsRecording() {
		t.Errorf("the start delegate %T started a retry span", otel.GetTracerProvider())
	}
}

// registerTestProviders registers an SDK meter provider and an SDK tracer provider. The test runs
// in its own process, so the cleanup only shuts them down.
func registerTestProviders(t *testing.T) (*sdkmetric.ManualReader, *tracetest.SpanRecorder) {
	t.Helper()
	reader := sdkmetric.NewManualReader()
	meterProvider := sdkmetric.NewMeterProvider(sdkmetric.WithReader(reader))
	recorder := tracetest.NewSpanRecorder()
	tracerProvider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	otel.SetMeterProvider(meterProvider)
	otel.SetTracerProvider(tracerProvider)
	t.Cleanup(func() {
		_ = meterProvider.Shutdown(context.Background())
		_ = tracerProvider.Shutdown(context.Background())
	})
	return reader, recorder
}

// assertWorkerTelemetry builds the worker metrics from the global meter provider, counts one claim,
// and starts a handler span with a retry span. It checks that the reader and the recorder got them.
func assertWorkerTelemetry(t *testing.T, reader *sdkmetric.ManualReader, recorder *tracetest.SpanRecorder) {
	t.Helper()
	task := ClaimedTask{ID: "task", Queue: "early", Type: "early-type", Attempt: 1}
	metrics, err := newWorkerMetrics()
	if err != nil {
		t.Fatal(err)
	}
	if !metrics.enabled {
		t.Errorf("the global meter provider %T gave the worker no metrics", otel.GetMeterProvider())
	} else {
		metrics.claimed.Add(context.Background(), 1, taskMetricOptions(task))
	}
	ctx, handlerSpan := startHandlerSpan(context.Background(), task)
	_, retrySpan := startRetrySpan(ctx, task)
	retrySpan.End()
	finishHandlerSpan(ctx, handlerSpan, handlerOutcomeSucceeded, nil)

	var collected metricdata.ResourceMetrics
	if err := reader.Collect(context.Background(), &collected); err != nil {
		t.Fatal(err)
	}
	claimed := int64(0)
	for _, scope := range collected.ScopeMetrics {
		for _, instrument := range scope.Metrics {
			if sum, ok := instrument.Data.(metricdata.Sum[int64]); ok && instrument.Name == tasksClaimedInstrument {
				for _, point := range sum.DataPoints {
					claimed += point.Value
				}
			}
		}
	}
	if claimed != 1 {
		t.Errorf("%s = %d, want 1", tasksClaimedInstrument, claimed)
	}
	names := []string{}
	for _, span := range recorder.Ended() {
		names = append(names, span.Name())
	}
	if len(names) != 2 || names[0] != retrySpanName || names[1] != handlerSpanName {
		t.Errorf("ended spans = %v, want [%s %s]", names, retrySpanName, handlerSpanName)
	}
}
