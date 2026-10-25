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
        "workhorse.tasks.retried" => [:counter, "Failed or expired tasks returned to live work", "{task}"],
        "workhorse.leases.expired" => [:counter, "Expired leases recovered by maintenance", "{lease}"],
        "workhorse.handler.runtime" => [:counter, "Cumulative handler execution time", "ms"],
        "workhorse.handler.executions" => [:counter, "Worker handler activations by outcome", "{execution}"],
        "workhorse.worker.heartbeat.failure" => [:counter,
          "Worker heartbeats rejected by PostgreSQL ownership or timing checks", "{heartbeat}"],
        "workhorse.worker.heartbeat.round_failure" => [:counter,
          "Worker heartbeat rounds that failed before PostgreSQL gave a verdict", "{round}"],
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
      LEVELS = {debug: Logger::DEBUG, info: Logger::INFO, warn: Logger::WARN, error: Logger::ERROR}.freeze
      # The errors of the driver and the runtime that mean the round did not reach PostgreSQL or
      # lost its connection: a closed or refused connection, a failed send, a socket or DNS error.
      CONNECTION_ERRORS = [PG::ConnectionBad, PG::UnableToSend, IOError, SystemCallError, SocketError].freeze
      # The errors, by class name, of a pool that the worker can borrow a connection from: a wait
      # that ends at the pool's own limit, a pool that shuts down, and a connection that the pool
      # could not open or lost. The SDK does not load Sequel or Active Record, so a name matches
      # the error class or one of its superclasses.
      CONNECTION_ERROR_NAMES = %w[
        ConnectionPool::TimeoutError ConnectionPool::PoolShuttingDownError
        Sequel::PoolTimeout Sequel::DatabaseConnectionError Sequel::DatabaseDisconnectError
        ActiveRecord::ConnectionNotEstablished ActiveRecord::ConnectionFailed
      ].freeze
      # The SQLSTATEs of a server timeout: statement_timeout and idle_in_transaction_session_timeout.
      TIMEOUT_SQLSTATES = %w[57014 25P03].freeze
      # The SQLSTATEs of a server shutdown: admin_shutdown, crash_shutdown, and cannot_connect_now.
      SHUTDOWN_SQLSTATES = %w[57P01 57P02 57P03].freeze
      # The longest cause chain that +heartbeat_round_failure_reason+ reads.
      MAX_CAUSE_CHAIN = 16
      private_constant :INSTRUMENTS, :LEVELS, :CONNECTION_ERRORS, :CONNECTION_ERROR_NAMES, :TIMEOUT_SQLSTATES,
        :SHUTDOWN_SQLSTATES, :MAX_CAUSE_CHAIN

      @instruments = Concurrent::Map.new
      @failed_loggers = ObjectSpace::WeakKeyMap.new
      @failed_loggers_lock = Mutex.new

      module_function

      def tracing? = defined?(::OpenTelemetry::Trace::Propagation::TraceContext) ? true : false

      def metrics? = tracing? && !meter_provider.nil?

      # +opentelemetry-metrics-api+ 0.9 keeps the global provider in +OpenTelemetry::Internal+ and
      # defines the public accessor only when the SDK or +opentelemetry/metrics/global+ loads. 0.8
      # defines only the public accessor.
      def meter_provider
        if defined?(::OpenTelemetry::Internal) && ::OpenTelemetry::Internal.respond_to?(:meter_provider)
          ::OpenTelemetry::Internal.meter_provider
        elsif ::OpenTelemetry.respond_to?(:meter_provider)
          ::OpenTelemetry.meter_provider
        end
      end

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
      #
      # A consumer span runs a claimed task, which descends only from the trace its enqueue stored.
      # A span current where the worker runs is unrelated to the task, so a consumer span starts
      # from an empty context, and a task without a stored context starts a new trace.
      def span(name, attributes, trace_context: nil, parent: nil, consumer: false)
        return yield(nil) unless tracing?

        parent = ::OpenTelemetry::Context.empty if consumer
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

      # Counts one heartbeat round that failed before PostgreSQL returned a status for its leases.
      # The round gives no ownership verdict, so +workhorse.worker.heartbeat.failure+ does not count
      # it. The heartbeat records one value for each failed round, so the rate stays bounded by the
      # heartbeat interval and its busy retries. The heartbeat calls this on its error paths, so an
      # error of the meter does not replace the error of the round.
      def record_heartbeat_round_failure(error)
        add("workhorse.worker.heartbeat.round_failure", 1,
          {"workhorse.heartbeat.failure_reason" => heartbeat_round_failure_reason(error)})
      rescue
        nil
      end

      # The +workhorse.heartbeat.failure_reason+ of a failed heartbeat round: "timeout",
      # "connection", "database", or "other". It reads +error+ and its +cause+ chain, outermost
      # first, at most MAX_CAUSE_CHAIN errors, and each error once.
      #
      # - "timeout": the round deadline (Worker::Heartbeat::RoundTimeout, and RoundExpired for a
      #   round that reached its deadline before its heartbeat statement), or the SQLSTATE 57014
      #   (statement_timeout, PG::QueryCanceled) or 25P03 (idle_in_transaction_session_timeout).
      # - "connection": PG::ConnectionBad, PG::UnableToSend, IOError, SystemCallError (the Errno
      #   errors of a socket), or SocketError (DNS); or a SQLSTATE that starts with 08, or 57P01,
      #   57P02, or 57P03 (a server shutdown). IO::TimeoutError is an IOError, so a socket timeout
      #   is a connection error too.
      # - "connection" also covers a pool error that CONNECTION_ERROR_NAMES names. Under
      #   +shared_heartbeats: true+ the round borrows a connection through the pool's +with+, so a
      #   wait that ends at the pool's own limit reaches the round: ConnectionPool::TimeoutError,
      #   Sequel::PoolTimeout, or ActiveRecord::ConnectionTimeoutError (an
      #   ActiveRecord::ConnectionNotEstablished).
      # - "database": any other SQLSTATE.
      # - "other": everything else. A Timeout::Error that is not one of these, for example from
      #   Timeout.timeout, is "other": only the round deadline is "timeout".
      #
      # The SQLSTATE is the first one in the chain: DatabaseError#sqlstate, or the
      # PG::PG_DIAG_SQLSTATE field of the result of a PG::Error. A timeout takes precedence over a
      # connection error.
      def heartbeat_round_failure_reason(error)
        chain = cause_chain(error)
        deadline = [Worker::Heartbeat::RoundTimeout, Worker::Heartbeat::RoundExpired]
        return "timeout" if chain.any? { |entry| deadline.any? { |type| entry.is_a?(type) } }

        sqlstate = chain.lazy.filter_map { |entry| sqlstate_of(entry) }.first
        return "timeout" if TIMEOUT_SQLSTATES.include?(sqlstate)
        if sqlstate&.start_with?("08") || SHUTDOWN_SQLSTATES.include?(sqlstate) ||
            chain.any? { |entry| connection_error?(entry) }
          return "connection"
        end

        sqlstate.nil? ? "other" : "database"
      end

      # Whether +error+ is a connection error of the driver, the runtime, or a pool.
      def connection_error?(error)
        CONNECTION_ERRORS.any? { |type| error.is_a?(type) } ||
          error.class.ancestors.any? { |type| CONNECTION_ERROR_NAMES.include?(type.name) }
      end

      # +error+ and its causes, outermost first, each once, at most MAX_CAUSE_CHAIN.
      def cause_chain(error)
        chain = []
        seen = {}.compare_by_identity
        while error.is_a?(Exception) && !seen.key?(error) && chain.size < MAX_CAUSE_CHAIN
          seen[error] = true
          chain << error
          error = error.cause
        end
        chain
      end

      # The SQLSTATE of one error, or nil.
      def sqlstate_of(error)
        return error.sqlstate if error.is_a?(DatabaseError)
        return nil unless error.is_a?(PG::Error)

        error.result&.error_field(PG::PG_DIAG_SQLSTATE)
      rescue PG::Error
        nil
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
          meter = meter_provider.meter(INSTRUMENTATION_NAME)
          (kind == :counter) ? meter.create_counter(name, unit: unit, description: description) :
            meter.create_histogram(name, unit: unit, description: description)
        end
      end
    end
  end
end
