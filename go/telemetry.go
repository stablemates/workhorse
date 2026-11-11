package workhorse

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	otelmetric "go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

type discardLogHandler struct{}

func (discardLogHandler) Enabled(context.Context, slog.Level) bool   { return false }
func (discardLogHandler) Handle(context.Context, slog.Record) error  { return nil }
func (handler discardLogHandler) WithAttrs([]slog.Attr) slog.Handler { return handler }
func (handler discardLogHandler) WithGroup(string) slog.Handler      { return handler }

// recoveringLogHandler runs the slog.Handler of the caller and drops a record if that handler
// panics. The worker logs on its execution, heartbeat, and maintenance goroutines, so a panic in
// the logger would otherwise end the process. It also must not change the settlement of an
// attempt, because the worker logs some records after PostgreSQL settled the attempt.
type recoveringLogHandler struct{ handler slog.Handler }

func newRecoveringLogger(logger *slog.Logger) *slog.Logger {
	if _, ok := logger.Handler().(recoveringLogHandler); ok {
		return logger
	}
	return slog.New(recoveringLogHandler{handler: logger.Handler()})
}

func (handler recoveringLogHandler) Enabled(ctx context.Context, level slog.Level) (enabled bool) {
	defer func() {
		if recover() != nil {
			enabled = false
		}
	}()
	return handler.handler.Enabled(ctx, level)
}

func (handler recoveringLogHandler) Handle(ctx context.Context, record slog.Record) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf(logHandlerPanicFormat, recovered)
		}
	}()
	return handler.handler.Handle(ctx, record)
}

func (handler recoveringLogHandler) WithAttrs(attributes []slog.Attr) (derived slog.Handler) {
	defer func() {
		if recover() != nil {
			derived = handler
		}
	}()
	return recoveringLogHandler{handler: handler.handler.WithAttrs(attributes)}
}

func (handler recoveringLogHandler) WithGroup(name string) (derived slog.Handler) {
	defer func() {
		if recover() != nil {
			derived = handler
		}
	}()
	return recoveringLogHandler{handler: handler.handler.WithGroup(name)}
}

type workerMetrics struct {
	enabled           bool
	claimed           otelmetric.Int64Counter
	completed         otelmetric.Int64Counter
	failed            otelmetric.Int64Counter
	retried           otelmetric.Int64Counter
	expiredLeases     otelmetric.Int64Counter
	claimDuration     otelmetric.Float64Histogram
	handlerDuration   otelmetric.Float64Histogram
	handlerRuntime    otelmetric.Float64Counter
	handlerExecutions otelmetric.Int64Counter
	batchSize         otelmetric.Int64Histogram
	batchLinger       otelmetric.Float64Histogram
	heartbeatFailures otelmetric.Int64Counter
	// heartbeatRoundFailures counts the rounds that failed before PostgreSQL gave a verdict.
	heartbeatRoundFailures otelmetric.Int64Counter
}

var (
	initialMeterProvider  = otel.GetMeterProvider()
	initialTracerProvider = otel.GetTracerProvider()
)

const maxTraceContextBytes = 1_024

func injectTraceContext(ctx context.Context) map[string]string {
	carrier := propagation.MapCarrier{}
	propagation.TraceContext{}.Inject(ctx, carrier)
	if carrier[traceParentField] == emptyString {
		return nil
	}
	encoded, err := json.Marshal(carrier)
	if err != nil || len(encoded) > maxTraceContextBytes {
		return nil
	}
	return carrier
}

