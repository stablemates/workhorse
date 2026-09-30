# frozen_string_literal: true

module Stablemates
  module Workhorse
    # What PostgreSQL did with one enqueue request. +outcome+ is :accepted, :replayed, :replaced,
    # :non_replaceable, or :coalesced.
    EnqueueResult = Data.define(:task_id, :outcome)

    # One request of an +enqueue_many+ batch. It carries the keywords +Queue#enqueue+ takes.
    EnqueueRequest = Data.define(
      :task_type, :payload, :queue, :priority, :concurrency_key, :budget, :run_at, :deadline,
      :execution_timeout, :max_attempts, :retry_policy, :tags, :idempotency, :debounce, :throttle,
      :dependencies
    ) do
      def initialize(task_type:, payload:, queue: nil, priority: nil, concurrency_key: nil, budget: nil,
        run_at: nil, deadline: nil, execution_timeout: nil, max_attempts: nil,
        retry_policy: nil, tags: nil, idempotency: nil, debounce: nil, throttle: nil,
        dependencies: nil)
        super
      end
    end

    # Retains one canonical request under a scoped key for +ttl+ seconds.
    Idempotency = Data.define(:key, :scope, :ttl) do
      def initialize(key:, scope: "default", ttl: 86_400) = super
    end

    # Replaces a pending keyed task during a PostgreSQL-owned +window+ of seconds. +schedule+ is
    # :reset or :preserve.
    Debounce = Data.define(:key, :window, :schedule, :scope) do
      def initialize(key:, window:, schedule: :reset, scope: "default") = super
    end

    # Accepts at most one equivalent keyed task during a PostgreSQL-owned +window+ of seconds.
    Throttle = Data.define(:key, :window, :scope) do
      def initialize(key:, window:, scope: "default") = super
    end

    # Prerequisite tasks and what a dependent does when one of them ends. Each policy is :release,
    # :cancel, or :fail.
    Dependencies = Data.define(:prerequisite_task_ids, :on_success, :on_failure, :on_cancellation)

    # PostgreSQL's answer to a cancellation request. +status+ is :canceled, :cancel_requested,
    # :already_terminal, or :not_found. +state+ is the task's state, or nil when it was not found.
    CancelResult = Data.define(
      :status, :task_id, :state, :current_attempt, :requested_at, :requested_by, :reason, :finished_at
    )

    # PostgreSQL's disposition for a signal. +status+ is :delivered, :duplicate, :not_waiting,
    # :already_delivered, :stale, or :not_found.
    SignalDeliveryResult = Data.define(:status, :task_id, :name, :payload, :delivered_at, :delivered_by)

    # PostgreSQL's disposition for a human wait completion. +status+ is :completed, :duplicate,
    # :not_waiting, :already_completed, :stale, or :not_found.
    HumanWaitCompletionResult = Data.define(:status, :task_id, :name, :payload, :completed_at, :completed_by)

    # The task a schedule enqueues at each occurrence.
    ScheduledTask = Data.define(
      :task_type, :payload, :queue, :priority, :concurrency_key, :max_attempts, :retry_policy
    ) do
      def initialize(task_type:, payload:, queue: nil, priority: 0, concurrency_key: nil, max_attempts: nil,
        retry_policy: nil)
        super
      end
    end

    # One named schedule. +schedule+ is a cron expression or an interval PostgreSQL accepts, and
    # +catchup_policy+ is :skip, :latest, or :all.
    ScheduleDefinition = Data.define(:name, :schedule, :task, :timezone, :catchup_policy, :enabled) do
      def initialize(name:, schedule:, task:, timezone: "UTC", catchup_policy: :skip, enabled: true) = super
    end

    # A token bucket: +limit+ admissions per +interval+ seconds, with at most +burst+ in reserve.
    # PostgreSQL stores the interval in whole milliseconds.
    RateLimit = Data.define(:limit, :interval, :burst)

    # The concurrency limit a sync gives one queue. +max_active_per_key+ may be nil.
    ConcurrencyPolicyDefinition = Data.define(:queue, :max_active, :max_active_per_key) do
      def initialize(queue:, max_active:, max_active_per_key: nil) = super
    end

    # The rate limit a sync gives one queue. +per_key+ is a RateLimit or nil.
    RateLimitPolicyDefinition = Data.define(:queue, :rate, :per_key) do
      def initialize(queue:, rate:, per_key: nil) = super
    end

    # One named budget that tasks in any queue can name. Set +max_active+, +rate+, or both.
    BudgetDefinition = Data.define(:name, :max_active, :rate) do
      def initialize(name:, max_active: nil, rate: nil) = super
    end

    # A stored concurrency policy for one queue.
    ConcurrencyPolicy = Data.define(:namespace, :queue, :max_active, :max_active_per_key, :updated_at)

    # A stored rate limit policy for one queue. +per_key+ is a RateLimit or nil.
    RateLimitPolicy = Data.define(:namespace, :queue, :rate, :per_key, :updated_at)

    # A stored budget. +max_active+ and +rate+ may each be nil.
    Budget = Data.define(:namespace, :name, :max_active, :rate, :updated_at)

    # One attempt a worker leased. PostgreSQL's fence token guards every write the attempt makes.
    ClaimedTask = Data.define(
      :id, :queue, :type, :priority, :payload, :contract_version, :result_max_bytes,
      :redact_error_details, :trace_context, :attempt, :max_attempts, :retry_policy, :deadline_at,
      :execution_timeout_ms, :attempt_timeout_at, :fence_token, :lease_expires_at
    ) do
      def self.from_row(row, queue) # :nodoc:
        new(
          id: row.fetch("task_id"), queue: queue, type: row.fetch("task_type"),
          priority: Values.parse_integer(row["priority"]), payload: Values.parse_json(row["payload"]),
          contract_version: row["contract_version"],
          result_max_bytes: Values.parse_integer(row["result_max_bytes"]),
          redact_error_details: row["redact_error_details"] == "t",
          trace_context: Values.parse_json(row["trace_context"]),
          attempt: Values.parse_integer(row["attempt"]),
          max_attempts: Values.parse_integer(row["max_attempts"]),
          retry_policy: Values.parse_json(row["retry_policy"]),
          deadline_at: Values.parse_time(row["deadline_at"]),
          execution_timeout_ms: Values.parse_integer(row["execution_timeout_ms"]),
          attempt_timeout_at: Values.parse_time(row["attempt_timeout_at"]),
          fence_token: Values.parse_integer(row["fence_token"]),
          lease_expires_at: Values.parse_time(row["lease_expires_at"])
        )
      end
    end

    # One child of +HandlerContext#run_children+. +options+ holds the keywords +Queue#enqueue+
    # takes, less the coalescing and dependency options.
    ChildTaskRequest = Data.define(:name, :task_type, :payload, :options) do
      def initialize(name:, task_type:, payload:, options: {}) = super
    end

    # How one child of +HandlerContext#run_children+ ended. +status+ is :succeeded, :failed, or
    # :canceled; +result+ holds a success's result and +error+ a failure's envelope.
    ChildOutcome = Data.define(:status, :result, :error)

    # Encodes and decodes the values that cross the protocol, without coercing a non-JSON value.
    # Internal to the SDK; not part of its governed surface.
    module Values
      UUID = /\A\h{8}-\h{4}-\h{4}-\h{4}-\h{12}\z/
      private_constant :UUID

      module_function

      # A JSON document for a +jsonb+ parameter. Refuses every value that is not a JSON type.
      def json(value, label = "value")
        check_json(value, label)
        JSON.generate(value)
      end

      def check_json(value, label)
        case value
        when String, Integer, true, false, nil then nil
        when Float
          raise ArgumentError, "#{label} contains a non-finite number" unless value.finite?
        when Array then value.each { |item| check_json(item, label) }
        when Hash
          value.each do |key, item|
            raise ArgumentError, "#{label} object keys must be Strings" unless key.is_a?(String)

            check_json(item, label)
          end
        else
          raise ArgumentError, "#{label} contains #{value.class}, which is not a JSON value"
        end
      end

      # A lowercase task ID, or ArgumentError before any statement runs.
      def task_id(value, label = "task ID")
        raise ArgumentError, "#{label} must be a UUID String" unless value.is_a?(String) && UUID.match?(value)

        value.downcase
      end

      # Whole milliseconds from a finite Numeric count of seconds, within +range+ milliseconds.
      # An ActiveSupport::Duration is Numeric and converts the same way.
      def milliseconds(value, label, range)
        milliseconds = whole_milliseconds(value)
        return milliseconds if milliseconds && range.cover?(milliseconds)

        raise ArgumentError, "#{label} must be a finite Numeric count of seconds between " \
          "#{seconds(range.begin)} and #{seconds(range.end)}"
      end

      def whole_milliseconds(value)
        return nil unless value.is_a?(Numeric)

        seconds = value.to_f
        seconds.finite? ? (seconds * 1000).round : nil
      rescue RangeError, NoMethodError
        nil
      end

      # Seconds from whole milliseconds: an Integer when exact, otherwise a Float.
      def seconds(milliseconds) = (milliseconds % 1000).zero? ? milliseconds / 1000 : milliseconds / 1000.0

      # The protocol's timestamp text for a Time.
      def timestamp(value, label)
        raise ArgumentError, "#{label} must be a Time" unless value.is_a?(Time)

        value.getutc.strftime("%Y-%m-%dT%H:%M:%S.%LZ")
      end

      def text_array(values, label)
        raise ArgumentError, "#{label} must be an Array of Strings" unless
          values.is_a?(Array) && values.all?(String)

        TEXT_ARRAY_ENCODER.encode(values)
      end

      def parse_json(text) = text.nil? ? nil : JSON.parse(text)

      def parse_integer(text) = text.nil? ? nil : Integer(text, 10)

      def parse_boolean(text) = text.nil? ? nil : text == "t"

      def parse_time(text) = text.nil? ? nil : TIMESTAMP_DECODER.decode(text)

      def parse_text_array(text) = text.nil? ? nil : TEXT_ARRAY_DECODER.decode(text)

      TEXT_ARRAY_ENCODER = PG::TextEncoder::Array.new
      TEXT_ARRAY_DECODER = PG::TextDecoder::Array.new
      TIMESTAMP_DECODER = PG::TextDecoder::TimestampWithTimeZone.new
      private_constant :TEXT_ARRAY_ENCODER, :TEXT_ARRAY_DECODER, :TIMESTAMP_DECODER
    end
  end
end
