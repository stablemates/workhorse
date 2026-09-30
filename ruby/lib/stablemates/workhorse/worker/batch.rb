# frozen_string_literal: true

module Stablemates
  module Workhorse
    class Worker
      # One task waiting in a batch coordinator. +result+ resolves with the member's result or
      # rejects with its error.
      PendingBatchMember = Struct.new(:arrival_order, :arrived_at, :payload, :context, :result) # :nodoc:
      private_constant :PendingBatchMember

      # Registers a block that runs tasks of +task_type+ in batches. Each claimed task waits up to
      # +linger+ seconds for others of its queue, and at most +max_size+ run in one call. Once the
      # worker stops, a batch waits only for tasks it already claimed. The block receives one
      # BatchHandlerItem per task, highest priority first and then in claim order, each holding the
      # task's payload and its own BatchHandlerContext. It returns one outcome per item, in order:
      # <tt>{status: :succeeded, result: value}</tt> or <tt>{status: :failed, error: exception}</tt>.
      # Every task still holds its own lease and settles on its own. A second call replaces the first.
      def handle_batch(task_type, max_size:, linger:, &handler)
        raise ArgumentError, "handle_batch requires a block" if handler.nil?
        raise ArgumentError, "max_size must be an integer between 1 and 100" unless
          max_size.is_a?(Integer) && max_size.between?(1, 100)
        raise ArgumentError, "max_size must not exceed worker concurrency" if max_size > @concurrency

        linger_ms = Values.milliseconds(linger, "linger", 0..60_000)
        coordinator = BatchCoordinator.new(self, task_type, handler, max_size, linger_ms)
        handle(task_type) { |payload, context| coordinator.run(payload, context) }
        @batch_coordinators[task_type] = coordinator
        self
      end

      # Whether the worker stops and every task of +task_type+ it admitted from +queue+ has
      # reached the coordinator, as the Set +entered+ records. No later member can join a batch then.
      def batch_arrivals_complete?(task_type, queue, entered) # :nodoc:
        @draining && @active.each_pair.none? do |task_id, active|
          active.task.type == task_type && active.task.queue == queue && !entered.include?(task_id)
        end
      end

      def draining? = @draining # :nodoc:

      # The claim order dispatch gave +task+. A task dispatch never saw sorts after every other.
      def claim_order(task) = @state_lock.synchronize { @dispatch_order.fetch(task.id, @dispatch_seq) } # :nodoc:

      # Records a batch's dispatch or failure evidence. A write failure only logs, because the
      # evidence must not decide the members' outcomes.
      def record_batch_evidence(sql, phase, batch_id, task_type, batch, full) # :nodoc:
        tasks = batch.map { |member| member.context.task }
        rows = @executor.fenced_rows(sql, [
          batch_id,
          Values.text_array(tasks.map(&:id), "task ids"),
          Values.text_array(tasks.map { |task| task.attempt.to_s }, "attempts"),
          Values.text_array(tasks.map { |task| task.fence_token.to_s }, "fence tokens"),
          @worker_id
        ])
        raise Error, "PostgreSQL did not record every batch member" unless rows.first&.fetch("recorded", nil).to_i == batch.size
      rescue => e
        log(:warn, "workhorse.handler.batch_evidence_failed", "Batch execution evidence could not be persisted",
          "workhorse.queue.name" => tasks.first.queue, "workhorse.task.type" => task_type,
          "workhorse.handler.batch.full" => full, "workhorse.handler.batch.size" => batch.size,
          "workhorse.handler.batch.evidence_phase" => phase, "error.type" => e.class.name)
      end

      # Logs and measures one batch as it starts.
      def record_batch_dispatch(task_type, batch, full, linger_ms) # :nodoc:
        queue = batch.first.context.task.queue
        attributes = {
          "workhorse.queue.name" => queue, "workhorse.task.type" => task_type, "workhorse.handler.batch.full" => full
        }
        Telemetry.record("workhorse.handler.batch.size", batch.size, attributes)
        Telemetry.record("workhorse.handler.batch.linger", linger_ms, attributes)
        log(:info, "workhorse.handler.batch_dispatched", "Task batch dispatched",
          attributes.merge("workhorse.handler.batch.size" => batch.size, "workhorse.handler.batch.linger_ms" => linger_ms))
      end

      # Groups the tasks of one batch handler. Each member runs on its own handler thread and
      # joins its queue's waiting list. The member that fills a batch, or whose linger ends first,
      # runs the handler for the whole batch on its own thread, and the others wait for their
      # outcomes. Internal to the SDK.
      class BatchCoordinator # :nodoc:
        # How often a lingering member checks for the last arrival while the worker stops.
        DRAIN_POLL = 0.05

        def initialize(worker, task_type, handler, max_size, linger_ms)
          @worker = worker
          @task_type = task_type
          @handler = handler
          @max_size = max_size
          @linger = linger_ms / 1000.0
          @lock = Mutex.new
          @pending = {}
          @entered = Set.new
          @flush = Concurrent::Promises.resolvable_event
        end

        # Wakes every lingering member, because the worker began to stop.
        def flush!
          @lock.synchronize do
            flushed = @flush
            @flush = Concurrent::Promises.resolvable_event
            flushed
          end.resolve
        end

        def run(payload, context)
          task = context.task
          member = PendingBatchMember.new(@worker.claim_order(task), monotonic, payload, context,
            Concurrent::Promises.resolvable_future)
          queue = task.queue
          batch, first_arrived_at = @lock.synchronize do
            @entered << task.id
            waiting = (@pending[queue] ||= [])
            # Every member enters in order, so the waiting list's prefix is the next batch.
            waiting.insert(waiting.bsearch_index { |other| (order(other) <=> order(member)).positive? } || waiting.size, member)
            [(waiting.size >= @max_size) ? take(queue) : [], waiting.map(&:arrived_at).min || member.arrived_at]
          end
          dispatch(batch)
          # A member the full batch left behind lingers too. Once its linger ends, it runs every
          # batch ahead of it and then its own, so no member waits for a later arrival.
          unless linger(member, queue, first_arrived_at + @linger)
            while (batch = @lock.synchronize { @pending[queue]&.include?(member) ? take(queue) : nil })
              dispatch(batch)
            end
          end
          member.result.value!
        ensure
          @lock.synchronize { @entered.delete(task.id) }
        end

        private

        # Waits until +member+ settles, its linger ends at +linger_end+, or the worker stops with
        # every member it claimed already here. Returns whether the member settled.
        def linger(member, queue, linger_end)
          loop do
            return true if member.result.resolved?

            flush = @lock.synchronize { @flush unless @worker.batch_arrivals_complete?(@task_type, queue, @entered) }
            remaining = linger_end - monotonic
            return member.result.resolved? if flush.nil? || remaining <= 0

            remaining = [remaining, DRAIN_POLL].min if @worker.draining?
            Concurrent::Promises.any_event(member.result, flush).wait(remaining)
          end
        end

        # Ranks a waiting member by descending task priority, then by claim order.
        def order(member) = [-member.context.task.priority, member.arrival_order]

        # Removes the next batch from a queue's waiting list. The caller holds @lock.
        def take(queue)
          waiting = @pending[queue]
          return [] if waiting.nil?

          batch = waiting.shift(@max_size)
          @pending.delete(queue) if waiting.empty?
          batch
        end

        def dispatch(batch)
          return if batch.empty?

          batch_id = SecureRandom.uuid
          full = batch.size == @max_size
          linger_ms = [0.0, (monotonic - batch.map(&:arrived_at).min) * 1000].max
          @worker.record_batch_dispatch(@task_type, batch, full, linger_ms)
          @worker.record_batch_evidence(SqlCatalogue::RECORD_BATCH_DISPATCH_V1, "dispatch", batch_id, @task_type, batch, full)
          items = batch.map { |member| BatchHandlerItem.new(payload: member.payload, context: BatchHandlerContext.new(member.context)) }
          begin
            outcomes = validate(@handler.call(items), batch.size)
          rescue Exception => e # rubocop:disable Lint/RescueException
            error = settleable(e, "raised")
            @worker.record_batch_evidence(SqlCatalogue::RECORD_BATCH_FAILURE_V1, "failure", batch_id, @task_type, batch, full)
            batch.each { |member| member.result.reject(error) }
            return
          end
          batch.zip(outcomes) do |member, outcome|
            if outcome[:status] == :succeeded
              member.result.fulfill(outcome[:result])
            else
              member.result.reject(settleable(outcome[:error], "returned"))
            end
          end
        end

        # Every member must settle, so an error outside StandardError fails it as a RuntimeError.
        def settleable(error, verb)
          return error if error.is_a?(StandardError)

          RuntimeError.new("Batch handler for #{@task_type} #{verb} #{error.class}: #{error.message}")
        end

        def validate(outcomes, expected)
          raise "Batch handler for #{@task_type} returned a non-array outcome value" unless outcomes.is_a?(Array)
          unless outcomes.size == expected
            raise "Batch handler for #{@task_type} returned #{outcomes.size} outcomes for #{expected} tasks"
          end

          outcomes.each_with_index do |outcome, index|
            next if outcome.is_a?(Hash) && outcome[:status] == :succeeded && outcome.key?(:result)
            next if outcome.is_a?(Hash) && outcome[:status] == :failed && outcome[:error].is_a?(Exception)

            raise "Batch handler for #{@task_type} returned an invalid outcome at index #{index}"
          end
        end

        def monotonic = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      end
      private_constant :BatchCoordinator
    end
  end
end
