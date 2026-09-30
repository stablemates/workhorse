# frozen_string_literal: true

module Stablemates
  module Workhorse
    # Claims tasks from PostgreSQL and runs their handlers under renewed leases.
    #
    # A worker takes a ConnectionPool, or any object whose +with+ yields a PG::Connection and whose
    # +size+ reports its capacity. Handlers run on the worker's own thread pool, so +concurrency+
    # tasks run at once. Every write an attempt makes carries its fence token, so an attempt that
    # lost its lease cannot change the task.
    #
    # Durations are Numeric seconds. +run+ blocks until +stop+; +run_once+ claims and runs one
    # batch. A stopping worker claims nothing new, waits up to +shutdown_grace+ for running
    # handlers, cancels the rest with +:shutdown+, and raises ShutdownIncompleteError when any
    # handler still runs after one short unwind window.
    class Worker
      MAX_EMPTY_POLL_MS = 5_000
      NOTIFICATION_POLL_MS = 5_000
      NOTIFICATION_CLAIM_DELAY = 0.05
      UNWIND_WINDOW = 0.25
      THREAD_RETURN_WAIT = 0.001
      EXPIRATION_RETRY = 0.005
      REDACTED_NAME = "RedactedTaskError"
      REDACTED_MESSAGE = "Task handler failed; details redacted"
      PROTOCOL = "5"
      LANGUAGE = "ruby"
      MIN_POOL_SIZE = 3
      COMPLETION_BATCH_LIMIT = 100
      TIER_PROBE_INTERVAL = 30
      STATUS_OUTCOMES = {
        "cancel_requested" => :cancelled, "deadline_exceeded" => :deadline_exceeded,
        "timeout_exceeded" => :attempt_timeout, "stale" => :lease_expired
      }.freeze
      TELEMETRY_OUTCOMES = {
        :completed => "succeeded", :failed => "failed", :retry => "retry", :lease_expired => "lease_lost",
        :released => "released", :deadline_exceeded => "deadline_exceeded", :attempt_timeout => "timeout",
        :cancelled => "canceled", :suspended_for_wait => "suspended", :suspended_for_child => "suspended",
        nil => "unknown"
      }.freeze
      SPAN_OUTCOMES = TELEMETRY_OUTCOMES.merge(lease_expired: "stale", attempt_timeout: "timeout_exceeded").freeze
      CANCEL_REASONS = {
        cancelled: :requested, deadline_exceeded: :deadline_exceeded, attempt_timeout: :execution_timeout
      }.freeze
      private_constant :MAX_EMPTY_POLL_MS, :NOTIFICATION_POLL_MS, :NOTIFICATION_CLAIM_DELAY, :UNWIND_WINDOW,
        :THREAD_RETURN_WAIT, :EXPIRATION_RETRY, :REDACTED_NAME, :REDACTED_MESSAGE, :PROTOCOL, :LANGUAGE, :MIN_POOL_SIZE,
        :COMPLETION_BATCH_LIMIT, :TIER_PROBE_INTERVAL,
        :STATUS_OUTCOMES, :TELEMETRY_OUTCOMES, :SPAN_OUTCOMES, :CANCEL_REASONS

      # One attempt's hold on its lease: the heartbeat membership, the lease watchdog, and the lock
      # that orders settlements. Internal to the SDK.
      class Ownership # :nodoc:
        attr_reader :stop, :errors, :settlement

        def initialize(renewed_at, lease_seconds)
          @renewed_at = renewed_at
          @lease_seconds = lease_seconds
          @renewal = Mutex.new
          @settlement = Mutex.new
          @stop = Concurrent::Event.new
          @errors = Concurrent::Array.new
          @released = Concurrent::AtomicBoolean.new(false)
          @unregister = nil
          @watchdog = nil
        end

        def renew(sent_at) = @renewal.synchronize { @renewed_at = [@renewed_at, sent_at].max }

        def lease_deadline = @renewal.synchronize { @renewed_at + @lease_seconds }

        def start(unregister, watchdog)
          @unregister = unregister
          @watchdog = watchdog
        end

        # Stops renewing without waiting for the watchdog. A shutdown abandons with this.
        def abandon
          @unregister&.call
          @stop.set
        end

        # Stops renewing and waits for the watchdog. Only the first call acts.
        def release
          return unless @released.make_true

          abandon
          @watchdog&.join unless Thread.current.equal?(@watchdog)
        end
      end
      private_constant :Ownership

      # One admitted ClaimedTask. +ownership+ is an AtomicReference that holds its Ownership once
      # its handler starts.
      Active = Struct.new(:cancellation, :ownership, :task) # :nodoc:
      private_constant :Active

      # The dispatch loop's slot accounting, which fast-tier completions share. Every field changes
      # under the worker's @state_lock. A slot is busy while its executor thread runs, reserved
      # while a claim for it is in flight, and handed over once a completion claimed a task into
      # it. Handed-over slots count as free, because the task that fills them is already admitted.
      class DispatchSlots # :nodoc:
        attr_reader :concurrency, :refill_batch, :cohort_capacity, :listener, :version, :run_errors, :handlers,
          :cohort_active, :cohort_handed_over, :cohort_reserved, :cohort_claims, :handed_over, :thread_cohorts
        attr_accessor :whole_claims, :reserved, :empty, :empty_wait, :pass_ended, :claimed_any, :claim_error, :open

        def initialize(concurrency, cohorts, listener, version, run_errors, handlers)
          @concurrency = concurrency
          # A claim waits for a quarter of the slots, so at most four claims are in flight.
          @refill_batch = (concurrency / 4.0).ceil
          # Spreads the remainder over the first cohorts, so sizes differ by at most one slot.
          @cohort_capacity = Array.new(cohorts) { |index| (concurrency / cohorts) + ((index < concurrency % cohorts) ? 1 : 0) }
          @listener = listener
          @version = version
          @run_errors = run_errors
          @handlers = handlers
          @cohort_active = Array.new(cohorts, 0)
          @cohort_handed_over = Array.new(cohorts, 0)
          @cohort_reserved = Array.new(cohorts, 0)
          @cohort_claims = Array.new(cohorts, 0)
          # Maps a task whose completion handed its slot over, and a running task, to its cohort.
          @handed_over = {}
          @thread_cohorts = {}
          @whole_claims = 0
          @reserved = 0
          @empty = 0
          @empty_wait = nil
          @pass_ended = false
          @claimed_any = false
          @claim_error = nil
          @open = true
        end

        def free_slots = [@concurrency - @handlers.active_count + @handed_over.size - @reserved, thread_room].min

        # The executor threads a claim may still start. A handed-over thread keeps its executor
        # thread until it returns, so handovers in a row could otherwise outrun the executor.
        def thread_room = @handlers.max_length - @handlers.active_count - @reserved

        def cohort_free(cohort)
          @cohort_capacity[cohort] - @cohort_active[cohort] + @cohort_handed_over[cohort] - @cohort_reserved[cohort]
        end

        def roomiest_cohort = @cohort_capacity.each_index.max_by { |cohort| [cohort_free(cohort), -cohort] }
      end
      private_constant :DispatchSlots

      # The fused claim one fast-tier completion reserved: its limit, its cohort, and the wake
      # version when it reserved. A zero limit reserves nothing.
      CompletionClaim = Struct.new(:limit, :cohort, :wake_version) # :nodoc:
      private_constant :CompletionClaim

      # One completion waiting for a batched complete_many_and_claim_v1 statement. The statement's
      # sender fills +accepted+, +claimed+, +full_tier+, or +error+ and sets +done+. +lead+ makes a
      # waiting completion the sender of the next statement.
      PendingCompletion = Struct.new(:task, :encoded, :limit, :done, :accepted, :claimed, :full_tier, :error, :lead) # :nodoc:
      private_constant :PendingCompletion

      attr_reader :worker_id, :queues, :concurrency, :cohorts

      def initialize(pool, queues: ["default"], worker_id: nil, concurrency: 1, lease: 30, heartbeat: nil,
        poll_interval: nil, polling_only: false, maintenance_interval: 1, maintenance_routine_interval: 60,
        registry_interval: 5, disable_registry: false, schedule_namespaces: [], schedule_catchup_limit: 100,
        shutdown_grace: 25, shared_heartbeats: false, retry_delay: nil, on_registration_error: nil,
        on_notification_error: nil, cohorts: nil, logger: nil)
        @executor = worker_executor(pool, shared_heartbeats)
        @pool = pool
        @queues = unique_names(queues, "queues")
        raise ArgumentError, "queues must contain at least one non-empty queue name" if @queues.empty?

        raise ArgumentError, "concurrency must be an Integer between 1 and 100" unless
          concurrency.is_a?(Integer) && concurrency.between?(1, 100)

        @concurrency = concurrency
        @cohorts = dispatch_cohorts(cohorts, pool, shared_heartbeats)
        @worker_id = worker_id || "#{Socket.gethostname}-#{Process.pid}-#{SecureRandom.hex(4)}"
        raise ArgumentError, "worker_id must be a non-empty String" unless @worker_id.is_a?(String) && !@worker_id.empty?

        @lease_ms = Values.milliseconds(lease, "lease", 100..86_400_000)
        @heartbeat_ms = heartbeat.nil? ? [100, @lease_ms / 3].max : Values.milliseconds(heartbeat, "heartbeat", 1..)
        raise ArgumentError, "heartbeat must be positive and less than lease" unless @heartbeat_ms < @lease_ms

        @poll_ms = poll_interval.nil? ? 250 : Values.milliseconds(poll_interval, "poll_interval", 1..)
        @notification_poll_ms = poll_interval.nil? ? NOTIFICATION_POLL_MS : @poll_ms
        @polling_only = polling_only ? true : false
        @maintenance_ms = Values.milliseconds(maintenance_interval, "maintenance_interval", 100..)
        @routine_ms = Values.milliseconds(maintenance_routine_interval, "maintenance_routine_interval", 100..)
        @registry_ms = disable_registry ? 0 : Values.milliseconds(registry_interval, "registry_interval", 100..)
        @schedule_namespaces = unique_names(schedule_namespaces, "schedule_namespaces")
        raise ArgumentError, "schedule_catchup_limit must be an Integer between 1 and 10000" unless
          schedule_catchup_limit.is_a?(Integer) && schedule_catchup_limit.between?(1, 10_000)

        @schedule_catchup_limit = schedule_catchup_limit
        @shutdown_grace = Values.milliseconds(shutdown_grace, "shutdown_grace", 0..86_400_000) / 1000.0
        unless retry_delay.nil? || retry_delay.respond_to?(:call)
          Values.milliseconds(retry_delay, "retry_delay", 0..2_147_483_647)
        end
        @retry_delay = retry_delay
        @on_registration_error = on_registration_error
        @on_notification_error = on_notification_error
        @logger = logger
        @queue = Queue.new(@executor, default_queue: @queues.first)
        @heartbeat = shared_heartbeats ? Heartbeat.new(@executor, dedicated: false) : Heartbeat.dedicated(pool)
        @handlers = Concurrent::Map.new
        @batch_coordinators = Concurrent::Map.new
        @contracts = Concurrent::Map.new
        @run_lock = Mutex.new
        @wake = Concurrent::Event.new
        @notified = Concurrent::AtomicBoolean.new(false)
        @stop_version = Concurrent::AtomicFixnum.new
        @run_version = nil
        @locally_paused = Concurrent::AtomicBoolean.new(false)
        @remotely_paused = Concurrent::AtomicBoolean.new(false)
        @active = Concurrent::Map.new
        @next_queue_index = Concurrent::AtomicFixnum.new
        @last_maintenance_at = Concurrent::AtomicReference.new(-Float::INFINITY)
        @last_routine_at = -Float::INFINITY
        @last_registry_at = -Float::INFINITY
        @registered = Concurrent::AtomicBoolean.new(false)
        @instance_id = nil
        @draining = false
        # Guards the dispatch slots, the queue tiers, and the claim order that handler threads share
        # with the dispatch loop.
        @state_lock = Mutex.new
        @dispatch_slots = nil
        # Counts state changes, so an empty-claim wait ends when one arrives during its claim.
        @wake_version = 0
        @full_tier_until = {}
        @fast_tier_queues = Set.new
        @fast_task_ids = Set.new
        @tier_reads = {}
        @dispatch_order = {}
        @dispatch_seq = 0
        @completion_lock = Mutex.new
        @pending_completions = {}
      end

      # Registers the block that runs tasks of +task_type+. The block receives the payload and a
      # HandlerContext; its return value is the task's JSON result. A second call replaces the first.
      def handle(task_type, &handler)
        raise ArgumentError, "task_type must be a non-empty String" unless task_type.is_a?(String) && !task_type.empty?
        raise ArgumentError, "handle requires a block" if handler.nil?

        @handlers[task_type] = handler
        @batch_coordinators.delete(task_type)
        self
      end

      # Claims and runs tasks until +stop+. Raises the first error that ended the run.
      def run = run_from(stop_version)

      # Claims one batch, runs it, and returns whether a handled task ran.
      def run_once
        version = @stop_version.value
        @run_lock.synchronize { run_loop(false, version) }
      end

      # Ends claiming. A running +run+ drains its handlers and returns.
      def stop
        @stop_version.increment
        active = @active.size
        log(:info, "workhorse.worker.stop_requested", "Worker stop requested",
          "workhorse.worker.active_slots" => active, "workhorse.worker.queues" => @queues)
        wake_dispatcher
      end

      # Starts no claim until +resume+. Running handlers continue.
      def pause
        @locally_paused.make_true
        log(:info, "workhorse.worker.paused", "Worker paused locally", "workhorse.worker.queues" => @queues)
        wake_dispatcher
      end

      def resume
        @locally_paused.make_false
        log(:info, "workhorse.worker.resumed", "Worker resumed locally", "workhorse.worker.queues" => @queues)
        wake_dispatcher
      end

      # Whether this worker or an operator paused it.
      def paused? = @locally_paused.true? || @remotely_paused.true?

      # Whether a stop has begun for the current run. The Active Job adapter reports it.
      def stopping? # :nodoc:
        version = @run_version
        !version.nil? && stop_requested?(version)
      end

      # The executor over the worker's pool. The Active Job adapter reads task tags through it.
      attr_reader :executor # :nodoc:

      private

      def worker_executor(pool, shared_heartbeats)
        raise ArgumentError, "Worker pool must be a ConnectionPool, not a PG::Connection" if pool.is_a?(PG::Connection)
        raise ArgumentError, "Worker pool must respond to with" unless pool.respond_to?(:with)

        capacity = pool.respond_to?(:size) ? pool.size : nil
        if !shared_heartbeats && !(capacity.is_a?(Integer) && capacity >= MIN_POOL_SIZE)
          raise ArgumentError, "Worker pool capacity must be at least #{MIN_POOL_SIZE} " \
            "(found #{capacity.nil? ? "unknown" : capacity}); set shared_heartbeats: true to opt out"
        end
        Executor.for(pool)
      end

      # Slot cohorts for fast-tier dispatch (ADR 0076). Without the option, a worker keeps one
      # pooled connection per cohort after the listener and the heartbeat connection.
      def dispatch_cohorts(cohorts, pool, shared_heartbeats)
        unless cohorts.nil?
          raise ArgumentError, "cohorts must be an integer between 1 and concurrency" unless
            cohorts.is_a?(Integer) && cohorts.between?(1, @concurrency)

          return cohorts
        end
        default = (@concurrency < 8) ? 1 : ((@concurrency + 7) / 8).clamp(2, 8)
        capacity = pool.respond_to?(:size) ? pool.size : nil
        return default unless capacity.is_a?(Integer)

        spare = capacity - 1 - (shared_heartbeats ? 0 : 1)
        spare.clamp(1, default)
      end

      def unique_names(values, label)
        values = [values] if values.is_a?(String)
        raise ArgumentError, "#{label} must be an Array of non-empty Strings" unless
          values.is_a?(Array) && values.all? { |value| value.is_a?(String) && !value.empty? }

        values.uniq.freeze
      end

      def monotonic = Process.clock_gettime(Process::CLOCK_MONOTONIC)

      def stop_requested?(version) = @stop_version.value != version

      def stop_version = @stop_version.value

      # Runs until a +stop+ issued after +version+ was read. The process helpers read the version
      # before they trap signals, so a signal that arrives before the loop starts still stops it.
      def run_from(version)
        warn_small_active_record_pool
        @run_lock.synchronize { run_loop(true, version) }
        nil
      end

      def log(severity, event, body, attributes = {})
        Telemetry.log(@logger, severity, event, body, {"workhorse.worker.id" => @worker_id}.merge(attributes))
      end

      # --- Run loop ---------------------------------------------------------------------------

      def run_loop(continuous, version)
        @run_version = version
        @queue.assert_compatible
        @instance_id = SecureRandom.uuid
        @registered.make_false
        @draining = false
        run_errors = Concurrent::Array.new
        maintenance_errors = Concurrent::Array.new
        handlers = handler_executor
        listener = nil
        startup = nil
        claimed_any = false
        begin
          if continuous && !@polling_only
            listener = Listener.new(@pool, @queues, on_wake: method(:notify),
              on_error: ->(error) { @on_notification_error&.call(error) })
          end
          refresh_registration(force: true)
          log(:info, "workhorse.worker.started", "Worker started",
            "workhorse.worker.concurrency" => @concurrency, "workhorse.worker.queues" => @queues)
          if continuous && !stop_requested?(version)
            startup = Thread.new do
              run_maintenance_if_due
            rescue => e
              maintenance_errors << e
            ensure
              @wake.set
            end
            startup.name = "workhorse-startup-maintenance"
          end
          claimed_any = dispatch(continuous, version, handlers, listener, startup, run_errors, maintenance_errors)
        ensure
          startup&.join
          listener&.close
          @draining = true
          refresh_registration(force: true)
          abandoned = drain(handlers)
          # A handler's completion may admit tasks until the drain ends, so the slots outlive it.
          @state_lock.synchronize { @dispatch_slots = nil }
          deregister
          log(:info, "workhorse.worker.stopped", "Worker stopped",
            "workhorse.worker.active_slots" => abandoned, "workhorse.worker.queues" => @queues)
        end
        raise ShutdownIncompleteError.new(abandoned) if abandoned.positive?
        raise maintenance_errors.first unless maintenance_errors.empty?
        raise run_errors.first unless run_errors.empty?

        claimed_any
      end

      # Keeps the slots full without one serial claim round trip per task (ADR 0076). A claim
      # reserves the slots it asks for, so claimed tasks never exceed the concurrency. With no claim
      # in flight, any free slot starts one. While one is in flight, another starts only once the
      # unreserved free slots reach the refill batch, so a busy worker claims in batches. A
      # fast-tier completion claims too, from the same accounting. On the fast tier the slots split
      # into cohorts, and plain claims leave one at a time, each for the roomiest cohort.
      def dispatch(continuous, version, handlers, listener, startup, run_errors, maintenance_errors)
        slots = DispatchSlots.new(@concurrency, @cohorts, listener, version, run_errors, handlers)
        @state_lock.synchronize { @dispatch_slots = slots }
        # Each claim in flight, with its limit, its cohort (nil for the whole worker), and the
        # slots it reserved in that cohort.
        claims = {}
        results = ::Queue.new
        next_claim_id = 0

        settle = lambda do |outcome|
          id, claimed_version, claimed, error = outcome
          limit, cohort, cohort_limit = claims.delete(id)
          @state_lock.synchronize do
            slots.reserved -= limit
            if cohort.nil?
              slots.whole_claims -= 1
            else
              slots.cohort_claims[cohort] -= 1
              slots.cohort_reserved[cohort] -= cohort_limit
            end
            # A claimed task holds a lease, so it runs even when the loop is stopping or failed.
            claimed.each { |task, started_at| admit(slots, task, started_at, cohort) }
            settle_claim_progress(slots, claimed, claimed_version, error)
          end
        end

        begin
          loop do
            @wake.reset
            settle.call(results.pop) until results.empty?
            refresh_registration
            claim_error, pass_ended, empty, empty_wait, wake_version = @state_lock.synchronize do
              [slots.claim_error, slots.pass_ended, slots.empty, slots.empty_wait, @wake_version]
            end
            break if stop_requested?(version) || !run_errors.empty? || claim_error || !maintenance_errors.empty?
            break if !continuous && pass_ended

            if paused?
              break unless continuous

              @wake.wait(dispatch_wait(empty, listener))
              next
            end
            if empty_wait
              deadline, seen_version = empty_wait
              remaining = deadline - monotonic
              if remaining <= 0 || seen_version != wake_version
                @state_lock.synchronize { slots.empty_wait = nil if slots.empty_wait.equal?(empty_wait) }
              else
                @wake.wait(remaining)
              end
              next
            end
            if plan_claim(slots, claims)
              run_maintenance_if_due unless startup&.alive?
              while (plan, claim_version = reserve_claim(slots, claims))
                next_claim_id += 1
                claims[next_claim_id] = plan
                start_claim(next_claim_id, plan, claim_version, empty.positive?, version, results)
              end
            end
            next if claims.empty? && plan_claim(slots, claims)

            # A thread whose task already left @active returns to the executor at once, and no
            # wakeup follows its return, so dispatch rechecks shortly instead.
            returning = handlers.active_count > @active.size
            @wake.wait(returning ? THREAD_RETURN_WAIT : dispatch_wait(empty, listener))
          end
        ensure
          # Completions stop claiming with the loop. Tasks an in-flight claim returns hold leases,
          # so they run before the drain.
          @state_lock.synchronize { slots.open = false }
          settle.call(results.pop) until claims.empty?
        end
        raise slots.claim_error if slots.claim_error

        slots.claimed_any
      end

      # Records whether a returned plain claim made progress. The caller holds @state_lock.
      def settle_claim_progress(slots, claimed, claimed_version, error)
        if error
          slots.claim_error ||= error
        elsif claimed.any? { |task, _| handled?(task.type) }
          slots.empty = 0
          slots.claimed_any = true
          slots.empty_wait = nil
        else
          # A claim that only handed its tasks back made no progress, so it backs off as an
          # empty claim does instead of spinning on a task no handler here runs.
          slots.empty += 1
          slots.pass_ended = true
          slots.empty_wait ||= [monotonic + dispatch_wait(slots.empty, slots.listener), claimed_version]
        end
      end

      def plan_claim(slots, claims) = @state_lock.synchronize { claim_plan(slots, claims) }

      # Plans the next plain claim and reserves its slots under one lock, so a fused completion
      # cannot reserve the same free slots in between. Returns the plan and the wake version.
      def reserve_claim(slots, claims)
        @state_lock.synchronize do
          plan = claim_plan(slots, claims)
          next nil if plan.nil?

          limit, cohort, cohort_limit = plan
          slots.reserved += limit
          if cohort.nil?
            slots.whole_claims += 1
          else
            slots.cohort_claims[cohort] += 1
            slots.cohort_reserved[cohort] += cohort_limit
          end
          [plan, @wake_version]
        end
      end

      # Plans the next plain claim: its limit, its cohort, and its slots in that cohort. A slot is
      # free once its executor thread is ready again, not when its task leaves @active. The caller
      # holds @state_lock.
      def claim_plan(slots, claims)
        free = slots.free_slots
        return nil if free <= 0

        if @cohorts == 1 || !@full_tier_until.empty?
          return nil if !claims.empty? && free < slots.refill_batch

          return [free, nil, free]
        end
        return nil unless claims.empty?

        cohort = slots.roomiest_cohort
        cohort_limit = [free, slots.cohort_free(cohort)].min
        # A claim that still has to learn a queue's tier reserves every free slot, so a queue
        # that answers on the full tier fills them all.
        return (cohort_limit.positive? ? [cohort_limit, cohort, cohort_limit] : nil) if
          @queues.all? { |queue| @fast_tier_queues.include?(queue) }

        [free, cohort, [0, cohort_limit].max]
      end

      def notify
        @notified.make_true
        wake_dispatcher
      end

      # Wakes the run loop for a state change, which also ends an empty-poll wait.
      def wake_dispatcher
        @state_lock.synchronize { @wake_version += 1 }
        @wake.set
      end

      # Runs a claim reserve_claim already reserved slots for.
      def start_claim(id, plan, wake_version, backing_off, version, results)
        limit, cohort, cohort_limit = plan
        # The notification delay spreads idle workers one notification woke together. A worker
        # whose last claim found work would claim now anyway, so it skips the delay.
        delayed = @notified.make_false && backing_off
        thread = Thread.new do
          claimed = []
          error = nil
          begin
            sleep(rand(0.0..NOTIFICATION_CLAIM_DELAY)) if delayed
            # A worker paused or stopped during the delay sends no claim; settling frees the slots.
            withdrawn = delayed && (stop_requested?(version) || paused?)
            claim_across_queues(limit, claimed, cohort.nil? ? limit : cohort_limit) unless withdrawn
          rescue => e
            error = e
          ensure
            results << [id, wake_version, claimed, error]
            @wake.set
          end
        end
        thread.name = "workhorse-claim-#{id}"
      end

      # Claims from each queue at most once, starting one queue further on each call. Appends to
      # +claimed+ as each queue answers, so a later queue's error keeps the leases already taken.
      # Fast-tier queues together give at most +fast_limit+ tasks, the free slots of one cohort.
      def claim_across_queues(limit, claimed, fast_limit = limit)
        start = (@next_queue_index.increment - 1) % @queues.size
        @queues.size.times do |offset|
          break if claimed.size >= limit

          queue = @queues[(start + offset) % @queues.size]
          claimed.concat(claim(queue, limit - claimed.size, fast_limit - claimed.size))
        end
      end

      def claim(queue, limit, fast_limit)
        started_at = monotonic
        Telemetry.span("workhorse.claim", {"workhorse.queue.name" => queue}) do |span|
          rows = claim_queue(queue, limit, started_at, fast_limit)
          if rows.nil?
            Telemetry.set_attribute(span, "workhorse.queue.tier", "full")
            rows = @executor.rows(SqlCatalogue::CLAIM_MANY_V1, [queue, @worker_id, limit.to_s, @lease_ms.to_s])
            track_full_tier_claim(queue, rows) if rows.any?
          end
          tasks = rows.map { |row| ClaimedTask.from_row(row, queue) }
          record_claimed(queue, started_at, tasks)
          Telemetry.task_span_attributes(tasks.first).each { |key, value| Telemetry.set_attribute(span, key, value) } if tasks.any?
          tasks.map { |task| [task, started_at] }
        end
      end

      # Records a claim's duration and logs each task it returned.
      def record_claimed(queue, started_at, tasks)
        Telemetry.record("workhorse.claim.duration", (monotonic - started_at) * 1000,
          "workhorse.queue.name" => queue, "workhorse.claim.result" => tasks.empty? ? "empty" : "claimed")
        tasks.each do |task|
          Telemetry.add("workhorse.tasks.claimed", 1, Telemetry.task_metric_attributes(task))
          log(:debug, "workhorse.task.claimed", "Task claimed", Telemetry.task_span_attributes(task))
        end
      end

      # Claims through the fast tier, or returns nil when the queue is on the full tier. The fast
      # claim is complete_many_and_claim_v1 with no completions. A full-tier queue rejects it, and
      # the worker then claims that queue through claim_many_v1 until the next probe.
      def claim_queue(queue, limit, sent_at, fast_limit)
        return nil if @state_lock.synchronize { @full_tier_until.fetch(queue, -Float::INFINITY) > sent_at }

        fast_limit = [limit, fast_limit].min
        return [] if fast_limit <= 0

        begin
          rows = @executor.fenced_rows(SqlCatalogue::COMPLETE_MANY_AND_CLAIM_V1,
            [@worker_id, "{}", "{}", "{}", queue, fast_limit.to_s, @lease_ms.to_s])
        rescue FastTierUnsupportedError
          mark_full_tier(queue, sent_at)
          return nil
        end
        # A claim that finds nothing still returns one row, with every claim column null.
        claimed = rows.reject { |row| row["task_id"].nil? }
        @state_lock.synchronize do
          @full_tier_until.delete(queue)
          @fast_tier_queues.add(queue)
          claimed.each { |row| @fast_task_ids.add(row["task_id"]) }
        end
        claimed
      end

      # Claims a queue that rejected a fast-tier statement through claim_many_v1 until the probe.
      def mark_full_tier(queue, sent_at)
        @state_lock.synchronize do
          @full_tier_until[queue] = sent_at + TIER_PROBE_INTERVAL
          @fast_tier_queues.delete(queue)
        end
      end

      # Gives the tasks a claim_many_v1 call returned one shared, deferred tier read.
      # claim_many_v1 claims a fast-tier queue through fast_claim_v1, so a queue that moved to
      # the fast tier during the probe interval returns fast-tier tasks with no marker. The read
      # runs in a handler's first durable call, once the heartbeat renews the task's lease, and not
      # here, where a slow read would spend leases that nothing renews yet. The tier cannot change
      # while the queue has live tasks, so one read holds for every task of the claim.
      def track_full_tier_claim(queue, rows)
        read = deferred_tier_read(queue)
        @state_lock.synchronize { rows.each { |row| @tier_reads[row["task_id"]] = read } }
      end

      # Returns a callable that reads whether +queue+ is on the fast tier, once. A failed read is
      # not cached, so the next durable call retries it. A fast answer ends the probe interval.
      def deferred_tier_read(queue)
        lock = Mutex.new
        fast = nil
        lambda do
          lock.synchronize do
            if fast.nil?
              fast = queue_fast?(queue)
              if fast
                @state_lock.synchronize do
                  @full_tier_until.delete(queue)
                  @fast_tier_queues.add(queue)
                end
              end
            end
            fast
          end
        end
      end

      # Reads whether +queue+ is on the fast tier. A queue with no control row is on the full tier.
      def queue_fast?(queue)
        control = @executor.rows(SqlCatalogue::QUEUE_CONTROL, []).find { |row| row["queue_name"] == queue }
        !control.nil? && control["tier"] == "fast"
      end

      def fast_task?(task) = @state_lock.synchronize { @fast_task_ids.include?(task.id) }

      # The fast_tier argument for a task's HandlerContext: true for a task a fast-tier statement
      # claimed, the claim's deferred tier read for a task claim_many_v1 returned, and false otherwise.
      def context_tier(task)
        @state_lock.synchronize { @fast_task_ids.include?(task.id) || @tier_reads.fetch(task.id, false) }
      end

      # Completes a fast-tier attempt through the batched statement, and refills its slot.
      # Completions of one queue and cohort that arrive while its statement is in flight share the
      # next one. The statement also claims tasks into the slots dispatch set aside for it. A queue
      # that left the fast tier after the claim rejects that statement, so the attempt completes
      # through complete_v1 instead.
      def complete_fast_task(task, encoded)
        reservation = reserve_completion_claim(task)
        pending = PendingCompletion.new(task, encoded, reservation.limit, Concurrent::Event.new, false, [], false, nil, false)
        begin
          send_batched_completion(pending, [task.queue, reservation.cohort])
        ensure
          settle_completion_claim(task, reservation, pending.error ? nil : pending.claimed)
        end
        raise pending.error if pending.error
        return fenced_row(SqlCatalogue::COMPLETE_V1, task, encoded)["accepted"] == "t" if pending.full_tier

        pending.accepted
      end

      # Sets aside the slots a completion's fused claim may fill (ADR 0076, rules 12 and 13). The
      # claim asks for the free slots of the task's cohort plus the slot the task leaves. It claims
      # nothing while the worker stops, pauses, or waits after an empty claim, and it waits for the
      # cohort's refill batch while another claim for the cohort is in flight.
      def reserve_completion_claim(task)
        @state_lock.synchronize do
          slots = @dispatch_slots
          next CompletionClaim.new(0, 0, @wake_version) if slots.nil?

          cohort = slots.thread_cohorts.fetch(task.id, 0)
          idle = CompletionClaim.new(0, cohort, @wake_version)
          next idle if !slots.open || stop_requested?(slots.version) || !slots.run_errors.empty? || paused? ||
            slots.claim_error || slots.empty_wait

          # The slot this task leaves is free, but its thread is not until the handler returns.
          limit = [[slots.free_slots, slots.cohort_free(cohort)].min + 1, slots.thread_room].min
          claiming = slots.whole_claims.positive? || slots.cohort_claims[cohort].positive?
          next idle if limit <= 0 || (claiming && limit < slots.refill_batch)

          slots.reserved += limit
          slots.cohort_reserved[cohort] += limit
          slots.handed_over[task.id] = cohort
          slots.cohort_handed_over[cohort] += 1
          CompletionClaim.new(limit, cohort, @wake_version)
        end
      end

      # Releases a fused claim's reservation and starts the tasks it claimed in its cohort.
      # +claimed+ is nil when the completion failed.
      def settle_completion_claim(task, reservation, claimed)
        return if reservation.limit.zero?

        @state_lock.synchronize do
          slots = @dispatch_slots
          next if slots.nil?

          slots.reserved -= reservation.limit
          slots.cohort_reserved[reservation.cohort] -= reservation.limit
          # A claimed task took over this handler's slot. Without one, the slot stays this
          # handler's until it exits.
          if (claimed.nil? || claimed.empty?) && slots.handed_over.delete(task.id)
            slots.cohort_handed_over[reservation.cohort] -= 1
          end
          (claimed || []).each { |next_task, started_at| admit(slots, next_task, started_at, reservation.cohort) }
          if claimed&.any? { |next_task, _| handled?(next_task.type) }
            slots.claimed_any = true
            slots.empty = 0
          elsif claimed&.empty? && @queues.one?
            # The fused claim asks one queue only, so it proves that queue empty when this worker
            # has no other.
            slots.empty += 1
            slots.pass_ended = true
            slots.empty_wait ||= [monotonic + dispatch_wait(slots.empty, slots.listener), reservation.wake_version]
          end
        end
        @wake.set
      end

      # Sends a completion in the next statement of its batch key, and waits for its result. One
      # statement per key is in flight. The first completion sends its own at once. Those that
      # arrive meanwhile wait, and the first of them sends them all together when it returns.
      def send_batched_completion(pending, key)
        batch = @completion_lock.synchronize do
          waiting = @pending_completions[key]
          if waiting.nil?
            @pending_completions[key] = []
            [pending]
          else
            waiting << pending
            nil
          end
        end
        if batch.nil?
          pending.done.wait
          return unless pending.lead

          batch = @completion_lock.synchronize do
            waiting = @pending_completions[key]
            @pending_completions[key] = []
            waiting
          end
        end
        begin
          flush_completions(key.first, batch)
        ensure
          @completion_lock.synchronize do
            waiting = @pending_completions[key]
            if waiting.empty?
              @pending_completions.delete(key)
            else
              waiting.first.lead = true
              waiting.first.done.set
            end
          end
        end
      end

      # Completes a batch in statements within the protocol's array and claim limits. A failed
      # statement fails only the completions it carried.
      def flush_completions(queue, batch)
        start = 0
        while start < batch.size
          finish = start
          claim_limit = 0
          while finish < batch.size && finish - start < COMPLETION_BATCH_LIMIT &&
              claim_limit + batch[finish].limit <= COMPLETION_BATCH_LIMIT
            claim_limit += batch[finish].limit
            finish += 1
          end
          chunk = batch[start...finish]
          start = finish
          begin
            send_completion_chunk(queue, chunk, claim_limit)
          rescue Exception => e # rubocop:disable Lint/RescueException
            chunk.each { |member| member.error = e }
          ensure
            chunk.each { |member| member.done.set }
          end
        end
      end

      # Sends one complete_many_and_claim_v1 statement and answers every completion in it. The
      # chunk names its tasks in task ID order, as a heartbeat names its leases, so the two
      # statements lock shared runtime rows in the same order. A deadlock between the fused claim
      # and another worker's lease rolls the statement back with 40P01, and fenced_rows sends it
      # again.
      def send_completion_chunk(queue, chunk, claim_limit)
        chunk.sort_by! { |member| member.task.id }
        sent_at = monotonic
        begin
          rows = @executor.fenced_rows(SqlCatalogue::COMPLETE_MANY_AND_CLAIM_V1, [
            @worker_id,
            Values.text_array(chunk.map { |member| member.task.id }, "task ids"),
            Values.text_array(chunk.map { |member| member.task.fence_token.to_s }, "fence tokens"),
            Values.text_array(chunk.map(&:encoded), "results"),
            queue, claim_limit.to_s, @lease_ms.to_s
          ])
        rescue FastTierUnsupportedError
          mark_full_tier(queue, sent_at)
          chunk.each { |member| member.full_tier = true }
          return
        end
        # Only the first row carries the accepted completions. A statement that claims nothing
        # still returns that row, with every claim column null.
        accepted = Set.new(Values.parse_text_array(rows.first&.fetch("accepted", nil)) || [])
        claimed = rows.reject { |row| row["task_id"].nil? }.map { |row| ClaimedTask.from_row(row, queue) }
        @state_lock.synchronize do
          @full_tier_until.delete(queue)
          @fast_tier_queues.add(queue)
          claimed.each { |next_task| @fast_task_ids.add(next_task.id) }
        end
        record_claimed(queue, sent_at, claimed) if claim_limit.positive?
        # Claimed tasks go to the completions in order, each up to the slots it reserved.
        offset = 0
        chunk.each do |member|
          member.accepted = accepted.include?(member.task.id)
          member.claimed = (claimed[offset, member.limit] || []).map { |next_task| [next_task, sent_at] }
          offset += member.claimed.size
        end
      end

      # Runs handlers without queueing. A handler whose completion claimed tasks into its slot still
      # returns while they start, so the executor allows a second thread per slot. Every claim
      # also fits DispatchSlots#thread_room, so a post is never rejected.
      def handler_executor
        Concurrent::ThreadPoolExecutor.new(min_threads: @concurrency, max_threads: 2 * @concurrency, max_queue: 0,
          synchronous: true, fallback_policy: :abort)
      end

      def handled?(task_type) = @handlers.key?(task_type)

      # Gives a claimed task a slot and a handler thread. The caller holds @state_lock, so the slot
      # and the reservation it came from change together. The task joins +cohort+ while that
      # cohort has a free slot, and the roomiest cohort otherwise. A claimed task always runs, even
      # after stop or pause: its lease is already held.
      def admit(slots, task, started_at, cohort)
        # Dispatch assigns claim order here. A batch coordinator cannot read arrival order off its
        # own lock, because handler threads reach that lock in scheduler order, not claim order.
        @dispatch_order[task.id] = @dispatch_seq
        @dispatch_seq += 1
        cohort = slots.roomiest_cohort if cohort.nil? || slots.cohort_free(cohort) <= 0
        slots.cohort_active[cohort] += 1
        slots.thread_cohorts[task.id] = cohort
        active = Active.new(CancellationToken.new, Concurrent::AtomicReference.new, task)
        @active[task.id] = active
        slots.handlers.post { run_claimed_task(task, started_at, active, slots.run_errors) }
      rescue Exception # rubocop:disable Lint/RescueException
        # A task the executor refused never runs, so the drain must not wait for it.
        @active.delete(task.id)
        @dispatch_order.delete(task.id)
        slots.cohort_active[cohort] -= 1 if slots.thread_cohorts.delete(task.id)
        raise
      end

      def run_claimed_task(task, started_at, active, run_errors)
        execute(task, started_at, active)
      rescue LeaseLostError
        nil
      rescue Exception => e # rubocop:disable Lint/RescueException
        run_errors << e
        @stop_version.increment
      ensure
        @state_lock.synchronize do
          @dispatch_order.delete(task.id)
          @fast_task_ids.delete(task.id)
          @tier_reads.delete(task.id)
          slots = @dispatch_slots
          cohort = slots&.thread_cohorts&.delete(task.id)
          unless cohort.nil?
            slots.cohort_active[cohort] -= 1
            slots.cohort_handed_over[cohort] -= 1 if slots.handed_over.delete(task.id)
          end
        end
        @active.delete(task.id)
        @wake.set
      end

      # The wait before the next claim. A listening worker waits for a notification; a polling
      # worker backs off exponentially while claims come back empty.
      def dispatch_wait(empty, listener)
        milliseconds = if listener&.listening?
          @notification_poll_ms
        else
          [MAX_EMPTY_POLL_MS, @poll_ms * (2**[0, empty - 1].max)].min
        end
        milliseconds = [1, (milliseconds * rand(0.9..1.1)).round].max
        milliseconds = [milliseconds, @registry_ms].min if @registry_ms.positive?
        milliseconds / 1000.0
      end

      # Waits up to the shutdown grace, cancels what still runs, and gives it one unwind window.
      # Returns the number of handlers abandoned after that window.
      def drain(handlers)
        # A lingering batch cannot grow once claims stop, so it runs as soon as its members arrive.
        @batch_coordinators.each_value(&:flush!)
        deadline = monotonic + @shutdown_grace
        wait_until_idle(deadline)
        remaining = @active.values
        unless remaining.empty?
          remaining.each { |active| active.cancellation.cancel(:shutdown) }
          wait_until_idle(monotonic + UNWIND_WINDOW)
        end
        abandoned = @active.values
        abandoned.each { |active| active.ownership.get&.abandon }
        handlers.shutdown
        abandoned.size
      end

      def wait_until_idle(deadline)
        loop do
          return if @active.empty?

          remaining = deadline - monotonic
          return if remaining <= 0

          @wake.reset
          next if @active.empty?

          @wake.wait([remaining, 0.05].min)
        end
      end

      # --- Registration and maintenance -------------------------------------------------------

      def refresh_registration(force: false)
        return if @registry_ms.zero?

        now = monotonic
        return if !force && now - @last_registry_at < @registry_ms / 1000.0

        @last_registry_at = now
        active = @active.size
        begin
          rows = @executor.rows(SqlCatalogue::REGISTER_WORKER_V1, [
            @worker_id, @instance_id, Socket.gethostname, Process.pid.to_s, Values.text_array(@queues, "queues"),
            Values.text_array(@schedule_namespaces, "schedule_namespaces"), @concurrency.to_s, @lease_ms.to_s,
            @heartbeat_ms.to_s, @poll_ms.to_s, @maintenance_ms.to_s, @routine_ms.to_s, @registry_ms.to_s,
            active.to_s, @draining.to_s, PROTOCOL, LANGUAGE, VERSION
          ])
        rescue => e
          log(:info, "workhorse.worker.registration_failed", "Worker registration failed",
            "error.type" => e.class.name)
          @on_registration_error&.call(e)
          return
        end
        paused = rows.first&.fetch("paused", nil) == "t"
        changed = paused ? @remotely_paused.make_true : @remotely_paused.make_false
        @registered.make_true
        log(:debug, "workhorse.worker.registered", "Worker registration refreshed",
          "workhorse.worker.active_slots" => active, "workhorse.worker.draining" => @draining,
          "workhorse.worker.paused" => paused)
        return unless changed

        if paused
          log(:info, "workhorse.worker.paused", "Worker paused remotely")
        else
          log(:info, "workhorse.worker.resumed", "Worker resumed remotely")
        end
        wake_dispatcher
      end

      def deregister
        return unless @registered.make_false

        @executor.rows(SqlCatalogue::DEREGISTER_WORKER_V1, [@worker_id])
      rescue
        nil
      end

      # Runs one maintenance pass when its interval elapsed. Returns whether it ran. The interval
      # restarts only after a pass succeeds, so a failed pass runs again on the next dispatch.
      def run_maintenance_if_due
        now = monotonic
        return false if now - @last_maintenance_at.get < @maintenance_ms / 1000.0

        Telemetry.span("workhorse.maintenance", {"workhorse.maintenance.operation" => "tick"}) do |span|
          total = 0
          Telemetry.span("workhorse.recovery", {}) do |recovery|
            @executor.rows(SqlCatalogue::TICK_V1, ["100", "100"]).each do |row|
              total += record_maintenance(row, recovery, log: true)
            end
            if now - @last_routine_at >= @routine_ms / 1000.0
              @last_routine_at = now
              @executor.rows(SqlCatalogue::RUN_MAINTENANCE_V1, [Values.timestamp(Time.now, "now")]).each do |row|
                total += record_maintenance(row, nil, log: false)
              end
            end
          end
          Telemetry.set_attribute(span, "workhorse.maintenance.rows_affected", total)
        end
        @last_maintenance_at.set(now)
        fire_schedules unless @schedule_namespaces.empty?
        true
      end

      # Records one maintenance phase row and returns its affected row count. Only tick rows log.
      def record_maintenance(row, recovery, log:)
        phase = row["phase"]
        rows = Values.parse_integer(row["rows_affected"]) || 0
        skipped = row["skipped_lock"] == "t"
        error = !row["error"].nil?
        attributes = {"workhorse.maintenance.loop" => "tick", "workhorse.maintenance.phase" => phase,
                      "workhorse.maintenance.skipped_lock" => skipped}
        Telemetry.add("workhorse.maintenance.runs", 1, attributes)
        Telemetry.add("workhorse.maintenance.rows", rows, attributes)
        Telemetry.record("workhorse.maintenance.duration", row["duration_ms"].to_f, attributes)
        Telemetry.add("workhorse.maintenance.errors", 1, attributes) if error
        return rows unless log

        record_recovery(row, rows, skipped, error, recovery) if phase == "recover"
        if rows.positive? || error
          details = {"workhorse.maintenance.operation" => "tick", "workhorse.maintenance.phase" => phase,
                     "workhorse.maintenance.rows_affected" => rows, "workhorse.maintenance.skipped_lock" => skipped}
          details["error.type"] = "PostgreSQLError" if error
          log(:info, "workhorse.maintenance.completed", "Maintenance phase completed", details)
        end
        rows
      end

      def record_recovery(row, rows, skipped, error, span)
        Telemetry.set_attribute(span, "workhorse.recovery.skipped", skipped)
        expired = Values.parse_integer(row["expired_leases"]) || 0
        retried = Values.parse_integer(row["retried"]) || 0
        unless skipped || error
          Telemetry.set_attribute(span, "workhorse.recovery.rows_affected", rows)
          Telemetry.set_attribute(span, "workhorse.recovery.expired_leases", expired)
          Telemetry.set_attribute(span, "workhorse.recovery.retried", retried)
          Telemetry.add("workhorse.leases.expired", expired) if expired.positive?
          record_retries(retried, Values.parse_json(row["retry_dimensions"]))
        end
        return unless rows.positive?

        log(:info, "workhorse.leases.recovered", "Expired leases recovered",
          "workhorse.recovery.rows_affected" => rows, "workhorse.recovery.expired_leases" => expired,
          "workhorse.recovery.retried" => retried)
      end

      # Counts each retried task by queue and type. Retries without both count as unknown.
      def record_retries(retried, dimensions)
        attributed = 0
        if dimensions.is_a?(Array)
          dimensions.filter_map do |dimension|
            next unless dimension.is_a?(Hash) && dimension["queue"].is_a?(String) && dimension["type"].is_a?(String)

            [dimension["queue"], dimension["type"]]
          end.tally.each do |(queue, type), count|
            attributed += count
            Telemetry.add("workhorse.tasks.retried", count, "workhorse.queue.name" => queue, "workhorse.task.type" => type)
          end
        end
        return unless retried > attributed

        Telemetry.add("workhorse.tasks.retried", retried - attributed,
          "workhorse.queue.name" => "unknown", "workhorse.task.type" => "unknown")
      end

      def fire_schedules
        now = Time.now
        rows = @executor.rows(SqlCatalogue::FIRE_DUE_SCHEDULES_V2, [
          Values.text_array(@schedule_namespaces, "schedule_namespaces"), nil, @schedule_catchup_limit.to_s,
          @maintenance_ms.to_s
        ])
        rows.each do |row|
          attributes = {"workhorse.schedule.namespace" => row["namespace"], "workhorse.schedule.name" => row["schedule_name"]}
          if row["task_id"].nil?
            log(:debug, "workhorse.schedule.fire_replayed", "Recurring schedule occurrence replayed", attributes)
            next
          end
          Telemetry.add("workhorse.schedule.fired", 1, attributes)
          occurrence = Values.parse_time(row["occurrence_at"])
          Telemetry.record("workhorse.schedule.lag", now - occurrence, attributes) if occurrence
          log(:info, "workhorse.schedule.fired", "Recurring schedule fired",
            attributes.merge("workhorse.task.id" => row["task_id"]))
        end
      end

      # --- Execution --------------------------------------------------------------------------

      def execute(task, claim_started_at, active)
        handler = @handlers[task.type]
        arbiter = Arbiter.new
        state = {span_outcome: nil, errors: []}
        started_at = monotonic
        attributes = {"workhorse.queue.name" => task.queue}.merge(Telemetry.task_span_attributes(task))
        Telemetry.span("workhorse.handler", attributes, trace_context: task.trace_context, consumer: true) do |span|
          log(:debug, "workhorse.handler.started", "Task handler started", attributes)
          begin
            if handler.nil?
              state[:span_outcome] = release(task, arbiter, attributes)
            else
              run_handler(task, handler, claim_started_at, active, arbiter, state)
            end
          rescue Exception => e # rubocop:disable Lint/RescueException
            Telemetry.record_error(span, e.class.name)
            raise
          ensure
            finish_telemetry(task, span, arbiter, state, started_at, attributes)
          end
        end
      end

      def finish_telemetry(task, span, arbiter, state, started_at, attributes)
        duration = (monotonic - started_at) * 1000
        outcome = TELEMETRY_OUTCOMES.fetch(arbiter.reported_outcome, "unknown")
        Telemetry.set_attribute(span, "workhorse.handler.outcome",
          state[:span_outcome] || SPAN_OUTCOMES.fetch(arbiter.reported_outcome, "unknown"))
        Telemetry.record_error(span, state[:errors].first) unless state[:errors].empty?
        metric = Telemetry.task_metric_attributes(task)
        Telemetry.record("workhorse.handler.duration", duration, metric.merge("workhorse.handler.outcome" => outcome))
        Telemetry.add("workhorse.handler.runtime", duration, metric)
        Telemetry.add("workhorse.handler.executions", 1, metric.merge("workhorse.handler.outcome" => outcome))
        log(:debug, "workhorse.handler.finished", "Task handler finished",
          attributes.merge("workhorse.handler.duration_ms" => duration))
        log(:info, "workhorse.task.execution_finished", "Task execution finished",
          attributes.merge("workhorse.handler.outcome" => outcome))
      end

      # Hands a task with no handler back to PostgreSQL, which makes it claimable again without
      # charging the attempt. Returns the release status for the handler span.
      def release(task, arbiter, attributes)
        log(:warn, "workhorse.handler.missing", "No handler registered for the claimed task type", attributes)
        status = fenced_row(SqlCatalogue::RELEASE_OWNED_V1, task)["status"]
        log(:info, "workhorse.task.release_processed", "Owned task release processed",
          attributes.merge("workhorse.release.status" => status))
        if status == "released"
          arbiter.submit(:released)
        else
          settle_status(task, status, arbiter, "release", ["not_due"], :lease_expired)
        end
        status
      end

      def run_handler(task, handler, claim_started_at, active, arbiter, state)
        cancellation = active.cancellation
        ownership = Ownership.new(claim_started_at, @lease_ms / 1000.0)
        own(task, ownership, arbiter, cancellation)
        active.ownership.set(ownership)
        context = HandlerContext.new(executor: @executor, queue: @queue, task: task, worker_id: @worker_id,
          cancellation: cancellation, arbiter: arbiter, logger: @logger, fast_tier: context_tier(task))
        begin
          result = invoke(handler, task.payload, context)
          validate_result(task, result)
          encoded = Values.json(result, "task result")
        rescue HandlerContext::Suspension
          return if finish_ownership(task, ownership, arbiter)

          raise Error, "Durable wait suspension was not accepted by the arbiter"
        rescue => e
          return if finish_suspended(task, ownership, arbiter)

          state[:span_outcome] = settle_failure(task, e, arbiter)
          state[:errors] << (task.redact_error_details ? REDACTED_NAME : e.class.name)
          return
        ensure
          ownership.release
        end
        return if finish_suspended(task, ownership, arbiter)

        complete(task, encoded, arbiter)
      end

      # Runs a handler inside the Rails executor when Rails is loaded, so code reloading and Active
      # Record connection release behave as they do in a request.
      def invoke(handler, payload, context)
        executor = rails_executor
        return handler.call(payload, context) if executor.nil?

        executor.wrap { handler.call(payload, context) }
      end

      def rails_executor
        return unless defined?(::Rails) && ::Rails.respond_to?(:application)

        ::Rails.application&.executor
      end

      # Handlers that use Active Record wait for its connections, so a pool smaller than
      # +concurrency+ leaves slots idle. A worker without a logger warns on standard error.
      def warn_small_active_record_pool
        return unless defined?(::ActiveRecord::Base)

        size = begin
          ::ActiveRecord::Base.connection_pool.size
        rescue ::ActiveRecord::ActiveRecordError
          return
        end
        return if size >= @concurrency

        body = "Active Record pool size #{size} is smaller than worker concurrency #{@concurrency}"
        if @logger.nil?
          Kernel.warn("workhorse: #{body}")
        else
          log(:warn, "workhorse.worker.active_record_pool_too_small", body,
            "workhorse.worker.concurrency" => @concurrency, "workhorse.active_record.pool_size" => size)
        end
      end

      def complete(task, encoded, arbiter)
        accepted = Telemetry.span("workhorse.complete", Telemetry.task_span_attributes(task)) do |span|
          accepted = if fast_task?(task)
            complete_fast_task(task, encoded)
          else
            fenced_row(SqlCatalogue::COMPLETE_V1, task, encoded)["accepted"] == "t"
          end
          Telemetry.set_attribute(span, "workhorse.complete.accepted", accepted)
          attributes = Telemetry.task_span_attributes(task).merge("workhorse.complete.accepted" => accepted)
          if accepted
            log(:info, "workhorse.task.completed", "Task completed", attributes)
          else
            log(:info, "workhorse.task.completion_rejected", "Stale task completion rejected", attributes)
          end
          accepted
        end
        unless accepted
          return arbiter.submit(:cancelled) if acknowledge_cancel(task)

          arbiter.submit(:lease_expired)
          raise LeaseLostError.new(task.id, "complete")
        end
        Telemetry.add("workhorse.tasks.completed", 1, Telemetry.task_metric_attributes(task))
        arbiter.submit(:completed)
      end

      # Registers the attempt with the heartbeat and starts its lease watchdog. The watchdog's
      # retry span keeps the handler span as its parent.
      def own(task, ownership, arbiter, cancellation)
        parent = Telemetry.current_context
        fail_attempt = lambda do |error|
          ownership.errors << error
          cancellation.cancel(:lease_lost)
        end
        member = Heartbeat::Member.new(
          worker_id: @worker_id, task: task, lease_ms: @lease_ms, interval: @heartbeat_ms / 1000.0,
          renew: ->(sent_at) { ownership.renew(sent_at) },
          settle: lambda do |status|
            ownership.settlement.synchronize do
              if %w[deadline_exceeded timeout_exceeded].include?(status)
                settle_expiration(task, arbiter, cancellation, parent)
              else
                deliver_status(task, status, arbiter, cancellation)
              end
            end
          end,
          fail: fail_attempt,
          logger: @logger
        )
        unregister = @heartbeat.register(member)
        watchdog = Thread.new { watch_expiration(task, ownership, arbiter, cancellation, parent, fail_attempt) }
        watchdog.name = "workhorse-expiration-#{task.id}"
        ownership.start(unregister, watchdog)
      end

      # Ends an attempt locally when its lease lapses unrenewed, and asks PostgreSQL to settle a
      # deadline or an attempt timeout when one passes.
      def watch_expiration(task, ownership, arbiter, cancellation, parent, fail_attempt)
        expiration_at = [task.deadline_at, task.attempt_timeout_at].compact.min
        retry_at = nil
        loop do
          delay = if retry_at
            retry_at - monotonic
          elsif expiration_at
            expiration_at - Time.now
          end
          lease_delay = ownership.lease_deadline - monotonic
          if delay.nil? || lease_delay < delay
            if lease_delay.positive?
              return if ownership.stop.wait(lease_delay)

              next
            end
            arbiter.submit(:lease_expired)
            ownership.abandon
            cancellation.cancel(:lease_lost)
            return
          end
          return if ownership.stop.wait([0, delay].max)

          status = ownership.settlement.synchronize { settle_expiration(task, arbiter, cancellation, parent) }
          return unless status == "not_due"

          retry_at = monotonic + EXPIRATION_RETRY
        end
      rescue => e
        fail_attempt.call(e)
      end

      def settle_expiration(task, arbiter, cancellation, parent)
        row = fenced_row(SqlCatalogue::EXPIRE_OWNED_TELEMETRY_V1, task)
        status = row["status"]
        return status if status == "not_due"

        unless row["retry_state"].nil?
          Telemetry.span("workhorse.retry", Telemetry.task_span_attributes(task), parent: parent) do |span|
            Telemetry.set_attribute(span, "workhorse.retry.outcome", row["retry_state"])
          end
          Telemetry.add("workhorse.tasks.retried", 1, Telemetry.task_metric_attributes(task))
        end
        log(:info, "workhorse.task.ownership_expired", "Owned task lease expired",
          Telemetry.task_span_attributes(task).merge("workhorse.expiration.status" => status))
        deliver_status(task, status, arbiter, cancellation)
        status
      end

      # Submits the outcome a heartbeat or expiration status names and cancels the handler.
      # Returns false for +accepted+.
      def deliver_status(task, status, arbiter, cancellation)
        outcome = outcome_for_status(status, ["accepted"], "heartbeat")
        return false if outcome.nil?

        arbiter.submit(outcome)
        cancellation.cancel(CANCEL_REASONS.fetch(outcome, :lease_lost))
        true
      end

      def outcome_for_status(status, neutral, operation)
        raise UnexpectedStatusError.new(operation, status) unless status.is_a?(String)
        return nil if neutral.include?(status)

        STATUS_OUTCOMES.fetch(status) { raise UnexpectedStatusError.new(operation, status) }
      end

      # Submits the outcome for a status the worker's own write returned. A cancel request is
      # acknowledged; a lost lease raises LeaseLostError. A neutral status submits +neutral_outcome+.
      def settle_status(task, status, arbiter, operation, neutral, neutral_outcome)
        outcome = outcome_for_status(status, neutral, operation)
        case outcome
        when nil then return arbiter.submit(neutral_outcome)
        when :cancelled then raise LeaseLostError.new(task.id, operation) unless acknowledge_cancel(task)
        when :lease_expired
          arbiter.submit(:lease_expired)
          raise LeaseLostError.new(task.id, operation)
        end
        arbiter.submit(outcome)
      end

      # Stops renewing and reports whether the arbiter already decided the attempt. Raises the
      # heartbeat's error when it failed and nothing decided the attempt.
      def finish_ownership(task, ownership, arbiter)
        ownership.release
        return true if finish_lifecycle(task, arbiter)
        raise ownership.errors.first unless ownership.errors.empty?

        false
      end

      # Like finish_ownership, for a handler that returned or raised an error. A handler that did
      # either after a durable call suspended it swallowed the suspension; the attempt still
      # suspends, and the worker logs a warning.
      def finish_suspended(task, ownership, arbiter)
        return false unless finish_ownership(task, ownership, arbiter)

        if arbiter.suspended?
          log(:warn, "workhorse.handler.signal_swallowed", "Task handler swallowed its suspension signal",
            {"workhorse.queue.name" => task.queue}.merge(Telemetry.task_span_attributes(task),
              "workhorse.handler.outcome" => "suspended"))
        end
        true
      end

      # A task that a durable write released needs nothing more from the worker, whichever outcome won.
      def finish_lifecycle(task, arbiter)
        return true if arbiter.released?

        case arbiter.outcome
        when :suspended_for_wait, :suspended_for_child, :deadline_exceeded, :attempt_timeout then true
        when :cancelled
          raise LeaseLostError.new(task.id, "cancel") unless acknowledge_cancel(task)

          true
        when :lease_expired then raise LeaseLostError.new(task.id, "heartbeat")
        else false
        end
      end

      def acknowledge_cancel(task)
        accepted = fenced_row(SqlCatalogue::ACKNOWLEDGE_CANCEL_V1, task)["accepted"] == "t"
        log(:info, "workhorse.task.cancellation_acknowledged", "Task cancellation acknowledged",
          Telemetry.task_span_attributes(task).merge("workhorse.cancel.accepted" => accepted))
        accepted
      end

      # Records a handler failure. PostgreSQL retries or fails the task by its retry policy.
      # Returns the state PostgreSQL chose, for the handler span.
      def settle_failure(task, error, arbiter)
        envelope = error_envelope(error, task.redact_error_details)
        state = Telemetry.span("workhorse.retry", Telemetry.task_span_attributes(task)) do |span|
          delay = retry_delay_override(task)
          state = fenced_row(SqlCatalogue::FAIL_V1, task, JSON.generate(envelope), delay&.to_s)["state"]
          Telemetry.set_attribute(span, "workhorse.retry.outcome", state.to_s)
          state
        end
        retried = %w[ready scheduled].include?(state)
        Telemetry.add("workhorse.tasks.failed", 1,
          Telemetry.task_metric_attributes(task).merge("workhorse.attempt.outcome" => state))
        Telemetry.add("workhorse.tasks.retried", 1, Telemetry.task_metric_attributes(task)) if retried
        log(:info, "workhorse.task.failure_processed", "Task attempt failure processed",
          Telemetry.task_span_attributes(task).merge("workhorse.attempt.outcome" => state))
        if retried
          arbiter.submit(:retry)
        else
          settle_status(task, state, arbiter, "fail", %w[failed], :failed)
        end
        state
      end

      def retry_delay_override(task)
        delay = @retry_delay.respond_to?(:call) ? @retry_delay.call(task.attempt, task) : @retry_delay
        return nil if delay.nil?

        Values.milliseconds(delay, "retry_delay", 0..2_147_483_647)
      end

      def error_envelope(error, redact)
        return {"name" => REDACTED_NAME, "message" => REDACTED_MESSAGE} if redact

        {"name" => error.class.name, "message" => error.message.to_s,
         "stack" => error.full_message(highlight: false, order: :top)}
      end

      def validate_result(task, result)
        version = task.contract_version
        return if version.nil?

        schema = @contracts[[task.type, version]]
        if schema.nil?
          rows = @executor.rows(SqlCatalogue::GET_CONTRACT_DEFINITION_V1, [task.type, version])
          raise ContractUnavailableError.new(task.type, version) unless rows.one?

          document = Values.parse_json(rows.first["schema"])
          raise ContractUnavailableError.new(task.type, version) unless document.is_a?(Hash) && document.key?("result")

          schema = ContractSchema.new(document["result"])
          @contracts[[task.type, version]] = schema
        end
        raise ContractValidationError.new(task.type, version, "result") unless schema.valid?(result)
      end

      # A lifecycle write returns exactly one row; anything else means the protocol changed.
      def fenced_row(sql, task, *arguments)
        rows = fenced(sql, task, *arguments)
        raise Error, "PostgreSQL lifecycle transition did not return exactly one row" unless rows.one?

        rows.first
      end

      def fenced(sql, task, *arguments)
        @executor.fenced_rows(sql, [task.id, @worker_id, task.fence_token.to_s, *arguments])
      end
    end
  end
end
