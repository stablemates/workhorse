package workhorse

import (
	"context"
	"encoding/json"
	"errors"
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
}

var (
	initialMeterProvider  = otel.GetMeterProvider()
	initialTracerProvider = otel.GetTracerProvider()
)

func newWorkerMetrics() (*workerMetrics, error) {
	if otel.GetMeterProvider() == initialMeterProvider {
		return &workerMetrics{}, nil
	}
	meter := otel.Meter(telemetryInstrumentationName)
	claimed, err := meter.Int64Counter(
		jobsClaimedInstrument,
		otelmetric.WithDescription(jobsClaimedDescription),
		otelmetric.WithUnit(telemetryJobUnit),
	)
	if err != nil {
		return nil, err
	}
	completed, err := meter.Int64Counter(
		jobsCompletedInstrument,
		otelmetric.WithDescription(jobsCompletedDescription),
		otelmetric.WithUnit(telemetryJobUnit),
	)
	if err != nil {
		return nil, err
	}
	failed, err := meter.Int64Counter(
		jobsFailedInstrument,
		otelmetric.WithDescription(jobsFailedDescription),
		otelmetric.WithUnit(telemetryJobUnit),
	)
	if err != nil {
		return nil, err
	}
	retried, err := meter.Int64Counter(
		jobsRetriedInstrument,
		otelmetric.WithDescription(jobsRetriedDescription),
		otelmetric.WithUnit(telemetryJobUnit),
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
		otelmetric.WithUnit(telemetryJobUnit),
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
	return &workerMetrics{
		enabled: true, claimed: claimed, completed: completed, failed: failed, retried: retried,
		expiredLeases: expiredLeases, claimDuration: claimDuration,
		handlerDuration: handlerDuration, handlerRuntime: handlerRuntime,
		handlerExecutions: handlerExecutions, batchSize: batchSize,
		batchLinger: batchLinger, heartbeatFailures: heartbeatFailures,
	}, nil
}

func jobMetricOptions(job ClaimedJob) otelmetric.MeasurementOption {
	return otelmetric.WithAttributes(
		attribute.String(queueNameAttribute, job.Queue),
		attribute.String(jobTypeAttribute, job.Type),
	)
}

func (metrics *workerMetrics) recordHandler(
	ctx context.Context,
	job ClaimedJob,
	outcome handlerOutcome,
	duration time.Duration,
) {
	if !metrics.enabled {
		return
	}
	durationMS := float64(duration) / float64(time.Millisecond)
	attributes := otelmetric.WithAttributes(
		attribute.String(queueNameAttribute, job.Queue),
		attribute.String(jobTypeAttribute, job.Type),
		attribute.String(handlerOutcomeAttribute, string(outcome)),
	)
	metrics.handlerExecutions.Add(ctx, 1, attributes)
	metrics.handlerDuration.Record(ctx, durationMS, attributes)
	metrics.handlerRuntime.Add(ctx, durationMS, jobMetricOptions(job))
}

type handlerOutcome string

const (
	handlerOutcomeCanceled         handlerOutcome = telemetryCanceledValue
	handlerOutcomeDeadlineExceeded handlerOutcome = workerFailureDeadline
	handlerOutcomeFailed           handlerOutcome = workerFailureFailed
	handlerOutcomeLeaseLost        handlerOutcome = telemetryLeaseLostValue
	handlerOutcomeRetry            handlerOutcome = telemetryRetryValue
	handlerOutcomeSucceeded        handlerOutcome = telemetrySucceededValue
	handlerOutcomeSuspended        handlerOutcome = telemetrySuspendedValue
	handlerOutcomeTimeout          handlerOutcome = telemetryTimeoutValue
	handlerOutcomeUnknown          handlerOutcome = telemetryUnknownValue
)

func startHandlerSpan(ctx context.Context, job ClaimedJob) (context.Context, trace.Span) {
	if otel.GetTracerProvider() == initialTracerProvider {
		return ctx, trace.SpanFromContext(ctx)
	}
	parent := extractTraceContext(ctx, job.TraceContext)
	return otel.Tracer(telemetryInstrumentationName).Start(
		parent,
		handlerSpanName,
		trace.WithSpanKind(trace.SpanKindConsumer),
		trace.WithAttributes(
			attribute.String(queueNameAttribute, job.Queue),
			attribute.String(jobIDAttribute, job.ID),
			attribute.String(jobTypeAttribute, job.Type),
			attribute.Int(jobAttemptAttribute, job.Attempt),
		),
	)
}

func extractTraceContext(ctx context.Context, stored any) context.Context {
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

func jobLogAttributes(job ClaimedJob, workerID string) []any {
	return []any{
		slog.String(jobIDAttribute, job.ID),
		slog.String(jobTypeAttribute, job.Type),
		slog.Int(jobAttemptAttribute, job.Attempt),
		slog.String(queueNameAttribute, job.Queue),
		slog.String(workerIDAttribute, workerID),
	}
}

func logWorkerEvent(
	ctx context.Context,
	logger *slog.Logger,
	level slog.Level,
	event string,
	message string,
	attributes ...any,
) {
	values := make([]any, 0, len(attributes)+1)
	values = append(values, slog.String(eventNameAttribute, event))
	values = append(values, attributes...)
	logger.Log(ctx, level, message, values...)
}
