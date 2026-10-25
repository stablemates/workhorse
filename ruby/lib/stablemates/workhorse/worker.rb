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
    # Durations are Numeric seconds. +heartbeat+ defaults to a third of +lease+, at least 0.1. The
    # smallest supported +heartbeat+ is 0.1. The worker accepts a shorter value, but on a loaded
    # host it can renew no lease.
    #
    # Unless +shared_heartbeats+ is set, each run first reserves the heartbeat connection that the
    # workers on the pool share, and then borrows one other connection for the compatibility query.
    # Both steps must end within max(+heartbeat+, 5 s), or the run raises WorkerStartupError. The
    # worker claims nothing while the pool has no usable heartbeat connection.
    #
    # +run+ blocks until +stop+; +run_once+ claims and runs one batch. A stopping worker claims
    # nothing new, waits up to +shutdown_grace+ for running handlers, cancels the rest with
    # +:shutdown+, and raises ShutdownIncompleteError when any handler still runs after one short
    # unwind window. A handler that raises the CancelledError of that cancellation, as +check!+
    # does, returns its task to the queue without charging the attempt.
    class Worker
      MAX_EMPTY_POLL_MS = 5_000
      NOTIFICATION_POLL_MS = 5_000
      NOTIFICATION_CLAIM_DELAY = 0.05
      UNWIND_WINDOW = 0.25
      THREAD_RETURN_WAIT = 0.001
      EXPIRATION_RETRY = 0.005
      EXPIRATION_RETRY_MAX = 1.0
      REDACTED_NAME = "RedactedTaskError"
      REDACTED_MESSAGE = "Task handler failed; details redacted"
      PROTOCOL = "5"
      LANGUAGE = "ruby"
      MIN_POOL_SIZE = 3
      # The shortest startup budget in seconds. The budget is the heartbeat interval, and at least
      # this. A startup owns no lease, so a short interval alone would refuse a slow pool.
      STARTUP_BUDGET_FLOOR = 5
      # The longest wait, in seconds, before a startup that waits for its heartbeat connection, or for
      # a stop statement of the previous run, checks for a stop again.
      STARTUP_STOP_CHECK = 0.05
      COMPLETION_BATCH_LIMIT = 100
      TIER_PROBE_INTERVAL = 30
      # Maintenance writes shared due times and retention cutoffs, so the database clock chooses its
      # time. PostgreSQL resolves this timestamptz input at the start of the autocommit statement.
      DATABASE_NOW = "now"
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
      # An exponent follows a digit in every JSON number that has one. A string can match too, which
      # costs only an exact measure.
      EXPONENT_NUMBER = /\d[eE]/
      # Every \u escape jsonb refuses is \u0000 or a surrogate, and every surrogate escape starts
      # with \ud or \uD. JSON.generate writes non-ASCII text raw, so ordinary text matches neither.
      UNSTORABLE_ESCAPE_START = /\\u(?:0000|[dD])/
      JSON_ESCAPE = /\\(?:u(\h{4})|.)/m
      private_constant :MAX_EMPTY_POLL_MS, :NOTIFICATION_POLL_MS, :NOTIFICATION_CLAIM_DELAY, :UNWIND_WINDOW,
        :THREAD_RETURN_WAIT, :EXPIRATION_RETRY, :EXPIRATION_RETRY_MAX, :REDACTED_NAME, :REDACTED_MESSAGE, :PROTOCOL, :LANGUAGE, :MIN_POOL_SIZE,
        :STARTUP_BUDGET_FLOOR, :STARTUP_STOP_CHECK, :COMPLETION_BATCH_LIMIT, :TIER_PROBE_INTERVAL, :DATABASE_NOW,
        :STATUS_OUTCOMES, :TELEMETRY_OUTCOMES, :SPAN_OUTCOMES, :CANCEL_REASONS, :EXPONENT_NUMBER,
        :UNSTORABLE_ESCAPE_START, :JSON_ESCAPE

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

        # Moves the local lease window to start at +sent_at+, and returns true. If the window has
        # already ended, it stays closed and this returns false: a late accepted heartbeat cannot
        # reopen it. The check and the move hold the lock that +lease_remaining+ holds, so they
        # cannot race the watchdog.
        def renew(sent_at)
          @renewal.synchronize do
            return false unless Process.clock_gettime(Process::CLOCK_MONOTONIC) < @renewed_at + @lease_seconds

            @renewed_at = [@renewed_at, sent_at].max
            true
          end
        end

        def lease_deadline = @renewal.synchronize { @renewed_at + @lease_seconds }

        # The seconds until the local lease window ends, zero or less once it has ended.
        def lease_remaining
          @renewal.synchronize { @renewed_at + @lease_seconds - Process.clock_gettime(Process::CLOCK_MONOTONIC) }
        end

        def start(unregister, watchdog)
          @unregister = unregister
          @watchdog = watchdog
        end

        # Stops renewing without waiting for the watchdog. A shutdown abandons with this.
        def abandon
          @unregister&.call
          @stop.set
        end

        # Whether the attempt stopped renewing because its handler finished.
        def released? = @released.true?

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
        attr_reader :concurrency, :refill_batch, :cohort_capacity, :listener, :version, :run_errors, :handlers, :gate,
          :cohort_active, :cohort_handed_over, :cohort_reserved, :cohort_claims, :handed_over, :thread_cohorts
        attr_accessor :whole_claims, :reserved, :empty, :empty_wait, :pass_ended, :claimed_any, :claim_error, :open,
          :listened_at_last_wait, :fairness_skip_pending

        def initialize(concurrency, cohorts, listener, version, run_errors, handlers, gate)
          @concurrency = concurrency
          # The claim gate of this run. Every claim and fused completion of the run reads it.
          @gate = gate
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
          # Whether the last chosen wait had a live subscription. The backoff restarts after a loss.
          @listened_at_last_wait = false
          @empty_wait = nil
          @pass_ended = false
          @claimed_any = false
          @claim_error = nil
          @open = true
          # Set when a completion skipped its fused refill so that a plain claim can ask the other
          # queues. The next plain claim clears it, so only one completion at a time gives up its refill.
          @fairness_skip_pending = false
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

      # The fused claim one fast-tier completion reserved: its limit, its cohort, the wake version
      # when it reserved, and the claim gate of its run. A zero limit reserves nothing.
      CompletionClaim = Struct.new(:limit, :cohort, :wake_version, :gate) # :nodoc:
      private_constant :CompletionClaim

      # One completion waiting for a batched complete_many_and_claim_v1 statement. The statement's
      # sender fills +accepted+, +claimed+, +full_tier+, or +error+ and sets +done+. +lead+ makes a
      # waiting completion the sender of the next statement.
      PendingCompletion = Struct.new(:task, :encoded, :limit, :done, :accepted, :claimed, :full_tier, :error, :lead,
        :gate) # :nodoc:
      private_constant :PendingCompletion

      # The claim gate of a run under shared_heartbeats, which never closes. A run with the
      # dedicated heartbeat connection uses its Heartbeat::Reservation as its gate.
      OPEN_GATE = Object.new.tap do |gate|
        gate.define_singleton_method(:ready?) { true }
        gate.define_singleton_method(:enter) { true }
        gate.define_singleton_method(:leave) { nil }
      end.freeze
      # The gate of a fused completion that no running dispatch admitted.
      CLOSED_GATE = Object.new.tap do |gate|
        gate.define_singleton_method(:ready?) { false }
        gate.define_singleton_method(:enter) { false }
        gate.define_singleton_method(:leave) { nil }
      end.freeze
      private_constant :OPEN_GATE, :CLOSED_GATE

      # Raised before a claim statement when the claim gate is closed at send time. The claim sends
      # nothing.
      class ClaimWithdrawn < StandardError; end
      private_constant :ClaimWithdrawn

      # The one connection the readiness check borrowed, as an executor source.
      Borrowed = Struct.new(:connection) do # :nodoc:
        def with = yield(connection)
      end
      private_constant :Borrowed

      RETRY_DELAY_RANGE = (0..2_147_483_647)
      RETRY_DELAY_REFUSAL = "retry_delay must be a finite Numeric count of seconds between 0 and 2147483.647"
      private_constant :RETRY_DELAY_RANGE, :RETRY_DELAY_REFUSAL

      # register_worker_v1 takes each maintenance, routine, and registry interval as a PostgreSQL
      # integer, and its check refuses a value below 100 ms. Every SDK accepts this range (ADR 0112).
      INTERVAL_RANGE = (100..2_147_483_647)
      private_constant :INTERVAL_RANGE

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
        @cohorts = dispatch_cohorts(cohorts, pool, shared_heartbeats, polling_only)
        @worker_id = worker_id || "#{Socket.gethostname}-#{Process.pid}-#{SecureRandom.hex(4)}"
        raise ArgumentError, "worker_id must be a non-empty String" unless @worker_id.is_a?(String) && !@worker_id.empty?

        @lease_ms = Values.milliseconds(lease, "lease", 100..86_400_000)
        @heartbeat_ms = heartbeat.nil? ? [100, @lease_ms / 3].max : Values.milliseconds(heartbeat, "heartbeat", 1..)
        raise ArgumentError, "heartbeat must be positive and less than lease" unless @heartbeat_ms < @lease_ms

        # Every SDK accepts an explicit poll interval from 1 through 2147483647 ms (ADR 0112).
        @poll_ms = poll_interval.nil? ? 250 : Values.milliseconds(poll_interval, "poll_interval", 1..2_147_483_647)
        @notification_poll_ms = poll_interval.nil? ? NOTIFICATION_POLL_MS : @poll_ms
        @polling_only = polling_only ? true : false
        @maintenance_ms = Values.milliseconds(maintenance_interval, "maintenance_interval", INTERVAL_RANGE)
        @routine_ms = Values.milliseconds(maintenance_routine_interval, "maintenance_routine_interval", INTERVAL_RANGE)
        @registry_ms = disable_registry ? 0 : Values.milliseconds(registry_interval, "registry_interval", INTERVAL_RANGE)
        @schedule_namespaces = unique_names(schedule_namespaces, "schedule_namespaces")
        raise ArgumentError, "schedule_catchup_limit must be an Integer between 1 and 10000" unless
          schedule_catchup_limit.is_a?(Integer) && schedule_catchup_limit.between?(1, 10_000)

        @schedule_catchup_limit = schedule_catchup_limit
        @shutdown_grace = Values.milliseconds(shutdown_grace, "shutdown_grace", 0..86_400_000) / 1000.0
        # Warns once when a maintenance pass or a claim waits longer than the stop budget.
        @statement_watch = StatementWatch.new(@shutdown_grace) do |statement, elapsed_ms|
          log(:warn, "workhorse.worker.statement_slow", "Worker statement is still waiting after the stop budget",
            "workhorse.worker.statement" => statement, "workhorse.worker.elapsed_ms" => elapsed_ms)
        end
        retry_delay_milliseconds(retry_delay) unless retry_delay.nil? || retry_delay.respond_to?(:call)
        @retry_delay = retry_delay
        @on_registration_error = on_registration_error
        @on_notification_error = on_notification_error
        @reporter_failures = {}
        @reporter_failures_lock = Mutex.new
        @logger = logger
        @queue = Queue.new(@executor, default_queue: @queues.first)
        @heartbeat = shared_heartbeats ? Heartbeat.new(@executor, dedicated: false) : Heartbeat.dedicated(pool)
        @shared_heartbeats = shared_heartbeats ? true : false
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
        # The monotonic time when a claim last asked each queue for tasks, plain or fused. A worker
        # with more than one queue reads it so a fused refill cannot keep the other queues from a
        # claim (ADR 0076, rule 17). The interval is the poll interval, 250 ms by default.
        @queue_asked_at = {}
        @fairness_interval = @poll_ms / 1000.0
        @fast_tier_queues = Set.new
        @fast_task_ids = Set.new
        @tier_reads = {}
        @dispatch_order = {}
        @dispatch_seq = 0
        @completion_lock = Mutex.new
        @pending_completions = {}
        # The stop statement threads of the latest run (+within+). Only the run loop uses it.
        @stop_statements = []
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
      # pooled connection per cohort after the listener and the heartbeat connection, which every
      # worker on the pool shares. A polling-only worker opens no listener, so it keeps that
      # connection for its cohorts.
      def dispatch_cohorts(cohorts, pool, shared_heartbeats, polling_only)
        unless cohorts.nil?
          raise ArgumentError, "cohorts must be an integer between 1 and concurrency" unless
            cohorts.is_a?(Integer) && cohorts.between?(1, @concurrency)

          return cohorts
        end
        default = (@concurrency < 8) ? 1 : ((@concurrency + 7) / 8).clamp(2, 8)
        capacity = pool.respond_to?(:size) ? pool.size : nil
        return default unless capacity.is_a?(Integer)

        spare = capacity - (polling_only ? 0 : 1) - (shared_heartbeats ? 0 : 1)
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

      # A reporter callback that always fails writes at most one report in this interval.
      REPORTER_FAILURE_REPORT_INTERVAL = 60.0
      private_constant :REPORTER_FAILURE_REPORT_INTERVAL

      # Calls an application reporter callback so that its failure never reaches the run. A reporter
      # observes the worker. It is not part of the dispatch contract, so a raise from it must not stop
      # claims or change the result of the run.
      def call_reporter(name, reporter, error)
        reporter&.call(error)
      rescue => e
        reporter_failed(name, e)
      end

      # The workhorse.worker.reporter value of each reporter callback. Every SDK uses the same values.
      REPORTER_VALUES = {on_registration_error: "registration_error", on_notification_error: "notification_error"}.freeze
      private_constant :REPORTER_VALUES

      # The logger, or standard error without one, is the diagnostic path, so a failed reporter is
      # never called again for its own failure. The interval bounds the output of a reporter that
      # always fails. The report names the error type only, because the message can hold application
      # data.
      def reporter_failed(name, failure)
        now = monotonic
        suppressed = @reporter_failures_lock.synchronize do
          reported_at, count = @reporter_failures[name]
          if reported_at && now - reported_at < REPORTER_FAILURE_REPORT_INTERVAL
            @reporter_failures[name] = [reported_at, count + 1]
            next
          end
          @reporter_failures[name] = [now, 0]
          count || 0
        end
        return if suppressed.nil?

        detail = suppressed.positive? ? " after #{suppressed} unreported failures" : ""
        body = "Workhorse worker #{name} reporter failed#{detail}"
        attributes = {"workhorse.worker.id" => @worker_id, "workhorse.worker.reporter" => REPORTER_VALUES.fetch(name),
                      "error.type" => error_name(failure)}
        if @logger.nil?
          Kernel.warn("workhorse: workhorse.worker.reporter_failed: #{body} #{JSON.generate(attributes)}")
        else
          Telemetry.log(@logger, :error, "workhorse.worker.reporter_failed", body, attributes)
        end
      rescue
        # Inspecting the failure or writing the log can raise. The diagnostic path must not become a
        # second failure.
        nil
      end

      def log(severity, event, body, attributes = {})
        Telemetry.log(@logger, severity, event, body, {"workhorse.worker.id" => @worker_id}.merge(attributes))
      end

      # --- Run loop ---------------------------------------------------------------------------

      def run_loop(continuous, version)
        # One startup budget bounds the wait for the previous run and the startup reservation.
        budget = [@heartbeat_ms / 1000.0, STARTUP_BUDGET_FLOOR].max
        deadline = monotonic + budget
        # A stop during that wait ends the run before it changes any state.
        return false if await_previous_stop(deadline, budget, version) == :stopped

        @run_version = version
        reservation = start_heartbeat(version, deadline, budget)
        # A stop during the startup wait ends the run before it registers.
        return false if reservation == :stopped

        begin
          run_reserved(continuous, version, reservation || OPEN_GATE)
        ensure
          # The run's members renew until the drain ends, so the reservation outlives it. Its
          # release waits only within the stop deadline of the run.
          final = @final_deadline || monotonic
          @final_deadline = nil
          reservation&.close([final - monotonic, 0].max)
        end
      end

      # The waits of the stop path. Each one ends by +deadline+, a monotonic time, so the stop takes
      # at most the shutdown grace plus the unwind window in total.
      def remaining(deadline) = [deadline - monotonic, 0].max

      # Runs +block+ on its own thread named +name+ and waits for it until +deadline+. A block that
      # is still running then finishes on its own thread, which keeps its connection until its
      # statement ends. The stop path sends its registration statements this way. The next run of
      # this worker waits for these threads (+await_previous_stop+).
      def within(deadline, name, &block)
        thread = Thread.new do
          Thread.current.name = name
          block.call
        rescue
          nil
        end
        @stop_statements << thread
        thread.join(remaining(deadline))
        nil
      end

      # Waits until every stop statement of the previous run of this worker has ended, at most
      # until +deadline+. deregister_worker_v2 deletes only the row of its own run, but a late
      # registration write of the previous run would still replace the registry row of this run, and
      # its operator pause state with it. If a statement
      # still runs at +deadline+, the start raises WorkerStartupError before this run changes any
      # state. Thus a statement of an ended run never overlaps a later run. A stop issued after
      # +version+ ends this wait within STARTUP_STOP_CHECK and returns :stopped. The old threads
      # stay listed, so the next run waits for them again.
      def await_previous_stop(deadline, budget, version)
        loop do
          # The stop check comes first, so a stop during the last join counts also when the old
          # statement ended in that join.
          return :stopped if stop_requested?(version)

          @stop_statements.select!(&:alive?)
          break if @stop_statements.empty?
          break unless deadline > monotonic

          @stop_statements.first.join(remaining(deadline).clamp(0, STARTUP_STOP_CHECK))
        end
        return if @stop_statements.empty?

        raise WorkerStartupError, "Worker could not start: a stop statement of its previous run did not end " \
          "within the startup budget of #{budget.round(3)} s"
      end

      def run_reserved(continuous, version, gate)
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
          if continuous && !@polling_only && pool_lends_listener?
            listener = Listener.shared(@pool).subscribe(@queues, on_wake: method(:notify),
              on_error: ->(error) { call_reporter(:on_notification_error, @on_notification_error, error) })
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
          claimed_any = dispatch(continuous, version, handlers, listener, startup, run_errors, maintenance_errors,
            gate)
        ensure
          # Every wait from here ends by the stop deadline, which the shutdown grace sets when
          # dispatch ends, or by the final deadline one unwind window later. No step starts a budget
          # of its own.
          stop_deadline = @stop_deadline || (monotonic + @shutdown_grace)
          @stop_deadline = nil
          final_deadline = stop_deadline + UNWIND_WINDOW
          @final_deadline = final_deadline
          startup&.join(remaining(stop_deadline))
          listener&.close(remaining(stop_deadline))
          @draining = true
          within(stop_deadline, "workhorse-stop-registration") { refresh_registration(force: true) }
          abandoned = drain(handlers, stop_deadline, final_deadline)
          # A handler's completion may admit tasks until the drain ends, so the slots outlive it.
          @state_lock.synchronize { @dispatch_slots = nil }
          instance_id = @instance_id
          within(final_deadline, "workhorse-deregistration") { deregister(instance_id) }
          log(:info, "workhorse.worker.stopped", "Worker stopped",
            "workhorse.worker.active_slots" => abandoned, "workhorse.worker.queues" => @queues)
        end
        raise ShutdownIncompleteError.new(abandoned) if abandoned.positive?
        raise maintenance_errors.first unless maintenance_errors.empty?
        raise run_errors.first unless run_errors.empty?

        claimed_any
      end

      # Reserves the heartbeat connection of the pool, then borrows one other connection for the
      # compatibility query and returns it at once, both within the startup budget. Returns the
      # Heartbeat::Reservation, or nil under shared_heartbeats. A failure releases the reservation
      # and raises WorkerStartupError, or CompatibilityError for an incompatible schema. A stop
      # issued after +version+ ends the wait for the reservation, closes it, and returns :stopped.
      def start_heartbeat(version, deadline, budget)
        if @shared_heartbeats
          @queue.assert_compatible
          return nil
        end

        reservation = @heartbeat.reserve(@heartbeat_ms / 1000.0, method(:wake_dispatcher))
        begin
          loop do
            break if reservation.wait((deadline - monotonic).clamp(0, STARTUP_STOP_CHECK))

            if stop_requested?(version)
              reservation.close
              return :stopped
            end
            raise startup_error("could not reserve its heartbeat connection", budget) unless deadline > monotonic
          end

          code = check_readiness(deadline, budget)
          raise CompatibilityError, code if code
        rescue Exception # rubocop:disable Lint/RescueException
          reservation.close
          raise
        end
        reservation
      end

      # Borrows one connection that is not the heartbeat connection, runs the compatibility query
      # on it, and returns the connection at once. Returns the refusal code of
      # Compatibility.evaluate, or nil. The borrow, a connect that it needs, and the query all end
      # by +deadline+, the end of the startup budget, for every kind of pool: a probe thread does
      # them (Heartbeat#readiness), and the start waits for it only until +deadline+. A borrow that
      # fails or does not end in time, and a query that does not end in time, raise
      # WorkerStartupError. A query that fails keeps its own error.
      def check_readiness(deadline, budget)
        probe = @heartbeat.readiness(deadline) do |connection|
          Compatibility.evaluate(Executor.for(Borrowed.new(connection)))
        end
        unless probe.done.set?
          raise startup_error(probe.lent ? "could not finish its readiness query" :
            "could not borrow a connection for its readiness check", budget)
        end
        return probe.result if probe.error.nil?
        raise probe.error if probe.lent

        raise startup_error("could not borrow a connection for its readiness check", budget), cause: probe.error
      end

      # Whether the pool can lend the shared listener a connection (SM-1585). The listener holds one
      # pooled connection while it listens. With the opt-out, a pool smaller than MIN_POOL_SIZE is
      # allowed, so the listener starts only on a pool that reports a size of at least 2. Otherwise
      # it could hold the only connection, and the worker polls instead. The run logs that once.
      def pool_lends_listener?
        size = @pool.respond_to?(:size) ? @pool.size : nil
        return true if size.is_a?(Integer) && size >= 2

        log(:warn, "workhorse.worker.polling_only", "Worker has no notification listener and dispatches by polling",
          "workhorse.worker.queues" => @queues, "workhorse.worker.pool_max_size" => size.is_a?(Integer) ? size : "unknown")
        false
      end

      def startup_error(failure, budget)
        name = @pool.name if @pool.respond_to?(:name)
        size = @pool.respond_to?(:size) ? @pool.size : "unknown"
        pool = "#{@pool.class.name}#{" #{name.inspect}" if name} (size #{size})"
        WorkerStartupError.new("Worker #{failure} from pool #{pool} within the startup budget of " \
          "#{budget.round(3)} s; set shared_heartbeats: true to opt out")
      end

      # Keeps the slots full without one serial claim round trip per task (ADR 0076). A claim
      # reserves the slots it asks for, so claimed tasks never exceed the concurrency. With no claim
      # in flight, any free slot starts one. While one is in flight, another starts only once the
      # unreserved free slots reach the refill batch, so a busy worker claims in batches. A
      # fast-tier completion claims too, from the same accounting. On the fast tier the slots split
      # into cohorts, and plain claims leave one at a time, each for the roomiest cohort.
      #
      # +gate+ is the claim gate of this run. Under shared_heartbeats it is always open. Otherwise it
      # is the run's Heartbeat::Reservation: open while the run holds it and the pool holds a
      # usable heartbeat connection. A busy or rejected lease does not close it.
      def dispatch(continuous, version, handlers, listener, startup, run_errors, maintenance_errors, gate)
        slots = DispatchSlots.new(@concurrency, @cohorts, listener, version, run_errors, handlers, gate)
        @state_lock.synchronize do
          @dispatch_slots = slots
          # A queue counts as asked when the run starts, so the first completions keep their refills.
          started_at = monotonic
          @queues.each { |queue| @queue_asked_at[queue] = started_at }
        end
        # Each claim in flight, with its limit, its cohort (nil for the whole worker), and the
        # slots it reserved in that cohort.
        claims = {}
        results = ::Queue.new
        next_claim_id = 0

        settle = lambda do |outcome|
          id, claimed_version, claimed, error, gated = outcome
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
            # A claim the closed gate withdrew learned nothing, so it starts no empty-poll backoff.
            settle_claim_progress(slots, claimed, claimed_version, error) unless gated && claimed.empty? && error.nil?
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

              # A pause ends the empty wait, so a resume claims at once. A release wait ignores the
              # wake of the resume, so it must end here.
              wait = @state_lock.synchronize do
                slots.empty_wait = nil
                dispatch_wait(slots)
              end
              @wake.wait(wait)
              next
            end
            unless gate.ready?
              break unless continuous

              # The heartbeat wakes dispatch when its replacement connection is ready.
              @wake.wait(@state_lock.synchronize { dispatch_wait(slots) })
              next
            end
            if empty_wait
              deadline, seen_version = empty_wait
              remaining = deadline - monotonic
              # A nil version marks a release wait, which a wake does not end.
              if remaining <= 0 || (!seen_version.nil? && seen_version != wake_version)
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
                start_claim(next_claim_id, plan, claim_version, empty.positive?, version, results, gate)
              end
            end
            next if claims.empty? && plan_claim(slots, claims)

            # A thread whose task already left @active returns to the executor at once, and no
            # wakeup follows its return, so dispatch rechecks shortly instead.
            returning = handlers.active_count > @active.size
            @wake.wait(returning ? THREAD_RETURN_WAIT : @state_lock.synchronize { dispatch_wait(slots) })
          end
        ensure
          # Completions stop claiming with the loop. Tasks an in-flight claim returns hold leases,
          # so they run before the drain. The wait for them ends with the shutdown grace, which the
          # rest of the stop path shares (+run_reserved+). A claim that returns later admits nothing,
          # and its leases expire.
          @state_lock.synchronize { slots.open = false }
          @stop_deadline = monotonic + @shutdown_grace
          until claims.empty?
            outcome = results.pop(timeout: [@stop_deadline - monotonic, 0].max)
            break if outcome.nil?

            settle.call(outcome)
          end
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
          deadline = monotonic + dispatch_wait(slots)
          if claimed.empty?
            slots.empty_wait ||= [deadline, claimed_version]
          elsif slots.empty_wait.nil? || !slots.empty_wait[1].nil?
            # A release wait. Each release notifies the queue, so a wake does not end this wait:
            # only its deadline, a stop, or a pause does.
            slots.empty_wait = [deadline, nil]
          end
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
          slots.fairness_skip_pending = false
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
      def start_claim(id, plan, wake_version, backing_off, version, results, gate)
        limit, cohort, cohort_limit = plan
        # The notification delay spreads idle workers one notification woke together. A worker
        # whose last claim found work would claim now anyway, so it skips the delay.
        delayed = @notified.make_false && backing_off
        thread = Thread.new do
          claimed = []
          error = nil
          gated = false
          begin
            sleep(rand(0.0..NOTIFICATION_CLAIM_DELAY)) if delayed
            # A worker paused or stopped during the delay sends no claim; settling frees the slots.
            # So does a worker that lost its heartbeat connection after the plan.
            withdrawn = delayed && (stop_requested?(version) || paused?)
            gated = !gate.ready?
            claim_across_queues(limit, claimed, cohort.nil? ? limit : cohort_limit, gate) unless withdrawn || gated
          rescue ClaimWithdrawn
            # The gate closed while the claim waited for its connection. The tasks of the earlier
            # queues hold leases, so they still run.
            gated = true
          rescue => e
            error = e
          ensure
            results << [id, wake_version, claimed, error, gated]
            @wake.set
          end
        end
        thread.name = "workhorse-claim-#{id}"
      end

      # Claims from each queue at most once, starting one queue further on each call. Appends to
      # +claimed+ as each queue answers, so a later queue's error keeps the leases already taken.
      # Fast-tier queues together give at most +fast_limit+ tasks, the free slots of one cohort.
      def claim_across_queues(limit, claimed, fast_limit, gate)
        start = (@next_queue_index.increment - 1) % @queues.size
        @queues.size.times do |offset|
          break if claimed.size >= limit || !gate.ready?

          queue = @queues[(start + offset) % @queues.size]
          @state_lock.synchronize { @queue_asked_at[queue] = monotonic } unless @queues.one?
          claimed.concat(claim(queue, limit - claimed.size, fast_limit - claimed.size, gate))
        end
      end

      def claim(queue, limit, fast_limit, gate)
        started_at = monotonic
        Telemetry.span("workhorse.claim", {"workhorse.queue.name" => queue}) do |span|
          rows = claim_queue(queue, limit, started_at, fast_limit, gate)
          if rows.nil?
            Telemetry.set_attribute(span, "workhorse.queue.tier", "full")
            rows = @statement_watch.watch("claim") do
              permitted(gate) do |build|
                @executor.rows(SqlCatalogue::CLAIM_MANY_V1, build.call { [queue, @worker_id, limit.to_s, @lease_ms.to_s] })
              end
            end
            track_full_tier_claim(queue, rows) if rows.any?
          end
          tasks = rows.map { |row| ClaimedTask.from_row(row, queue) }
          record_claimed(queue, started_at, tasks)
          Telemetry.task_span_attributes(tasks.first).each { |key, value| Telemetry.set_attribute(span, key, value) } if tasks.any?
          tasks.map { |task| [task, started_at] }
        end
      end

      # Yields a builder of the parameters of one claim statement, and gives back its claim permit
      # when the statement settles. Each parameters callable runs in Executor#rows, after the claim
      # has its connection and before each attempt, also before a deadlock retry. The first attempt
      # takes a permit from +gate+ (Heartbeat::Reservation#enter). A closed gate then raises
      # ClaimWithdrawn, so a heartbeat connection lost while the claim waited for the pool cannot
      # leave leases that nothing renews. +gate+ is the gate of the claim's own run, so a later run
      # cannot reopen it. The permit keeps the run's reservation until the statement settles, also
      # when the stop stopped waiting for the claim.
      def permitted(gate)
        held = false
        builder = lambda do |&params|
          lambda do
            raise ClaimWithdrawn unless held ? gate.ready? : (held = gate.enter)

            params.call
          end
        end
        yield builder
      ensure
        gate.leave if held
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
      def claim_queue(queue, limit, sent_at, fast_limit, gate)
        return nil if @state_lock.synchronize { @full_tier_until.fetch(queue, -Float::INFINITY) > sent_at }

        fast_limit = [limit, fast_limit].min
        return [] if fast_limit <= 0

        begin
          rows = @statement_watch.watch("claim") do
            permitted(gate) do |build|
              @executor.fenced_rows(SqlCatalogue::COMPLETE_MANY_AND_CLAIM_V1,
                build.call { [@worker_id, "{}", "{}", "{}", queue, fast_limit.to_s, @lease_ms.to_s] })
            end
          end
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
        pending = PendingCompletion.new(task, encoded, reservation.limit, Concurrent::Event.new, false, [], false, nil, false,
          reservation.gate)
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
      # nothing while the worker stops, pauses, waits after an empty claim, or has no usable
      # heartbeat connection, and it waits for the cohort's refill batch while another claim for the
      # cohort is in flight. It also claims nothing when another queue of the worker has waited a
      # fairness interval for a claim (rule 17).
      def reserve_completion_claim(task)
        @state_lock.synchronize do
          slots = @dispatch_slots
          next CompletionClaim.new(0, 0, @wake_version, CLOSED_GATE) if slots.nil?

          cohort = slots.thread_cohorts.fetch(task.id, 0)
          idle = CompletionClaim.new(0, cohort, @wake_version, slots.gate)
          next idle if !slots.open || stop_requested?(slots.version) || !slots.run_errors.empty? || paused? ||
            slots.claim_error || slots.empty_wait || !slots.gate.ready?

          # The slot this task leaves is free, but its thread is not until the handler returns.
          limit = [[slots.free_slots, slots.cohort_free(cohort)].min + 1, slots.thread_room].min
          claiming = slots.whole_claims.positive? || slots.cohort_claims[cohort].positive?
          next idle if limit <= 0 || (claiming && limit < slots.refill_batch)

          # The completion gives its slot back, so the next plain claim continues the rotation.
          if !slots.fairness_skip_pending && other_queue_waiting?(task.queue)
            slots.fairness_skip_pending = true
            next idle
          end
          # Until that plain claim starts, a fused claim refills only its own slot, so it cannot take
          # the slot that the skipped completion gave back.
          limit = 1 if slots.fairness_skip_pending
          @queue_asked_at[task.queue] = monotonic unless @queues.one?
          slots.reserved += limit
          slots.cohort_reserved[cohort] += limit
          slots.handed_over[task.id] = cohort
          slots.cohort_handed_over[cohort] += 1
          CompletionClaim.new(limit, cohort, @wake_version, slots.gate)
        end
      end

      # Whether a queue other than +queue+ had no claim for the fairness interval. A fused claim asks
      # only its own queue, so while that queue has a backlog its completions would keep every slot,
      # and no plain claim would ask the other queues. The caller holds @state_lock.
      def other_queue_waiting?(queue)
        return false if @queues.one?

        now = monotonic
        @queues.any? { |other| other != queue && now - @queue_asked_at.fetch(other, now) >= @fairness_interval }
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
            slots.empty_wait ||= [monotonic + dispatch_wait(slots), reservation.wake_version]
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
      # again. The statement reads the claim gate after it has its connection, and again before
      # each retry. A closed gate sends a claim limit of zero, also for completions that reserved
      # slots or waited behind another statement. Each completion then gets nil as its claimed
      # tasks, so the empty answer proves no queue empty.
      def send_completion_chunk(queue, chunk, claim_limit)
        chunk.sort_by! { |member| member.task.id }
        sent_at = monotonic
        gated = false
        # A statement that can claim takes a permit from each gate of its chunk at its first
        # attempt, and gives them back when it settles (+permitted+).
        gates = chunk.map(&:gate).uniq
        held = []
        params = lambda do
          if claim_limit.positive?
            held = gates.select(&:enter) if held.empty? && !gated
            gated = held.size < gates.size || !gates.all?(&:ready?)
          end
          [
            @worker_id,
            Values.text_array(chunk.map { |member| member.task.id }, "task ids"),
            Values.text_array(chunk.map { |member| member.task.fence_token.to_s }, "fence tokens"),
            Values.text_array(chunk.map(&:encoded), "results"),
            queue, (gated ? 0 : claim_limit).to_s, @lease_ms.to_s
          ]
        end
        begin
          send = -> { @executor.fenced_rows(SqlCatalogue::COMPLETE_MANY_AND_CLAIM_V1, params) }
          # A send that only completes claims nothing, so only a send that claims is watched.
          rows = claim_limit.positive? ? @statement_watch.watch("claim", &send) : send.call
        rescue FastTierUnsupportedError
          mark_full_tier(queue, sent_at)
          chunk.each { |member| member.full_tier = true }
          return
        ensure
          held.each(&:leave)
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
        record_claimed(queue, sent_at, claimed) if claim_limit.positive? && !gated
        # Claimed tasks go to the completions in order, each up to the slots it reserved.
        offset = 0
        chunk.each do |member|
          member.accepted = accepted.include?(member.task.id)
          if gated
            member.claimed = nil
            next
          end
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
      # worker backs off exponentially while claims come back empty. The caller holds @state_lock.
      # Without a live subscription, the backoff restarts when the wait before had one, so the
      # empty claims of the live period do not count.
      def dispatch_wait(slots)
        listening = slots.listener&.listening? || false
        slots.empty = [slots.empty, 1].min if !listening && slots.listened_at_last_wait
        slots.listened_at_last_wait = listening
        milliseconds = if listening
          @notification_poll_ms
        else
          [MAX_EMPTY_POLL_MS, @poll_ms * (2**[0, slots.empty - 1].max)].min
        end
        milliseconds = [1, (milliseconds * rand(0.9..1.1)).round].max
        milliseconds = [milliseconds, @registry_ms].min if @registry_ms.positive?
        milliseconds / 1000.0
      end

      # Waits until +deadline+, the end of the shutdown grace, cancels what still runs, and gives it
      # one unwind window, which ends by +final_deadline+. Returns the number of handlers abandoned
      # after that window.
      def drain(handlers, deadline, final_deadline)
        # A lingering batch cannot grow once claims stop, so it runs as soon as its members arrive.
        @batch_coordinators.each_value(&:flush!)
        wait_until_idle(deadline)
        remaining = @active.values
        unless remaining.empty?
          remaining.each { |active| active.cancellation.cancel(:shutdown) }
          wait_until_idle([monotonic + UNWIND_WINDOW, final_deadline].min)
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
            "error.type" => error_name(e))
          call_reporter(:on_registration_error, @on_registration_error, e)
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

      # Deletes the registry row of the run with +instance_id+. deregister_worker_v2 keeps the row
      # when a later run of this worker ID has replaced it.
      def deregister(instance_id)
        return unless @registered.make_false

        @executor.rows(SqlCatalogue::DEREGISTER_WORKER_V2, [@worker_id, instance_id])
      rescue
        nil
      end

      # Runs one maintenance pass when its interval elapsed. Returns whether it ran. The interval
      # restarts only after a pass succeeds, so a failed pass runs again on the next dispatch.
      def run_maintenance_if_due
        now = monotonic
        return false if now - @last_maintenance_at.get < @maintenance_ms / 1000.0

        @statement_watch.watch("maintenance") { run_maintenance_pass(now) }
        true
      end

      def run_maintenance_pass(now)
        Telemetry.span("workhorse.maintenance", {"workhorse.maintenance.operation" => "tick"}) do |span|
          total = 0
          Telemetry.span("workhorse.recovery", {}) do |recovery|
            @executor.rows(SqlCatalogue::TICK_V1, ["100", "100"]).each do |row|
              total += record_maintenance(row, recovery, log: true)
            end
            if now - @last_routine_at >= @routine_ms / 1000.0
              @last_routine_at = now
              @executor.rows(SqlCatalogue::RUN_MAINTENANCE_V1, [DATABASE_NOW]).each do |row|
                total += record_maintenance(row, nil, log: false)
              end
            end
          end
          Telemetry.set_attribute(span, "workhorse.maintenance.rows_affected", total)
        end
        @last_maintenance_at.set(now)
        fire_schedules unless @schedule_namespaces.empty?
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
            Telemetry.record_error(span, error_name(e))
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

      # Hands a task with no handler back to PostgreSQL. Returns the release status for the handler
      # span.
      def release(task, arbiter, attributes)
        log(:warn, "workhorse.handler.missing", "No handler registered for the claimed task type", attributes)
        release_owned(task, arbiter, attributes)
      end

      # Hands an owned task back to PostgreSQL, which makes it claimable again without charging the
      # attempt. Returns the release status.
      def release_owned(task, arbiter, attributes)
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
          check_result_storable(task, encoded)
          check_result_size(task, encoded)
        rescue HandlerContext::Suspension
          return if finish_ownership(task, ownership, arbiter)

          raise Error, "Durable wait suspension was not accepted by the arbiter"
        rescue => e
          return if finish_suspended(task, ownership, arbiter)

          # A handler that stopped for shutdown returns the task to the queue without an attempt.
          if cancellation.reason == :shutdown && shutdown_cancellation?(e)
            state[:span_outcome] = release_owned(task, arbiter, Telemetry.task_span_attributes(task))
            return
          end

          state[:span_outcome] = settle_failure(task, e, arbiter)
          state[:errors] << (task.redact_error_details ? REDACTED_NAME : error_name(e))
          return
        ensure
          ownership.release
        end
        return if finish_suspended(task, ownership, arbiter)

        complete(task, ownership, encoded, arbiter)
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

      def complete(task, ownership, encoded, arbiter)
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
        return reconcile_rejected_completion(task, ownership, arbiter) unless accepted

        Telemetry.add("workhorse.tasks.completed", 1, Telemetry.task_metric_attributes(task))
        arbiter.submit(:completed)
      end

      # Settles the boundary that made PostgreSQL refuse this attempt's completion. A completion
      # refuses a requested cancellation, a due deadline, or a due attempt timeout without writing
      # it. Renewal stops when the handler returns, so the attempt settles them here under its own
      # fence and does not leave the task to recovery. Only a lost lease raises LeaseLostError.
      #
      # A heartbeat round that read the membership before the release can still be settling the
      # attempt. The reconciliation waits for it on the settlement lock, and finishes with its
      # outcome if it decided the attempt. A round that takes the lock after the release changes
      # nothing. The heartbeat thread delivers statuses inline, so the lock is not held during the
      # statements here.
      def reconcile_rejected_completion(task, ownership, arbiter)
        decided = ownership.settlement.synchronize { !arbiter.outcome.nil? }
        return if decided && finish_lifecycle(task, arbiter)

        outcome = outcome_for_status(expire_owned(task, Telemetry.current_context), ["not_due"], "complete")
        return arbiter.submit(:cancelled) if outcome == :cancelled && acknowledge_cancel(task)
        return arbiter.submit(outcome) if %i[deadline_exceeded attempt_timeout].include?(outcome)

        arbiter.submit(:lease_expired)
        raise LeaseLostError.new(task.id, "complete")
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
          # An accepted heartbeat that arrives after the window ended ends the attempt, as the
          # watchdog does.
          renew: ->(sent_at) { ownership.renew(sent_at) || lose_lease(ownership, arbiter, cancellation) },
          settle: lambda do |status|
            ownership.settlement.synchronize do
              # After the release, the final write settles the attempt.
              next if ownership.released?

              if %w[deadline_exceeded timeout_exceeded].include?(status)
                settle_expiration(task, arbiter, cancellation, parent)
              else
                deliver_status(task, status, arbiter, cancellation)
              end
            end
          end,
          fail: fail_attempt,
          logger: @logger,
          # The local lease window closes when the watchdog stops the attempt.
          lease_ends_at: -> { ownership.lease_deadline unless ownership.stop.set? }
        )
        unregister = @heartbeat.register(member)
        watchdog = Thread.new { watch_expiration(task, ownership, arbiter, cancellation, parent, fail_attempt) }
        watchdog.name = "workhorse-expiration-#{task.id}"
        ownership.start(unregister, watchdog)
      end

      # Ends an attempt locally when its lease lapses unrenewed, and asks PostgreSQL to settle a
      # deadline or an attempt timeout when one passes. While PostgreSQL answers not_due, the first
      # retry waits EXPIRATION_RETRY and each later one waits twice as long, up to
      # EXPIRATION_RETRY_MAX. Each request locks the task row, so a short fixed retry makes the
      # heartbeat of the attempt answer busy (SM-1701).
      def watch_expiration(task, ownership, arbiter, cancellation, parent, fail_attempt)
        expiration_at = [task.deadline_at, task.attempt_timeout_at].compact.min
        retry_at = nil
        retry_delay = EXPIRATION_RETRY
        loop do
          delay = if retry_at
            retry_at - monotonic
          elsif expiration_at
            expiration_at - Time.now
          end
          lease_delay = ownership.lease_remaining
          if delay.nil? || lease_delay < delay
            if lease_delay.positive?
              return if ownership.stop.wait(lease_delay)

              next
            end
            lose_lease(ownership, arbiter, cancellation)
            return
          end
          return if ownership.stop.wait([0, delay].max)

          status = ownership.settlement.synchronize { settle_expiration(task, arbiter, cancellation, parent) }
          return unless status == "not_due"

          retry_at = monotonic + retry_delay
          retry_delay = [retry_delay * 2, EXPIRATION_RETRY_MAX].min
        end
      rescue => e
        fail_attempt.call(e)
      end

      # Ends an attempt whose local lease window ended: the lease counts as lost, the heartbeat stops,
      # and the handler is cancelled. The watchdog and a late accepted heartbeat both end it here.
      def lose_lease(ownership, arbiter, cancellation)
        arbiter.submit(:lease_expired)
        ownership.abandon
        cancellation.cancel(:lease_lost)
      end

      def settle_expiration(task, arbiter, cancellation, parent)
        status = expire_owned(task, parent)
        deliver_status(task, status, arbiter, cancellation) unless status == "not_due"
        status
      end

      # Asks PostgreSQL to settle a due deadline or attempt timeout under the attempt's fence, and
      # records the retry and the log line for a settled one. Returns the expiration status.
      def expire_owned(task, parent)
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
          delay = durable_replay_conflict(error) ? -1 : retry_delay_override(task)
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

      # Whether +error+, or an error it wraps, is a +:shutdown+ CancelledError. With the token's own
      # reason, it proves the handler saw the stop, so a failure of its own that races the grace
      # still charges its attempt. The walk stays bounded against a cyclic cause chain.
      def shutdown_cancellation?(error)
        16.times do
          return false if error.nil?
          return true if error.is_a?(CancelledError) && error.reason == :shutdown

          error = error.cause
        end
        false
      end

      # The durable replay conflict (ADR 0098) that +error+ is or wraps, or nil. A handler can wrap a
      # conflict in its own error. The conflict is terminal also then, as in Go and Rust, and the
      # failure envelope records the name of the conflict. The walk stays bounded against a cyclic
      # cause chain.
      def durable_replay_conflict(error)
        16.times do
          return nil if error.nil?
          return error if error.is_a?(ConflictError)

          error = error.cause
        end
        nil
      end

      def retry_delay_override(task)
        delay = @retry_delay.respond_to?(:call) ? @retry_delay.call(task.attempt, task) : @retry_delay
        return nil if delay.nil?

        retry_delay_milliseconds(delay)
      end

      # fail_v1 takes the delay as a PostgreSQL integer. The delay rounds to the nearest
      # millisecond, half up. A negative delay is refused also when it rounds to 0 (ADR 0111).
      # A real value other than a Float converts exactly, so 500.5 ms is 501 ms.
      def retry_delay_milliseconds(delay)
        negative = delay.is_a?(Numeric) && delay.respond_to?(:negative?) && delay.negative?
        exact = exact_retry_delay_milliseconds(delay) unless negative
        return exact if exact && RETRY_DELAY_RANGE.cover?(exact)
        raise ArgumentError, RETRY_DELAY_REFUSAL if negative || exact

        Values.milliseconds(delay, "retry_delay", RETRY_DELAY_RANGE)
      end

      # Whole milliseconds of an Integer, Rational, or BigDecimal count of seconds, rounded half up.
      # Returns nil for a Float or for a value without an exact Rational form.
      def exact_retry_delay_milliseconds(delay)
        return nil if !delay.is_a?(Numeric) || delay.is_a?(Float) || !delay.real?

        (delay.to_r * 1000).round(half: :up)
      rescue NoMethodError, RangeError
        nil
      end

      def error_envelope(error, redact)
        return {"name" => REDACTED_NAME, "message" => REDACTED_MESSAGE} if redact

        # A wrapped durable replay conflict keeps its name. The message and stack stay the outer ones.
        {"name" => storable_text(error_name(durable_replay_conflict(error) || error)),
         "message" => storable_text(error.message.to_s),
         "stack" => storable_text(error.full_message(highlight: false, order: :top))}
      end

      # The class name of +error+. An anonymous class has no name, so the worker uses the name of
      # its nearest named superclass. Thus +Class.new(StandardError)+ gives "StandardError", and no
      # envelope records a null name. +Exception+ has a name, so the walk ends.
      def error_name(error)
        klass = error.class
        klass = klass.superclass until klass.name.is_a?(String)
        klass.name
      end

      # +text+ as UTF-8 with each NUL and each byte that is not UTF-8 replaced by U+FFFD. PostgreSQL
      # jsonb stores no NUL, the JSON generator refuses text that is not UTF-8, and either refusal
      # would end the worker instead of recording the handler's failure. A Ruby string holds bytes,
      # so a byte that is not UTF-8 is the nearest form of the unpaired surrogate that the JVM and
      # .NET workers replace. A binary string is read as UTF-8 bytes.
      def storable_text(text)
        text = text.dup.force_encoding(Encoding::UTF_8) if text.encoding == Encoding::BINARY
        unless text.encoding == Encoding::UTF_8
          text = text.encode(Encoding::UTF_8, invalid: :replace, undef: :replace, replace: "\uFFFD")
        end
        # One U+FFFD for each byte, as the Go worker and encoding/json write it.
        text = text.scrub { |bytes| "\uFFFD" * bytes.bytesize } unless text.valid_encoding?
        text.include?("\0") ? text.tr("\0", "\uFFFD") : text
      end

      def validate_result(task, result)
        version = task.contract_version
        return if version.nil?

        schema = @contracts[[task.type, version]]
        if schema.nil?
          rows = @executor.rows(SqlCatalogue::GET_CONTRACT_DEFINITION_V1, [task.type, version])
          raise ContractUnavailableError.new(task.type, version) unless rows.one?

          document = Contracts.parse_schema(rows.first["schema"])
          raise ContractUnavailableError.new(task.type, version) unless document.is_a?(Hash) && document.key?("result")

          schema = ContractSchema.stored(document["result"])
          @contracts[[task.type, version]] = schema
        end
        raise ContractValidationError.new(task.type, version, "result") unless schema.valid?(result)
      end

      # PostgreSQL refuses a result whose jsonb text exceeds the task's limit, and that refusal
      # would end the worker rather than the attempt, so the worker measures the same text first.
      # Without exponent notation that text is at most twice as long as the compact JSON, which
      # lets most results skip the exact measure. The exact measure reads the JSON the worker sends,
      # not the handler's object: a custom to_json changes the text, and jsonb keeps only the last
      # of duplicate keys.
      def check_result_size(task, encoded)
        limit = task.result_max_bytes
        return if limit.nil? || (encoded.bytesize * 2 <= limit && !EXPONENT_NUMBER.match?(encoded))

        actual = Values.jsonb_text_bytes(encoded)
        raise ValueSizeLimitError.new(task.type, "result", actual, limit) if actual > limit
      end

      # PostgreSQL refuses a jsonb string or key that holds NUL or a surrogate outside a pair, and
      # that refusal would end the worker rather than the attempt. JSON.generate writes NUL as
      # \u0000 and refuses malformed UTF-8, so a surrogate escape can only come from a custom
      # to_json. A high surrogate is stored only when a low surrogate escape follows it at once. The
      # error carries no part of the result, so the failure envelope that reports it stays storable.
      def check_result_storable(task, encoded)
        return unless unstorable_escape?(encoded)

        raise ArgumentError,
          "#{task.type} result contains a NUL character or an unpaired surrogate, which PostgreSQL jsonb cannot store"
      end

      def unstorable_escape?(encoded)
        return false unless UNSTORABLE_ESCAPE_START.match?(encoded)

        low_expected_at = nil
        encoded.scan(JSON_ESCAPE) do |(digits)|
          match = Regexp.last_match
          unit = digits&.to_i(16)
          if low_expected_at
            return true unless match.begin(0) == low_expected_at && unit&.between?(0xDC00, 0xDFFF)

            low_expected_at = nil
          elsif unit
            return true if unit.zero? || unit.between?(0xDC00, 0xDFFF)

            low_expected_at = match.end(0) if unit.between?(0xD800, 0xDBFF)
          end
        end
        !low_expected_at.nil?
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
