# frozen_string_literal: true

module Stablemates
  module Workhorse
    # Spans, metrics, logs, and W3C trace context. Internal to the SDK; not part of its governed
    # surface.
    #
    # The gem does not depend on OpenTelemetry. When the caller loads +opentelemetry-api+, the
    # worker emits the shared span names and the queue injects trace context. When the caller also
    # loads +opentelemetry-metrics-api+, the worker records the shared instruments. The names,
    # units, and attributes match +python/src/workhorse/_telemetry.py+.
    module Telemetry # :nodoc:
      INSTRUMENTATION_NAME = "workhorse"
      MAX_TRACE_CONTEXT_BYTES = 1_024
      INSTRUMENTS = {
        "workhorse.tasks.claimed" => [:counter, "Tasks claimed for handler execution", "{task}"],
        "workhorse.tasks.completed" => [:counter, "Tasks completed under a valid lease", "{task}"],
        "workhorse.tasks.failed" => [:counter, "Handler failures submitted to PostgreSQL", "{task}"],
        "workhorse.tasks.retried" => [:counter, "Failed tasks returned to live work", "{task}"],
        "workhorse.leases.expired" => [:counter, "Expired leases recovered by maintenance", "{lease}"],
        "workhorse.handler.runtime" => [:counter, "Cumulative handler execution time", "ms"],
        "workhorse.handler.executions" => [:counter, "Worker handler activations by outcome", "{execution}"],
        "workhorse.worker.heartbeat.failure" => [:counter,
          "Worker heartbeats rejected by PostgreSQL ownership or timing checks", "{heartbeat}"],
        "workhorse.schedule.fired" => [:counter, "Recurring schedule occurrences durably fired", "{occurrence}"],
        "workhorse.maintenance.runs" => [:counter, "Workhorse maintenance phase executions", "{run}"],
        "workhorse.maintenance.rows" => [:counter, "Rows affected by Workhorse maintenance phases", "{row}"],
        "workhorse.maintenance.errors" => [:counter, "Workhorse maintenance phase failures", "{error}"],
        "workhorse.claim.duration" => [:histogram, "PostgreSQL claim operation latency", "ms"],
        "workhorse.handler.duration" => [:histogram, "Handler execution latency", "ms"],
        "workhorse.handler.batch.size" => [:histogram, "Tasks delivered in one batch handler invocation", "{task}"],
        "workhorse.handler.batch.linger" => [:histogram, "Time from the first batch member arriving until dispatch", "ms"],
        "workhorse.schedule.lag" => [:histogram, "Delay between a scheduled occurrence and its durable firing", "s"],
        "workhorse.maintenance.duration" => [:histogram, "Workhorse maintenance phase duration", "ms"]
      }.freeze
      LEVELS = {debug: Logger::DEBUG, info: Logger::INFO, warn: Logger::WARN}.freeze
      private_constant :INSTRUMENTS, :LEVELS

      @instruments = Concurrent::Map.new
      @failed_loggers = ObjectSpace::WeakKeyMap.new
      @failed_loggers_lock = Mutex.new

      module_function

      def tracing? = defined?(::OpenTelemetry::Trace::Propagation::TraceContext) ? true : false

      def metrics? = tracing? && ::OpenTelemetry.respond_to?(:meter_provider)

      # The current W3C trace context as a carrier Hash, or nil without OpenTelemetry, without a
      # valid span, or when the carrier exceeds the protocol's byte limit.
      def inject_trace_context
        return nil unless tracing?

        carrier = {}
        propagator.inject(carrier)
        return nil unless carrier.key?("traceparent")

        (JSON.generate(carrier).bytesize <= MAX_TRACE_CONTEXT_BYTES) ? carrier : nil
      end

      # The OpenTelemetry context current on this thread, to parent spans on another thread.
      def current_context = tracing? ? ::OpenTelemetry::Context.current : nil

      # Yields a span, or nil without OpenTelemetry. A +trace_context+ carrier takes precedence
      # over +parent+. The span records no exception by itself; +record_error+ marks a failure.
      def span(name, attributes, trace_context: nil, parent: nil, consumer: false)
        return yield(nil) unless tracing?

        if trace_context.is_a?(Hash)
          carrier = trace_context.each_with_object({}) do |(key, value), result|
            result[key.downcase] = value if key.is_a?(String) && value.is_a?(String)
          end
          parent = propagator.extract(carrier, context: ::OpenTelemetry::Context.empty)
        end
        parent ||= ::OpenTelemetry::Context.current
        span = tracer.start_span(name, with_parent: parent, attributes: attributes,
          kind: consumer ? :consumer : :internal)
        begin
          ::OpenTelemetry::Context.with_current(::OpenTelemetry::Trace.context_with_span(span, parent_context: parent)) do
            yield span
          end
        ensure
          span.finish
        end
      end

      def set_attribute(span, key, value)
        span&.set_attribute(key, value)
      end

      def record_error(span, error_type)
        return if span.nil?

        span.status = ::OpenTelemetry::Trace::Status.error
        span.add_event("exception", attributes: {"exception.type" => error_type, "exception.escaped" => false})
      end

      def add(name, amount, attributes = {})
        instrument(name)&.add(amount, attributes: attributes)
      end

      def record(name, amount, attributes = {})
        instrument(name)&.record(amount, attributes: attributes)
      end

      def task_span_attributes(task)
        {"workhorse.task.id" => task.id, "workhorse.task.type" => task.type, "workhorse.task.attempt" => task.attempt}
      end

      def task_metric_attributes(task)
        {"workhorse.queue.name" => task.queue, "workhorse.task.type" => task.type}
      end

      # Logs one named event through the caller's Logger. +logger+ may be nil.
      #
      # A logger that raises never reaches the caller, because lifecycle code such as lease renewal
      # and shutdown logs on its way. The first failure of each logger goes to standard error
      # instead, which never calls back into that logger.
      def log(logger, severity, event, body, attributes = nil)
        return if logger.nil?

        logger.add(LEVELS.fetch(severity), nil, INSTRUMENTATION_NAME) do
          (attributes.nil? || attributes.empty?) ? "#{event}: #{body}" : "#{event}: #{body} #{JSON.generate(attributes)}"
        end
      rescue => e
        report_log_failure(logger, event, e)
      end

      def report_log_failure(logger, event, error)
        first = @failed_loggers_lock.synchronize { @failed_loggers.key?(logger) ? false : (@failed_loggers[logger] = true) }
        Kernel.warn("workhorse: logger raised #{error.class} while logging #{event}: #{error.message}") if first
      rescue
        nil
      end

      def propagator = ::OpenTelemetry::Trace::Propagation::TraceContext.text_map_propagator

      def tracer = ::OpenTelemetry.tracer_provider.tracer(INSTRUMENTATION_NAME, VERSION)

      def instrument(name)
        return nil unless metrics?

        @instruments.compute_if_absent(name) do
          kind, description, unit = INSTRUMENTS.fetch(name)
          meter = ::OpenTelemetry.meter_provider.meter(INSTRUMENTATION_NAME)
          (kind == :counter) ? meter.create_counter(name, unit: unit, description: description) :
            meter.create_histogram(name, unit: unit, description: description)
        end
      end
    end
  end
end
