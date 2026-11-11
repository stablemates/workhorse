# frozen_string_literal: true

require "connection_pool"
require "json"
require "pg"
require "time"

module Conformance
  # Runs the durable-script fixtures of protocol/v1/runtime.json (SM-1950).
  #
  # A handler runs the fixture's script through its handler context, and the runner drives the task
  # through the fixture's steps. protocol/README.md describes the operations and the steps. The phase
  # "suspend" runs the steps before "handOff", and "replay" runs the steps after it, so two SDKs can
  # share one task. "all" runs every step and resets the counters at "handOff".
  class DurableScript
    # A bound on the claims of one run step, so a defect cannot loop for ever. The run_once of each
    # SDK can claim more than one task, so a step names the work that ends, not a count of claims.
    MAXIMUM_DRAIN_PASSES = 20
    # The operations that can suspend the task.
    SUSPENDING = %w[sleep sleepUntil waitForSignal waitForHuman runChild].freeze

    # Counts handler runs, checkpoint operations, and caught suspensions across handler threads.
    class Counters
      NAMES = {"handlerRuns" => :handler_runs, "checkpointOperations" => :checkpoint_operations,
               "caughtSuspensions" => :caught_suspensions, "completedScripts" => :completed_scripts,
               "returnedSuspendingCalls" => :returned_suspending_calls}.freeze

      def initialize
        @lock = Mutex.new
        @values = Hash.new(0)
      end

      def add(name) = @lock.synchronize { @values[name] += 1 }

      def [](name) = @lock.synchronize { @values[name] }

      def reset = @lock.synchronize { @values.clear }
    end

    def initialize(url, fixture)
      @url = url
      @fixture = fixture
      @counters = Counters.new
    end

    def run(phase)
      steps = select_steps(phase)
      PG.connect(@url) do |connection|
        connection.set_notice_receiver { nil }
        task_id = prepare_task(connection, phase)
        with_pool do |pool|
          workers = {"task" => task_worker(pool)}
          workers["child"] = child_worker(pool) if @fixture.key?("childQueue")
          steps.each_with_index do |step, index|
            where = "#{@fixture["id"]} step #{index + 1} (#{step["action"]})"
            run_step(connection, workers, task_id, step, where)
          end
        end
      end
    end

    private

    def select_steps(phase)
      steps = @fixture.fetch("steps")
      return steps if phase == "all"

      hand_off = steps.index { |step| step["action"] == "handOff" }
      raise Failure, "#{@fixture["id"]} has no handOff step for the #{phase} phase" if hand_off.nil?

      case phase
      when "suspend" then steps[0...hand_off]
      when "replay" then steps[(hand_off + 1)..]
      else raise Failure, "unknown phase #{phase}"
      end
    end

    def queue_name = "runtime-#{@fixture["id"]}"

    def prepare_task(connection, phase)
      if phase == "replay"
        rows = connection.exec_params("SELECT id::text FROM workhorse.task WHERE task_type = $1",
          [@fixture["taskType"]]).values
        raise Failure, "expected one #{@fixture["taskType"]} task, found #{rows.length}" unless rows.length == 1

        return rows.first.first
      end
      payload = @fixture.key?("payloadSql") ? JSON.parse(connection.exec(@fixture["payloadSql"]).getvalue(0, 0)) : {}
      W::Queue.new(connection).enqueue(@fixture["taskType"], payload, queue: queue_name).task_id
    end

    def with_pool
      pool = ConnectionPool.new(size: 4, timeout: 5) { PG.connect(@url) }
      yield pool
    ensure
      pool&.shutdown(&:close)
    end

    def task_worker(pool)
      W::Worker.new(pool, queues: [queue_name], worker_id: "ruby-#{@fixture["id"]}", concurrency: 1,
        polling_only: true, disable_registry: true, poll_interval: 0.005).handle(@fixture["taskType"]) do |payload, context|
        run_script(payload, context)
      end
    end

    def child_worker(pool)
      W::Worker.new(pool, queues: [@fixture["childQueue"]], worker_id: "ruby-#{@fixture["id"]}-children",
        concurrency: 1, polling_only: true, disable_registry: true, poll_interval: 0.005)
        .handle(@fixture["childTaskType"]) { |payload| {"echo" => payload} }
    end

    def run_step(connection, workers, task_id, step, where)
      case step["action"]
      when "run" then drain(workers.fetch(step.fetch("worker", "task")), where)
      when "sql" then connection.exec_params(step["sql"], [task_id])
      when "handOff" then @counters.reset
      when "expect" then expect_observed(connection, task_id, step, where)
      else raise Failure, "#{where}: unknown action"
      end
    end

    def drain(worker, where)
      raise Failure, "#{where}: the worker claimed no task" unless worker.run_once

      MAXIMUM_DRAIN_PASSES.times { return unless worker.run_once }
      raise Failure, "#{where}: the queue did not drain"
    end

    def expect_observed(connection, task_id, step, where)
      observed = JSON.parse(connection.exec_params(@fixture["observe"], [task_id]).getvalue(0, 0))
      unless observed == step["observed"]
        raise Failure, "#{where}: observed #{JSON.generate(observed)}, expected #{JSON.generate(step["observed"])}"
      end

      Counters::NAMES.each do |name, counter|
        next unless step.key?(name)

        actual = @counters[counter]
        raise Failure, "#{where}: #{name} is #{actual}, expected #{step[name]}" unless actual == step[name]
      end
    end

    def run_script(payload, context)
      @counters.add(:handler_runs)
      result = {}
      @fixture.fetch("script").each do |operation|
        if operation["op"] == "catchSuspension"
          begin
            run_operation(operation.fetch("step"), payload, context)
          rescue Exception # rubocop:disable Lint/RescueException
            # The handler catches the suspension and returns. The worker must suspend the task anyway.
            @counters.add(:caught_suspensions)
            return {operation["key"] => true}
          end
          result[operation["key"]] = false
          next
        end
        value = run_operation(operation, payload, context)
        result[operation["key"]] = value if operation.key?("key")
      end
      # A handler run that suspends never reaches the end of the script.
      @counters.add(:completed_scripts)
      result
    end

    def payload_time(payload, field)
      value = payload[field]
      raise ArgumentError, "the payload field #{field} is not text" unless value.is_a?(String)

      Time.iso8601(value)
    end

    def child_options(operation, payload)
      options = {queue: @fixture["childQueue"]}
      options[:deadline] = payload_time(payload, operation["deadlineField"]) if operation.key?("deadlineField")
      options[:run_at] = payload_time(payload, operation["runAtField"]) if operation.key?("runAtField")
      options
    end

    # Counts each timer, wait, and child call that returned. A call that suspends never returns.
    def run_operation(operation, payload, context)
      value = run_operation_once(operation, payload, context)
      @counters.add(:returned_suspending_calls) if SUSPENDING.include?(operation["op"])
      value
    end

    def run_operation_once(operation, payload, context)
      case operation["op"]
      when "checkpoint"
        block = lambda do
          @counters.add(:checkpoint_operations)
          operation["value"]
        end
        if operation.key?("input")
          context.checkpoint(operation["name"], input: operation["input"], &block)
        else
          context.checkpoint(operation["name"], &block)
        end
      when "sleep"
        context.sleep(operation["name"], operation["durationMs"] / 1000.0)
        nil
      when "sleepUntil"
        context.sleep_until(operation["name"], payload_time(payload, operation["wakeAtField"]))
        nil
      when "waitForSignal" then context.wait_for_signal(operation["name"])
      when "waitForHuman" then context.wait_for_human(operation["name"], operation["context"])
      when "runChild"
        context.run_child(operation["name"], @fixture["childTaskType"], operation["payload"],
          **child_options(operation, payload))
      when "runChildren"
        requests = operation["children"].map do |child|
          W::ChildTaskRequest.new(name: child["name"], task_type: @fixture["childTaskType"],
            payload: child["payload"], options: {queue: @fixture["childQueue"]})
        end
        joined = context.run_children(requests)
        # The set join counts as returned before the runner reads its outcomes, so a wrong value still counts.
        @counters.add(:returned_suspending_calls)
        joined.to_h do |name, outcome|
          status = outcome.status.to_s
          [name, (status == "succeeded") ? {"status" => status, "result" => outcome.result} : {"status" => status}]
        end
      when "overlappingCheckpoints" then overlapping_checkpoints(operation, context)
      else raise ArgumentError, "unknown durable-script operation #{operation["op"]}"
      end
    end

    # Starts a second call with one name while the operation of the first call runs. The operation
    # waits until a second operation starts or the window ends, so a call that does not join the call
    # in flight runs the operation again.
    def overlapping_checkpoints(operation, context)
      started = Thread::Queue.new
      block = lambda do
        ordinal = @counters.add(:checkpoint_operations)
        started << true
        deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + (operation["overlapWindowMs"] / 1000.0)
        while @counters[:checkpoint_operations] < 2 && Process.clock_gettime(Process::CLOCK_MONOTONIC) < deadline
          Kernel.sleep 0.01
        end
        {"operation" => ordinal}
      end
      first = Thread.new do
        context.checkpoint(operation["name"], &block)
      rescue Exception => e # rubocop:disable Lint/RescueException
        started << true
        e
      end
      started.pop
      second = context.checkpoint(operation["name"], &block)
      value = first.value
      raise value if value.is_a?(Exception)

      [value, second]
    end
  end
end