func newWorkerMetrics() (*workerMetrics, error) {
	if otel.GetMeterProvider() == initialMeterProvider {
		return &workerMetrics{}, nil
	}
	meter := otel.Meter(telemetryInstrumentationName)
	claimed, err := meter.Int64Counter(
		tasksClaimedInstrument,
		otelmetric.WithDescription(tasksClaimedDescription),
		otelmetric.WithUnit(telemetryTaskUnit),
	)
	if err != nil {
		return nil, err
	}
	completed, err := meter.Int64Counter(
		tasksCompletedInstrument,
		otelmetric.WithDescription(tasksCompletedDescription),
		otelmetric.WithUnit(telemetryTaskUnit),
	)
	if err != nil {
		return nil, err
	}
	failed, err := meter.Int64Counter(
		tasksFailedInstrument,
		otelmetric.WithDescription(tasksFailedDescription),
		otelmetric.WithUnit(telemetryTaskUnit),
	)
	if err != nil {
		return nil, err
	}
	retried, err := meter.Int64Counter(
		tasksRetriedInstrument,
		otelmetric.WithDescription(tasksRetriedDescription),
		otelmetric.WithUnit(telemetryTaskUnit),
	)
	if err != nil {
		return nil, err
	}
	expiredLeases, err := meter.Int64Counter(
		expiredLeasesInstrument,
		otelmetric.WithDescription(expiredLeasesDescription),
		otelmetric.WithUnit(telemetryLeaseUnit),
	)
	if err != nil {
		return nil, err
	}
	claimDuration, err := meter.Float64Histogram(
		claimDurationInstrument,
		otelmetric.WithDescription(claimDurationDescription),
		otelmetric.WithUnit(telemetryMillisecondsUnit),
	)
	if err != nil {
		return nil, err
	}
	handlerDuration, err := meter.Float64Histogram(
		handlerDurationInstrument,
		otelmetric.WithDescription(handlerDurationDescription),
		otelmetric.WithUnit(telemetryMillisecondsUnit),
	)
	if err != nil {
		return nil, err
	}
	handlerRuntime, err := meter.Float64Counter(
		handlerRuntimeInstrument,
		otelmetric.WithDescription(handlerRuntimeDescription),
		otelmetric.WithUnit(telemetryMillisecondsUnit),
	)
	if err != nil {
		return nil, err
	}
	handlerExecutions, err := meter.Int64Counter(
		handlerExecutionsInstrument,
		otelmetric.WithDescription(handlerExecutionsDescription),
		otelmetric.WithUnit(telemetryExecutionUnit),
	)
	if err != nil {
		return nil, err
	}
	batchSize, err := meter.Int64Histogram(
		handlerBatchSizeInstrument,
		otelmetric.WithDescription(handlerBatchSizeDescription),
		otelmetric.WithUnit(telemetryTaskUnit),
	)
	if err != nil {
		return nil, err
	}
	batchLinger, err := meter.Float64Histogram(
		handlerBatchLingerInstrument,
		otelmetric.WithDescription(handlerBatchLingerDescription),
		otelmetric.WithUnit(telemetryMillisecondsUnit),
	)
	if err != nil {
		return nil, err
	}
	heartbeatFailures, err := meter.Int64Counter(
		heartbeatFailuresInstrument,
		otelmetric.WithDescription(heartbeatFailuresDescription),
		otelmetric.WithUnit(telemetryHeartbeatUnit),
	)
	if err != nil {
		return nil, err
	}
	heartbeatRoundFailures, err := meter.Int64Counter(
		heartbeatRoundFailuresInstrument,
		otelmetric.WithDescription(heartbeatRoundFailuresDescription),
		otelmetric.WithUnit(telemetryRoundUnit),
	)
	if err != nil {
		return nil, err
	}
	return &workerMetrics{
		enabled: true, claimed: recoveringInt64Counter{claimed}, completed: recoveringInt64Counter{completed},
		failed: recoveringInt64Counter{failed}, retried: recoveringInt64Counter{retried},
		expiredLeases: recoveringInt64Counter{expiredLeases}, claimDuration: recoveringFloat64Histogram{claimDuration},
		handlerDuration:   recoveringFloat64Histogram{handlerDuration},
		handlerRuntime:    recoveringFloat64Counter{handlerRuntime},
		handlerExecutions: recoveringInt64Counter{handlerExecutions}, batchSize: recoveringInt64Histogram{batchSize},
		batchLinger: recoveringFloat64Histogram{batchLinger}, heartbeatFailures: recoveringInt64Counter{heartbeatFailures},
		heartbeatRoundFailures: recoveringInt64Counter{heartbeatRoundFailures},
	}, nil
}

// The meter and tracer providers belong to the caller. The worker records metrics and spans on its
// execution, dispatch, heartbeat, and maintenance goroutines, so a panic in a provider would end the
// process or leave a resource of the worker held. The recovering types below drop the measurement
// or the span operation instead, as recoveringLogHandler drops a log record.

// discardTelemetryPanic is deferred directly, so its recover stops a panic of the provider.
func discardTelemetryPanic() { _ = recover() }

type recoveringInt64Counter struct{ otelmetric.Int64Counter }

