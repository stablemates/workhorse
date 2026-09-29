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

    # A token bucket: +limit+ admissions per +interval_ms+, with at most +burst+ in reserve.
    RateLimit = Data.define(:limit, :interval_ms, :burst)

    # A stored concurrency policy for one queue.
    ConcurrencyPolicy = Data.define(:namespace, :queue, :max_active, :max_active_per_key, :updated_at)

    # A stored rate limit policy for one queue. +per_key+ is a RateLimit or nil.
    RateLimitPolicy = Data.define(:namespace, :queue, :rate, :per_key, :updated_at)

    # A stored budget. +max_active+ and +rate+ may each be nil.
    Budget = Data.define(:namespace, :name, :max_active, :rate, :updated_at)

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

      # Whole milliseconds from a Numeric count of seconds.
      def milliseconds(value, label)
        raise ArgumentError, "#{label} must be a Numeric count of seconds" unless value.is_a?(Numeric)

        (value.to_f * 1000).round
      end

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
