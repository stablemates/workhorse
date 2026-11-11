package workhorse

import (
	"context"
	"log/slog"
	"testing"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

type extractionContextKey struct{}

func TestExtractTraceContextDropsTheCallerSpanAndKeepsItsValuesAndCancellation(t *testing.T) {
	provider := sdktrace.NewTracerProvider()
	previousPropagator := otel.GetTextMapPropagator()
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() {
		otel.SetTextMapPropagator(previousPropagator)
		_ = provider.Shutdown(context.Background())
	})
	caller, cancel := context.WithCancel(context.WithValue(context.Background(), extractionContextKey{}, "caller value"))
	caller, unrelated := provider.Tracer("unrelated").Start(caller, "unrelated")
	defer unrelated.End()

	for _, stored := range []any{nil, map[string]any{}, `{"traceparent":"not a traceparent"}`} {
		parent := extractTraceContext(caller, stored)
		if trace.SpanContextFromContext(parent).IsValid() {
			t.Fatalf("extractTraceContext(%#v) kept the caller's span", stored)
		}
		if got := parent.Value(extractionContextKey{}); got != "caller value" {
			t.Fatalf("extractTraceContext(%#v) value = %v", stored, got)
		}
	}

	parent := extractTraceContext(caller, map[string]any{
		traceParentField: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
	})
	stored := trace.SpanContextFromContext(parent)
	if stored.TraceID().String() != "4bf92f3577b34da6a3ce929d0e0e4736" || stored.SpanID().String() != "00f067aa0ba902b7" || !stored.IsRemote() {
		t.Fatalf("extractTraceContext() span context = %#v", stored)
	}
	cancel()
	<-parent.Done()
}

// everyMethodPanics is a slog.Handler whose every method panics.
type everyMethodPanics struct{}

func (everyMethodPanics) Enabled(context.Context, slog.Level) bool  { panic("enabled") }
func (everyMethodPanics) Handle(context.Context, slog.Record) error { panic("handle") }
func (everyMethodPanics) WithAttrs([]slog.Attr) slog.Handler        { panic("with attrs") }
func (everyMethodPanics) WithGroup(string) slog.Handler             { panic("with group") }

// SM-1938: the worker logs on its own goroutines, so a panic in the slog.Handler of the caller
// must not leave the logger. The recovering handler drops the record instead.
func TestRecoveringLoggerDropsARecordWhenItsHandlerPanics(t *testing.T) {
	logger := newRecoveringLogger(slog.New(everyMethodPanics{}))
	if newRecoveringLogger(logger) != logger {
		t.Fatal("a recovering logger was wrapped again")
	}
	derived := logger.With("attempt", 1).WithGroup("task")
	derived.Info("dropped")
	if derived.Enabled(context.Background(), slog.LevelError) {
		t.Fatal("a handler whose Enabled panics reported the level as enabled")
	}
	err := recoveringLogHandler{handler: everyMethodPanics{}}.Handle(context.Background(), slog.Record{})
	if err == nil || err.Error() != "the slog.Handler panicked: handle" {
		t.Fatalf("Handle returned %v", err)
	}
}