func (counter recoveringInt64Counter) Add(ctx context.Context, value int64, options ...otelmetric.AddOption) {
	defer discardTelemetryPanic()
	counter.Int64Counter.Add(ctx, value, options...)
}

type recoveringFloat64Counter struct{ otelmetric.Float64Counter }

func (counter recoveringFloat64Counter) Add(
	ctx context.Context,
	value float64,
	options ...otelmetric.AddOption,
) {
	defer discardTelemetryPanic()
	counter.Float64Counter.Add(ctx, value, options...)
}

type recoveringInt64Histogram struct{ otelmetric.Int64Histogram }

func (histogram recoveringInt64Histogram) Record(
	ctx context.Context,
	value int64,
	options ...otelmetric.RecordOption,
) {
	defer discardTelemetryPanic()
	histogram.Int64Histogram.Record(ctx, value, options...)
}

type recoveringFloat64Histogram struct{ otelmetric.Float64Histogram }

func (histogram recoveringFloat64Histogram) Record(
	ctx context.Context,
	value float64,
	options ...otelmetric.RecordOption,
) {
	defer discardTelemetryPanic()
	histogram.Float64Histogram.Record(ctx, value, options...)
}

// recoveringSpan drops a span operation whose provider panics.
type recoveringSpan struct{ trace.Span }

func (span recoveringSpan) End(options ...trace.SpanEndOption) {
	defer discardTelemetryPanic()
	span.Span.End(options...)
}

func (span recoveringSpan) AddEvent(name string, options ...trace.EventOption) {
	defer discardTelemetryPanic()
	span.Span.AddEvent(name, options...)
}

func (span recoveringSpan) RecordError(err error, options ...trace.EventOption) {
	defer discardTelemetryPanic()
	span.Span.RecordError(err, options...)
}

func (span recoveringSpan) SetStatus(code codes.Code, description string) {
	defer discardTelemetryPanic()
	span.Span.SetStatus(code, description)
}

func (span recoveringSpan) SetAttributes(attributes ...attribute.KeyValue) {
	defer discardTelemetryPanic()
	span.Span.SetAttributes(attributes...)
}

// startWorkerSpan starts a span of the worker. If the provider panics, it returns ctx and a span
// that records nothing, so the caller's span is not ended.
func startWorkerSpan(
	ctx context.Context,
	name string,
	options ...trace.SpanStartOption,
) (started context.Context, span trace.Span) {
	defer func() {
		if recover() != nil {
			started, span = ctx, trace.SpanFromContext(context.Background())
		}
	}()
	started, span = otel.Tracer(telemetryInstrumentationName).Start(ctx, name, options...)
	return started, recoveringSpan{span}
}

func taskMetricOptions(task ClaimedTask) otelmetric.MeasurementOption {
	return otelmetric.WithAttributes(
		attribute.String(queueNameAttribute, task.Queue),
		attribute.String(taskTypeAttribute, task.Type),
	)
}

func (metrics *workerMetrics) recordHandler(
	ctx context.Context,
	task ClaimedTask,
	outcome handlerOutcome,
	duration time.Duration,
) {
	if !metrics.enabled {
		return
	}
	durationMS := float64(duration) / float64(time.Millisecond)
	attributes := otelmetric.WithAttributes(
		attribute.String(queueNameAttribute, task.Queue),
		attribute.String(taskTypeAttribute, task.Type),
		attribute.String(handlerOutcomeAttribute, string(outcome)),
	)
	metrics.handlerExecutions.Add(ctx, 1, attributes)
	metrics.handlerDuration.Record(ctx, durationMS, attributes)
	metrics.handlerRuntime.Add(ctx, durationMS, taskMetricOptions(task))
}

type handlerOutcome string

const (
	handlerOutcomeCanceled         handlerOutcome = telemetryCanceledValue
	handlerOutcomeDeadlineExceeded handlerOutcome = workerFailureDeadline
	handlerOutcomeFailed           handlerOutcome = workerFailureFailed
	handlerOutcomeLeaseLost        handlerOutcome = telemetryLeaseLostValue
	handlerOutcomeReleased         handlerOutcome = telemetryReleasedValue
	handlerOutcomeRetry            handlerOutcome = telemetryRetryValue
	handlerOutcomeSucceeded        handlerOutcome = telemetrySucceededValue
	handlerOutcomeSuspended        handlerOutcome = telemetrySuspendedValue
	handlerOutcomeTimeout          handlerOutcome = telemetryTimeoutValue
	handlerOutcomeUnknown          handlerOutcome = telemetryUnknownValue
)

