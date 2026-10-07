//! The worker's metrics and handler span.
//!
//! Logs and the span go through `tracing`. With the `opentelemetry` feature, metrics go to the
//! global meter provider and the span continues the trace stored with the task.
use crate::worker::ClaimedTask;

#[derive(Clone, Copy)]
pub(crate) enum Counter {
    Claimed,
    Completed,
    Failed,
    Retried,
    LeasesExpired,
    HandlerExecutions,
    HeartbeatFailures,
    /// A millisecond counter, so it is the one fractional counter.
    HandlerRuntime,
}

#[derive(Clone, Copy)]
pub(crate) enum Histogram {
    ClaimDuration,
    HandlerDuration,
    BatchLinger,
    /// A task count, so it is the one integer histogram.
    BatchSize,
}

#[derive(Clone, Copy)]
#[cfg_attr(not(feature = "opentelemetry"), allow(dead_code))]
pub(crate) enum Attribute<'a> {
    Text(&'a str),
    Bool(bool),
}

pub(crate) type Attributes<'a> = [(&'static str, Attribute<'a>)];

/// The instruments one worker records to; without the feature every call is a no-op.
pub(crate) struct Metrics {
    #[cfg(feature = "opentelemetry")]
    instruments: otel::Instruments,
}

impl Metrics {
    pub(crate) fn new() -> Self {
        Self {
            #[cfg(feature = "opentelemetry")]
            instruments: otel::Instruments::new(),
        }
    }

    #[cfg_attr(not(feature = "opentelemetry"), allow(unused_variables))]
    pub(crate) fn add(&self, counter: Counter, value: f64, attributes: &Attributes<'_>) {
        #[cfg(feature = "opentelemetry")]
        self.instruments.add(counter, value, attributes);
    }

    #[cfg_attr(not(feature = "opentelemetry"), allow(unused_variables))]
    pub(crate) fn record(&self, histogram: Histogram, value: f64, attributes: &Attributes<'_>) {
        #[cfg(feature = "opentelemetry")]
        self.instruments.record(histogram, value, attributes);
    }
}

/// The `workhorse.handler` consumer span, parented on the task's stored W3C trace context.
///
/// The `tracing` span keeps its contextual parent, so its log events still nest under the caller's
/// span. Its OpenTelemetry parent is only the stored context: a task descends from the trace its
/// enqueue stored, and a task without one starts a new trace.
pub(crate) fn handler_span(task: &ClaimedTask) -> tracing::Span {
    let span = tracing::info_span!(
        "workhorse.handler",
        otel.kind = "consumer",
        otel.status_code = tracing::field::Empty,
        workhorse.queue.name = %task.queue,
        workhorse.task.id = %task.id,
        workhorse.task.type = %task.task_type,
        workhorse.task.attempt = task.attempt,
    );
    #[cfg(feature = "opentelemetry")]
    {
        use tracing_opentelemetry::OpenTelemetrySpanExt;
        let parent = task.trace_context.as_ref().and_then(otel::remote_parent);
        let _ = span.set_parent(parent.unwrap_or_default());
    }
    span
}

#[cfg(feature = "opentelemetry")]
mod otel {
    use opentelemetry::metrics::{Counter as OtelCounter, Histogram as OtelHistogram};
    use opentelemetry::trace::{
        SpanContext, SpanId, TraceContextExt, TraceFlags, TraceId, TraceState,
    };
    use opentelemetry::{Context, KeyValue};

    use super::{Attribute, Attributes, Counter, Histogram};

    pub(super) struct Instruments {
        counters: Vec<OtelCounter<u64>>,
        runtime: OtelCounter<f64>,
        histograms: Vec<OtelHistogram<f64>>,
        batch_size: OtelHistogram<u64>,
    }

    impl Instruments {
        pub(super) fn new() -> Self {
            let meter = opentelemetry::global::meter("workhorse");
            let counter = |name: &'static str, unit: &'static str| {
                meter.u64_counter(name).with_unit(unit).build()
            };
            let histogram = |name: &'static str| meter.f64_histogram(name).with_unit("ms").build();
            Self {
                counters: vec![
                    counter("workhorse.tasks.claimed", "{task}"),
                    counter("workhorse.tasks.completed", "{task}"),
                    counter("workhorse.tasks.failed", "{task}"),
                    counter("workhorse.tasks.retried", "{task}"),
                    counter("workhorse.leases.expired", "{lease}"),
                    counter("workhorse.handler.executions", "{execution}"),
                    counter("workhorse.worker.heartbeat.failure", "{heartbeat}"),
                ],
                runtime: meter.f64_counter("workhorse.handler.runtime").with_unit("ms").build(),
                histograms: vec![
                    histogram("workhorse.claim.duration"),
                    histogram("workhorse.handler.duration"),
                    histogram("workhorse.handler.batch.linger"),
                ],
                batch_size: meter
                    .u64_histogram("workhorse.handler.batch.size")
                    .with_unit("{task}")
                    .build(),
            }
        }

