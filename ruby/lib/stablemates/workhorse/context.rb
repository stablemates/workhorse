# frozen_string_literal: true

module Stablemates
  module Workhorse
    # Tells a handler that its attempt should stop. The worker cancels it; a handler observes it
    # through +cancelled?+, +check!+, or +wait+. +reason+ is one of :requested, :deadline_exceeded,
    # :execution_timeout, :lease_lost, :suspended, and :shutdown.
    class CancellationToken
      def initialize
        @reason = Concurrent::AtomicReference.new
        @event = Concurrent::Event.new
      end

      def cancelled? = @event.set?

      # The reason the token was cancelled, or nil until then.
      def reason = @reason.get

      # Raises CancelledError once the token is cancelled.
      def check!
        reason = @reason.get
        raise CancelledError.new(reason) unless reason.nil?
      end

      # Blocks until the token is cancelled or +timeout+ seconds pass. Returns true once cancelled.
      def wait(timeout = nil)
        @event.wait(timeout)
        cancelled?
      end

      # Cancels the token with +reason+. Only the first reason sticks; returns whether it did.
      def cancel(reason) # :nodoc:
        return false unless @reason.compare_and_set(nil, reason)

        @event.set
        true
      end
    end

    # Decides one attempt's outcome. The first submission wins, whether it comes from the handler,
    # the heartbeat, or the worker. Internal to the SDK.
    class Arbiter # :nodoc:
      def initialize
        @outcome = Concurrent::AtomicReference.new
      end

      def outcome = @outcome.get

      def submit(outcome) = @outcome.compare_and_set(nil, outcome)

      def suspended? = %i[suspended_for_wait suspended_for_child].include?(@outcome.get)
    end

    # What a handler receives beside its payload: the task, its cancellation token, and the durable
    # primitives. Every durable write carries the attempt's fence token, so a write from an attempt
    # that lost its lease raises LeaseLostError. Concurrent calls that share one name share one
    # request.
    class HandlerContext
      # Unwinds a handler that a durable wait or a child join suspended. It descends from Exception so
      # that a bare +rescue+ does not catch it. Handlers never construct it.
      class Suspension < Exception # :nodoc: # rubocop:disable Lint/InheritException
        def initialize = super("task handler suspended")
      end

      MAX_WAIT_MS = 31_536_000_000
      MAX_EXTERNAL_TIMEOUT_MS = 604_800_000
      MAX_EXTERNAL_VALUE_BYTES = 65_536
      MAX_CHILDREN = 100
      CHILD_OUTCOMES = {"succeeded" => :succeeded, "failed" => :failed, "canceled" => :canceled}.freeze
      private_constant :MAX_WAIT_MS, :MAX_EXTERNAL_TIMEOUT_MS, :MAX_EXTERNAL_VALUE_BYTES, :MAX_CHILDREN,
        :CHILD_OUTCOMES

      # The ClaimedTask this attempt runs.
      attr_reader :task
      # The attempt's CancellationToken.
      attr_reader :cancellation

      def initialize(executor:, queue:, task:, worker_id:, cancellation:, arbiter:, logger: nil) # :nodoc:
        @executor = executor
        @queue = queue
        @task = task
        @worker_id = worker_id
        @cancellation = cancellation
        @arbiter = arbiter
        @logger = logger
        @lock = Monitor.new
        @loaded = {}
        @calls = Hash.new { |calls, kind| calls[kind] = {} }
      end

      # Returns the value a checkpoint named +name+ saved, running the block to produce and save it
      # only when no such checkpoint exists.
      def checkpoint(name, &block)
        raise ArgumentError, "checkpoint needs a block" if block.nil?

        once(:checkpoint, name) do
          existing = checkpoints[name]
          next existing.value unless existing.nil?

          @cancellation.check!
          value = block.call
          row = write(SqlCatalogue::SAVE_CHECKPOINT_V1, name, Values.json(value, "checkpoint value"))
          status = expect(:checkpoint, row, %w[saved existing], name)
          log(:debug, "workhorse.task.checkpoint_saved", "Task checkpoint persisted",
            "workhorse.checkpoint.name" => name, "workhorse.checkpoint.status" => status)
          saved = checkpoint_record(row, name)
          @lock.synchronize { checkpoints[name] = saved }
          saved.value
        end
      end

      # Suspends the attempt for +seconds+ under the durable timer +name+. Returns at once when the
      # timer has already elapsed in an earlier attempt.
      def sleep(name, seconds)
        schedule_wait(name, Values.milliseconds(seconds, "wait duration", 1..MAX_WAIT_MS), nil)
      end

      # Suspends the attempt until +time+ under the durable timer +name+.
      def sleep_until(name, time)
        raise ArgumentError, "wait time must be a Time" unless time.is_a?(Time)
        raise ArgumentError, "wait time must be no more than 365 days in the future" if
          (time - Time.now) * 1000 > MAX_WAIT_MS

        schedule_wait(name, nil, Values.timestamp(time, "wait time"))
      end

      # Returns the payload of the signal +name+, suspending the attempt until one arrives.
      # +timeout+ is a count of seconds.
      def wait_for_signal(name, timeout: nil)
        external_name(name, "signal")
        timeout_ms = external_timeout(timeout, "signal")
        once(:wait_for_signal, name) do
          @cancellation.check!
          row = write(SqlCatalogue::WAIT_FOR_SIGNAL_V1, name, timeout_ms)
          case row.fetch("status")
          when "stale" then raise LeaseLostError.new(@task.id, :wait_for_signal)
          when "already_waiting" then raise ConflictError.new(:wait_for_signal, name)
          when "limit_exceeded" then raise LimitExceededError.new(:wait_for_signal, name)
          when "waiting" then suspend(:suspended_for_wait)
          when "delivered" then Values.parse_json(row["payload"])
          else raise UnexpectedStatusError.new(:wait_for_signal, row.fetch("status"))
          end
        end
      end

      # Returns the decision a person recorded for the wait +name+, suspending the attempt until one
      # arrives. +context+ is JSON shown to that person; +timeout+ is a count of seconds.
      def wait_for_human(name, context, timeout: nil)
        external_name(name, "human wait")
        timeout_ms = external_timeout(timeout, "human wait")
        encoded = Values.json(context, "human wait context")
        raise ArgumentError, "human wait context must be at most #{MAX_EXTERNAL_VALUE_BYTES} bytes of JSON" if
          encoded.bytesize > MAX_EXTERNAL_VALUE_BYTES

        once(:wait_for_human, name, encoded) do
          @cancellation.check!
          row = write(SqlCatalogue::WAIT_FOR_HUMAN_V1, name, encoded, timeout_ms)
          case row.fetch("status")
          when "stale" then raise LeaseLostError.new(@task.id, :wait_for_human)
          when "already_waiting" then raise AlreadyWaitingError.new(:wait_for_human, name)
          when "limit_exceeded" then raise LimitExceededError.new(:wait_for_human, name)
          when "conflict" then raise ConflictError.new(:wait_for_human, name)
          when "waiting" then suspend(:suspended_for_wait)
          when "completed" then Values.parse_json(row["result"])
          else raise UnexpectedStatusError.new(:wait_for_human, row.fetch("status"))
          end
        end
      end

      # Returns the result of the child task +name+, creating it and suspending the attempt until it
      # succeeds. +enqueue_options+ are the keywords Queue#enqueue takes, less the coalescing and
      # dependency options.
      def run_child(name, task_type, payload, **enqueue_options)
        child_name(name)
        encoded = canonical_json(@queue.serialize_child_request(@task, task_type, payload, enqueue_options))
        once(:run_child, name, encoded) do
          @cancellation.check!
          row = write(SqlCatalogue::CREATE_CHILD_V1, name, encoded)
          status = row.fetch("status")
          case status
          when "stale" then raise LeaseLostError.new(@task.id, :run_child)
          when "conflict" then raise ConflictError.new(:run_child, name)
          when "limit_exceeded" then raise LimitExceededError.new(:run_child, name)
          when "created", "completed"
            log(:info, "workhorse.task.child_processed", "Child task processed",
              "workhorse.child.name" => name, "workhorse.child.status" => status)
            suspend(:suspended_for_child) if status == "created"
            Values.parse_json(row["result"])
          else raise UnexpectedStatusError.new(:run_child, status)
          end
        end
      end

      # Creates the ChildTaskRequest +children+ together and returns each one's ChildOutcome by
      # name once all of them settle.
      def run_children(children) = run_child_set(children, "settled")

      # Creates the ChildTaskRequest +children+ together and returns each one's result by name once
      # all of them succeed.
      def run_children_all(children) = run_child_set(children, "all_success")

      # The progress this task reported last, as TaskProgress, or nil.
      def get_progress
        load(:progress) do
          rows = @executor.rows(SqlCatalogue::LIST_PROGRESS, [@task.id])
          raise Error, "PostgreSQL returned an invalid progress result" if rows.length > 1

          rows.empty? ? nil : progress_record(rows.first)
        end
      end

      # Persists +progress+, a JSON value, and returns the stored TaskProgress.
      def set_progress(progress)
        encoded = Values.json(progress, "progress")
        @cancellation.check!
        row = write(SqlCatalogue::UPDATE_PROGRESS_V1, encoded)
        status = row.fetch("status")
        case status
        when "stale" then raise LeaseLostError.new(@task.id, :set_progress)
        when "rate_limited" then raise ProgressRateLimitedError.new(Values.parse_integer(row["retry_after_ms"]) / 1000.0)
        when "updated", "unchanged" then nil
        else raise UnexpectedStatusError.new(:set_progress, status)
        end
        saved = progress_record(row)
        @lock.synchronize { @loaded[:progress] = [:ok, saved] }
        log(:debug, "workhorse.task.progress_updated", "Task progress persisted", "workhorse.progress.status" => status)
        saved
      end

      private

      def schedule_wait(name, duration_ms, wake_at)
        once(:sleep, name) do
          @cancellation.check!
          row = write(SqlCatalogue::SCHEDULE_WAIT_V1, name, duration_ms, wake_at)
          status = row.fetch("status")
          case status
          when "stale" then raise LeaseLostError.new(@task.id, :sleep)
          when "conflict" then raise ConflictError.new(:sleep, name)
          when "limit_exceeded" then raise LimitExceededError.new(:sleep, name)
          when "scheduled", "elapsed" then nil
          else raise UnexpectedStatusError.new(:sleep, status)
          end
          log(:info, "workhorse.task.wait_processed", "Durable task wait processed",
            "workhorse.wait.name" => name, "workhorse.wait.status" => status)
          wait = wait_record(row, name)
          @lock.synchronize { waits[name] = wait if @loaded.key?(:waits) }
          raise suspension(cancel: true) if status == "scheduled" && @arbiter.submit(:suspended_for_wait)

          nil
        end
      end

      def run_child_set(children, mode)
        raise ArgumentError, "children must be an Array of ChildTaskRequest" unless
          children.is_a?(Array) && children.all?(ChildTaskRequest)
        raise LimitExceededError.new(:run_children, "child set") if children.length > MAX_CHILDREN

        children.each { |child| child_name(child.name) }
        raise ArgumentError, "child names must be unique" unless children.map(&:name).uniq.length == children.length

        requests = children.map do |child|
          {"name" => child.name,
           "request" => @queue.serialize_child_request(@task, child.task_type, child.payload, child.options)}
        end
        encoded = canonical_json(requests)
        once(:run_children, :set, "#{mode}:#{encoded}", "child set") do
          @cancellation.check!
          row = write(SqlCatalogue::CREATE_CHILDREN_V1, encoded, mode)
          status = row.fetch("status")
          case status
          when "stale" then raise LeaseLostError.new(@task.id, :run_children)
          when "conflict" then raise ConflictError.new(:run_children, "child set")
          when "limit_exceeded" then raise LimitExceededError.new(:run_children, "child set")
          when "result_too_large"
            raise ChildResultLimitExceededError.new(Values.parse_integer(row["result_bytes"]).to_i,
              Values.parse_integer(row["result_limit_bytes"]).to_i)
          when "created", "completed"
            log(:info, "workhorse.task.child_processed", "Child set processed",
              "workhorse.child.count" => children.length, "workhorse.child.status" => status)
            suspend(:suspended_for_child) if status == "created"
            joined(Values.parse_json(row["children"]) || [], mode)
          else raise UnexpectedStatusError.new(:run_children, status)
          end
        end
      end

      def joined(children, mode)
        children.to_h do |child|
          next [child.fetch("name"), child["result"]] if mode == "all_success"

          outcome = child.fetch("outcome")
          status = CHILD_OUTCOMES.fetch(outcome.fetch("status")) do |text|
            raise UnexpectedStatusError.new(:run_children, text)
          end
          [child.fetch("name"), ChildOutcome.new(status: status, result: outcome["result"], error: outcome["error"])]
        end
      end

      # Runs the block once per +kind+ and +name+ at a time. A concurrent caller with the same
      # +request+ receives the running call's result or error; a different request conflicts.
      def once(kind, name, request = nil, conflict_name = name)
        future = nil
        running = @lock.synchronize do
          current = @calls[kind][name]
          if current.nil?
            future = Concurrent::Promises.resolvable_future
            @calls[kind][name] = [request, future]
            nil
          else
            raise ConflictError.new(kind, conflict_name) unless current[0] == request

            current[1]
          end
        end
        return running.value! unless running.nil?

        begin
          result = yield
          future.fulfill(result)
          result
        rescue Exception => e # rubocop:disable Lint/RescueException
          future.reject(e)
          raise
        ensure
          @lock.synchronize { @calls[kind].delete(name) if @calls[kind][name]&.last.equal?(future) }
        end
      end

      # Raises a fresh Suspension. The first outcome to reach the arbiter cancels the token.
      def suspend(outcome)
        raise suspension(cancel: @arbiter.submit(outcome))
      end

      def suspension(cancel:)
        @cancellation.cancel(:suspended) if cancel
        Suspension.new
      end

      def write(sql, *arguments)
        rows = @executor.fenced_rows(sql, [@task.id, @worker_id, @task.fence_token, *arguments])
        raise Error, "PostgreSQL lifecycle transition did not return exactly one row" unless rows.one?

        rows.first
      end

      def expect(operation, row, known, name)
        status = row.fetch("status")
        case status
        when "stale" then raise LeaseLostError.new(@task.id, operation)
        when "conflict" then raise ConflictError.new(operation, name)
        when *known then status
        else raise UnexpectedStatusError.new(operation, status)
        end
      end

      # Loads one lazily read collection. The first load's error repeats on every later call.
      def load(kind)
        @lock.synchronize do
          unless @loaded.key?(kind)
            @loaded[kind] = begin
              [:ok, yield]
            rescue => e
              [:error, e]
            end
          end
          state, value = @loaded[kind]
          raise value if state == :error

          value
        end
      end

      def checkpoints
        load(:checkpoints) do
          @executor.rows(SqlCatalogue::LIST_CHECKPOINTS, [@task.id]).to_h do |row|
            [row.fetch("checkpoint_name"), checkpoint_record(row, row.fetch("checkpoint_name"))]
          end
        end
      end

      def waits
        load(:waits) do
          @executor.rows(SqlCatalogue::LIST_WAITS, [@task.id]).to_h do |row|
            [row.fetch("wait_name"), wait_record(row, row.fetch("wait_name"))]
          end
        end
      end

      def checkpoint_record(row, name)
        TaskCheckpoint.new(
          task_id: @task.id, name: name, value: Values.parse_json(row["checkpoint_value"]),
          attempt: Values.parse_integer(row["attempt"]), fence_token: Values.parse_integer(row["fence_token"]),
          worker_id: row["worker_id"], created_at: Values.parse_time(row["created_at"])
        )
      end

      def progress_record(row)
        TaskProgress.new(
          task_id: @task.id, value: Values.parse_json(row["progress_value"]),
          revision: Values.parse_integer(row["revision"]), attempt: Values.parse_integer(row["attempt"]),
          fence_token: Values.parse_integer(row["fence_token"]), worker_id: row["worker_id"],
          created_at: Values.parse_time(row["created_at"]), updated_at: Values.parse_time(row["updated_at"])
        )
      end

      def wait_record(row, name)
        mode = row.fetch("mode")
        raise UnexpectedStatusError.new(:sleep, mode) unless %w[relative absolute].include?(mode)

        TaskWait.new(
          task_id: @task.id, name: name, mode: mode.to_sym, duration_ms: Values.parse_integer(row["duration_ms"]),
          requested_wake_at: Values.parse_time(row["requested_wake_at"]), wake_at: Values.parse_time(row["wake_at"]),
          attempt: Values.parse_integer(row["attempt"]), fence_token: Values.parse_integer(row["fence_token"]),
          worker_id: row["worker_id"], created_at: Values.parse_time(row["created_at"])
        )
      end

      def external_name(name, label)
        return if name.is_a?(String) && name.strip == name && name.length.between?(1, 200)

        raise ArgumentError, "#{label} name must contain between 1 and 200 characters without surrounding whitespace"
      end

      def external_timeout(timeout, label)
        timeout && Values.milliseconds(timeout, "#{label} timeout", 1..MAX_EXTERNAL_TIMEOUT_MS)
      end

      def child_name(name)
        return if name.is_a?(String) && name.length.between?(1, 200)

        raise ArgumentError, "child name must contain between 1 and 200 characters"
      end

      # JSON with every object's keys sorted, so equal requests encode to equal text.
      def canonical_json(value) = JSON.generate(canonical(value))

      def canonical(value)
        case value
        when Hash then value.sort_by { |key, _| key.to_s }.to_h { |key, item| [key, canonical(item)] }
        when Array then value.map { |item| canonical(item) }
        else value
        end
      end

      def log(severity, event, body, attributes)
        Telemetry.log(@logger, severity, event, body,
          Telemetry.task_span_attributes(@task).merge(attributes, "workhorse.worker.id" => @worker_id))
      end
    end
  end
end