func startHandlerSpan(ctx context.Context, task ClaimedTask) (context.Context, trace.Span) {
	if otel.GetTracerProvider() == initialTracerProvider {
		return ctx, trace.SpanFromContext(ctx)
	}
	parent := extractTraceContext(ctx, task.TraceContext)
	return startWorkerSpan(
		parent,
		handlerSpanName,
		trace.WithSpanKind(trace.SpanKindConsumer),
		trace.WithAttributes(
			attribute.String(queueNameAttribute, task.Queue),
			attribute.String(taskIDAttribute, task.ID),
			attribute.String(taskTypeAttribute, task.Type),
			attribute.Int(taskAttemptAttribute, task.Attempt),
		),
	)
}

// startRetrySpan starts the workhorse.retry span of one settlement, as a child of the span on ctx,
// and returns ctx with the retry span active. It carries the task attributes of the TypeScript span.
// The caller sets workhorse.retry.outcome.
func startRetrySpan(ctx context.Context, task ClaimedTask) (context.Context, trace.Span) {
	if otel.GetTracerProvider() == initialTracerProvider {
		// A span that records nothing, so End cannot end the caller's span.
		return ctx, trace.SpanFromContext(context.Background())
	}
	return startWorkerSpan(
		ctx,
		retrySpanName,
		trace.WithAttributes(
			attribute.String(taskIDAttribute, task.ID),
			attribute.String(taskTypeAttribute, task.Type),
			attribute.Int(taskAttemptAttribute, task.Attempt),
		),
	)
}

// extractTraceContext returns ctx with the task's stored trace context as its span parent. A task
// descends only from the trace its enqueue stored, so any span context on ctx is replaced, and a
// task without a stored context starts a new trace. Cancellation and values on ctx still reach the
// handler.
func extractTraceContext(ctx context.Context, stored any) context.Context {
	ctx = trace.ContextWithSpanContext(ctx, trace.SpanContext{})
	carrier := propagation.MapCarrier{}
	switch value := stored.(type) {
	case map[string]any:
		for _, key := range []string{traceParentField, traceStateField} {
			if field, ok := value[key].(string); ok {
				carrier[key] = field
			}
		}
	case map[string]string:
		for _, key := range []string{traceParentField, traceStateField} {
			if field := value[key]; field != emptyString {
				carrier[key] = field
			}
		}
	case []byte:
		_ = json.Unmarshal(value, &carrier)
	case string:
		_ = json.Unmarshal([]byte(value), &carrier)
	}
	if carrier[traceParentField] == emptyString {
		return ctx
	}
	return extractWithPropagator(ctx, carrier)
}

// extractWithPropagator runs the propagator of the caller. If it panics, the task starts a new trace.
func extractWithPropagator(ctx context.Context, carrier propagation.MapCarrier) (extracted context.Context) {
	defer func() {
		if recover() != nil {
			extracted = ctx
		}
	}()
	return otel.GetTextMapPropagator().Extract(ctx, carrier)
}

func finishHandlerSpan(span trace.Span, outcome handlerOutcome, err error) {
	span.SetAttributes(attribute.String(handlerOutcomeAttribute, string(outcome)))
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
	}
	span.End()
}

func handlerTelemetryError(err error, redact bool) error {
	if err == nil || !redact {
		return err
	}
	return errors.New(redactedHandlerErrorNameValue)
}

func taskLogAttributes(task ClaimedTask, workerID string) []any {
	return []any{
		slog.String(taskIDAttribute, task.ID),
		slog.String(taskTypeAttribute, task.Type),
		slog.Int(taskAttemptAttribute, task.Attempt),
		slog.String(queueNameAttribute, task.Queue),
		slog.String(workerIDAttribute, workerID),
	}
}

// logWorkerEvent emits one structured worker event. Attributes are built lazily so the
// default discard logger costs no allocation on the per-task path.
func logWorkerEvent(
	ctx context.Context,
	logger *slog.Logger,
	level slog.Level,
	event string,
	message string,
	attributes func() []any,
) {
	if !logger.Enabled(ctx, level) {
		return
	}
	built := attributes()
	values := make([]any, 0, len(built)+1)
	values = append(values, slog.String(eventNameAttribute, event))
	values = append(values, built...)
	logger.Log(ctx, level, message, values...)
}