        pub(super) fn add(&self, counter: Counter, value: f64, attributes: &Attributes<'_>) {
            let attributes = key_values(attributes);
            match counter {
                Counter::HandlerRuntime => self.runtime.add(value, &attributes),
                counter => self.counters[counter as usize].add(value as u64, &attributes),
            }
        }

        pub(super) fn record(&self, histogram: Histogram, value: f64, attributes: &Attributes<'_>) {
            let attributes = key_values(attributes);
            match histogram {
                Histogram::BatchSize => self.batch_size.record(value as u64, &attributes),
                histogram => self.histograms[histogram as usize].record(value, &attributes),
            }
        }
    }

    fn key_values(attributes: &Attributes<'_>) -> Vec<KeyValue> {
        attributes
            .iter()
            .map(|(key, value)| match *value {
                Attribute::Text(text) => KeyValue::new(*key, text.to_owned()),
                Attribute::Bool(flag) => KeyValue::new(*key, flag),
            })
            .collect()
    }

    /// Parses a stored `traceparent` and `tracestate` into a remote parent context.
    pub(super) fn remote_parent(stored: &serde_json::Value) -> Option<Context> {
        let parent = stored.get("traceparent")?.as_str()?;
        let mut parts = parent.split('-');
        let (Some("00"), Some(trace), Some(span), Some(flags), None) =
            (parts.next(), parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return None;
        };
        let state = stored
            .get("tracestate")
            .and_then(serde_json::Value::as_str)
            .and_then(|state| state.parse::<TraceState>().ok())
            .unwrap_or_default();
        let context = SpanContext::new(
            TraceId::from_hex(trace).ok()?,
            SpanId::from_hex(span).ok()?,
            TraceFlags::new(u8::from_str_radix(flags, 16).ok()?),
            true,
            state,
        );
        context.is_valid().then(|| Context::new().with_remote_span_context(context))
    }
}

#[cfg(all(test, feature = "opentelemetry"))]
mod tests {
    use opentelemetry::trace::{SpanId, TraceId, TracerProvider};
    use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider};
    use serde_json::json;
    use tracing_subscriber::layer::SubscriberExt;

    use super::handler_span;
    use crate::worker::ClaimedTask;

    fn task(trace_context: Option<serde_json::Value>) -> ClaimedTask {
        ClaimedTask {
            id: uuid::Uuid::new_v4(),
            task_type: "trace.parent".into(),
            queue: "trace-parent".into(),
            priority: 0,
            payload: json!({}),
            contract_version: None,
            result_max_bytes: None,
            redact_error_details: false,
            trace_context,
            attempt: 1,
            max_attempts: 1,
            retry_policy: json!({}),
            deadline_at: None,
            execution_timeout: None,
            attempt_timeout_at: None,
            fence_token: 1,
            lease_expires_at: chrono::Utc::now(),
            claim_sent_at: tokio::time::Instant::now(),
            fast_tier: false,
        }
    }

    #[test]
    fn a_handler_span_descends_only_from_the_task_trace_context() {
        let exporter = InMemorySpanExporter::default();
        let provider = SdkTracerProvider::builder().with_simple_exporter(exporter.clone()).build();
        let layer = tracing_opentelemetry::layer().with_tracer(provider.tracer("workhorse"));
        let untraced = task(None);
        let traced = task(Some(json!({
            "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
        })));
        tracing::subscriber::with_default(tracing_subscriber::registry().with(layer), || {
            let unrelated = tracing::info_span!("unrelated");
            let _entered = unrelated.enter();
            drop(handler_span(&untraced));
            drop(handler_span(&traced));
        });

        let spans = exporter.get_finished_spans().unwrap();
        let unrelated = spans.iter().find(|span| span.name == "unrelated").unwrap();
        let handler = |task: &ClaimedTask| {
            spans
                .iter()
                .find(|span| {
                    span.name == "workhorse.handler"
                        && span.attributes.iter().any(|attribute| {
                            attribute.key.as_str() == "workhorse.task.id"
                                && attribute.value.as_str() == task.id.to_string()
                        })
                })
                .unwrap()
        };
        let untraced = handler(&untraced);
        assert_eq!(untraced.parent_span_id, SpanId::INVALID);
        assert_ne!(untraced.span_context.trace_id(), unrelated.span_context.trace_id());
        let traced = handler(&traced);
        assert_eq!(
            traced.span_context.trace_id(),
            TraceId::from_hex("4bf92f3577b34da6a3ce929d0e0e4736").unwrap()
        );
        assert_eq!(traced.parent_span_id, SpanId::from_hex("00f067aa0ba902b7").unwrap());
    }
}
