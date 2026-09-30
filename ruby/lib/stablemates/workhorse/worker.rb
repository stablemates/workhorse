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
      EXPIRATION_RETRY = 0.005
      REDACTED_NAME = "RedactedTaskError"
      REDACTED_MESSAGE = "Task handler failed; details redacted"
      PROTOCOL = "5"
      LANGUAGE = "ruby"
      MIN_POOL_SIZE = 3
      STATUS_OUTCOMES = {
        "cancel_requested" => :cancelled, "deadline_exceeded" => :deadline_exceeded,
        "timeout_exceeded" => :attempt_timeout, "stale" => :lease_expired
      }.freeze
      TELEMETRY_OUTCOMES = {
        :completed => "succeeded", :failed => "failed", :retry => "retry", :lease_expired => "lease_lost",
        :released => "released", :deadline_exceeded => "deadline_exceeded", :attempt_timeout => "timeout",
        :cancelled => "canceled", :suspended_for_wait => "suspended", :suspended_for_child => "suspended", nil => "unknown"
      }.freeze
      SPAN_OUTCOMES = TELEMETRY_OUTCOMES.merge(lease_expired: "stale", attempt_timeout: "timeout_exceeded").freeze
      CANCEL_REASONS = {
        cancelled: :requested, deadline_exceeded: :deadline_exceeded, attempt_timeout: :execution_timeout
      }.freeze
      private_constant :MAX_EMPTY_POLL_MS, :NOTIFICATION_POLL_MS, :NOTIFICATION_CLAIM_DELAY, :UNWIND_WINDOW,
        :EXPIRATION_RETRY, :REDACTED_NAME, :REDACTED_MESSAGE, :PROTOCOL, :LANGUAGE, :MIN_POOL_SIZE,
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

      Active = Struct.new(:cancellation, :ownership) # :nodoc:
      private_constant :Active

      attr_reader :worker_id, :queues, :concurrency

      def initialize(pool, queues: ["default"], worker_id: nil, concurrency: 1, lease: 30, heartbeat: nil,
        poll_interval: nil, polling_only: false, maintenance_interval: 1, maintenance_routine_interval: 60,
        registry_interval: 5, disable_registry: false, schedule_namespaces: [], schedule_catchup_limit: 100,
        shutdown_grace: 25, shared_heartbeats: false, retry_delay: nil, on_registration_error: nil,
        on_notification_error: nil, logger: nil)
        @executor = worker_executor(pool, shared_heartbeats)
        @pool = pool
        @queues = unique_names(queues, "queues")
        raise ArgumentError, "queues must contain at least one non-empty queue name" if @queues.empty?

        raise ArgumentError, "concurrency must be an Integer between 1 and 100" unless
          concurrency.is_a?(Integer) && concurrency.between?(1, 100)

        @concurrency = concurrency
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
        @handlers = {}
        @contracts = {}
        @lock = Monitor.new
        @run_lock = Mutex.new
        @wake = Concurrent::Event.new
        @notified = Concurrent::AtomicBoolean.new(false)
        @stop_version = 0
        @locally_paused = false
        @remotely_paused = false
        @active = {}
        @next_queue_index = 0
        @last_maintenance_at = -Float::INFINITY
        @last_routine_at = -Float::INFINITY
        @last_registry_at = -Float::INFINITY
        @registered = false
        @instance_id = nil
        @draining = false
      end

      # Registers the block that runs tasks of +task_type+. The block receives the payload and a
      # HandlerContext; its return value is the task's JSON result. A second call replaces the first.
      def handle(task_type, &handler)
        raise ArgumentError, "task_type must be a non-empty String" unless task_type.is_a?(String) && !task_type.empty?
        raise ArgumentError, "handle requires a block" if handler.nil?

        @lock.synchronize { @handlers[task_type] = handler }
        self
      end

      # Claims and runs tasks until +stop+. Raises the first error that ended the run.
      def run
        version = @lock.synchronize { @stop_version }
        @run_lock.synchronize { run_loop(true, version) }
        nil
      end

      # Claims one batch, runs it, and returns whether a handled task ran.
      def run_once
        version = @lock.synchronize { @stop_version }
        @run_lock.synchronize { run_loop(false, version) }
      end

      # Ends claiming. A running +run+ drains its handlers and returns.
      def stop
        active = @lock.synchronize do
          @stop_version += 1
          @active.size
        end
        log(:info, "workhorse.worker.stop_requested", "Worker stop requested",
          "workhorse.worker.active_slots" => active, "workhorse.worker.queues" => @queues)
        @wake.set
      end

      # Starts no claim until +resume+. Running handlers continue.
      def pause
        @lock.synchronize { @locally_paused = true }
        log(:info, "workhorse.worker.paused", "Worker paused locally", "workhorse.worker.queues" => @queues)
        @wake.set
      end

      def resume
        @lock.synchronize { @locally_paused = false }
        log(:info, "workhorse.worker.resumed", "Worker resumed locally", "workhorse.worker.queues" => @queues)
        @wake.set
      end

      # Whether this worker or an operator paused it.
      def paused? = @lock.synchronize { @locally_paused || @remotely_paused }

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

      def unique_names(values, label)
        values = [values] if values.is_a?(String)
        raise ArgumentError, "#{label} must be an Array of non-empty Strings" unless
          values.is_a?(Array) && values.all? { |value| value.is_a?(String) && !value.empty? }

        values.uniq.freeze
      end

      def monotonic = Process.clock_gettime(Process::CLOCK_MONOTONIC)

      def stop_requested?(version) = @lock.synchronize { @stop_version != version }

      def log(severity, event, body, attributes = {})
        Telemetry.log(@logger, severity, event, body, {"workhorse.worker.id" => @worker_id}.merge(attributes))
      end

      # --- Run loop ---------------------------------------------------------------------------

      def run_loop(continuous, version)
        @queue.assert_compatible
        @instance_id = SecureRandom.uuid
        @registered = false
        @draining = false
        run_errors = Concurrent::Array.new
        maintenance_errors = Concurrent::Array.new
        handlers = Concurrent::ThreadPoolExecutor.new(min_threads: 0, max_threads: @concurrency,
          max_queue: @concurrency, fallback_policy: :abort)
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
          deregister
          log(:info, "workhorse.worker.stopped", "Worker stopped",
            "workhorse.worker.active_slots" => abandoned, "workhorse.worker.queues" => @queues)
        end
        raise ShutdownIncompleteError.new(abandoned) if abandoned.positive?
        raise maintenance_errors.first unless maintenance_errors.empty?
        raise run_errors.first unless run_errors.empty?

        claimed_any
      end

      # Starts claims while slots are free, admits what they return, and waits otherwise. At most
      # four claims are in flight, because a claim needs a quarter of the slots free.
      def dispatch(continuous, version, handlers, listener, startup, run_errors, maintenance_errors)
        refill = (@concurrency / 4.0).ceil
        reserved = 0
        claims = {}
        results = ::Queue.new
        claim_error = nil
        pass_ended = false
        empty = 0
        empty_wait = nil
        claimed_any = false
        wake_version = 0
        next_claim_id = 0

        settle = lambda do |outcome|
          id, limit, claimed_version, claimed, error = outcome
          claims.delete(id)
          reserved -= limit
          claimed.each { |task, started_at| admit(handlers, task, started_at, run_errors) }
          if error
            claim_error ||= error
          elsif claimed.any? { |task, _| handled?(task.type) }
            empty = 0
            claimed_any = true
            empty_wait = nil
          else
            empty += 1
            pass_ended = true
            empty_wait ||= [monotonic + dispatch_wait(empty, listener), claimed_version]
          end
        end

        next_claim = lambda do
          free = @concurrency - @lock.synchronize { @active.size } - reserved
          next nil if free <= 0
          next nil if !claims.empty? && free < refill

          free
        end

        begin
          loop do
            @wake.reset
            wake_version += 1 if @notified.true?
            settle.call(results.pop) until results.empty?
            refresh_registration
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
                empty_wait = nil
              else
                @wake.wait(remaining)
              end
              next
            end
            if next_claim.call
              run_maintenance_if_due unless startup&.alive?
              while (limit = next_claim.call)
                next_claim_id += 1
                delayed = @notified.make_false && empty.positive?
                reserved += limit
                claims[next_claim_id] = limit
                start_claim(next_claim_id, limit, wake_version, delayed, version, results)
              end
            end
            @wake.wait(dispatch_wait(empty, listener)) unless claims.empty? && next_claim.call
          end
        ensure
          settle.call(results.pop) until claims.empty?
        end
        raise claim_error if claim_error

        claimed_any
      end

      def notify
        @notified.make_true
        @wake.set
      end

      def start_claim(id, limit, wake_version, delayed, version, results)
        thread = Thread.new do
          claimed = []
          error = nil
          begin
            sleep(rand(0.0..NOTIFICATION_CLAIM_DELAY)) if delayed
            claimed = claim_across_queues(limit) unless delayed && stop_requested?(version)
          rescue => e
            error = e
          ensure
            results << [id, limit, wake_version, claimed, error]
            @wake.set
          end
        end
        thread.name = "workhorse-claim-#{id}"
      end

      # Claims from each queue at most once, starting one queue further on each call.
      def claim_across_queues(limit)
        start = @lock.synchronize do
          index = @next_queue_index
          @next_queue_index = (index + 1) % @queues.size
          index
        end
        claimed = []
        @queues.size.times do |offset|
          break if claimed.size >= limit

          queue = @queues[(start + offset) % @queues.size]
          claimed.concat(claim(queue, limit - claimed.size))
        end
        claimed
      end

      def claim(queue, limit)
        started_at = monotonic
        Telemetry.span("workhorse.claim", {"workhorse.queue.name" => queue}) do |span|
          rows = @executor.rows(SqlCatalogue::CLAIM_MANY_V1, [queue, @worker_id, limit.to_s, @lease_ms.to_s])
          tasks = rows.map { |row| ClaimedTask.from_row(row, queue) }
          Telemetry.record("workhorse.claim.duration", (monotonic - started_at) * 1000,
            "workhorse.queue.name" => queue, "workhorse.claim.result" => tasks.empty? ? "empty" : "claimed")
          Telemetry.task_span_attributes(tasks.first).each { |key, value| Telemetry.set_attribute(span, key, value) } if tasks.any?
          tasks.map do |task|
            Telemetry.add("workhorse.tasks.claimed", 1, Telemetry.task_metric_attributes(task))
            log(:debug, "workhorse.task.claimed", "Task claimed", Telemetry.task_span_attributes(task))
            [task, started_at]
          end
        end
      end

      def handled?(task_type) = @lock.synchronize { @handlers.key?(task_type) }

      # A claimed task always runs, even after stop or pause: its lease is already held.
      def admit(handlers, task, started_at, run_errors)
        active = Active.new(CancellationToken.new, nil)
        @lock.synchronize { @active[task.id] = active }
        handlers.post { run_claimed_task(task, started_at, active, run_errors) }
      end

      def run_claimed_task(task, started_at, active, run_errors)
        execute(task, started_at, active)
      rescue LeaseLostError
        nil
      rescue Exception => e # rubocop:disable Lint/RescueException
        run_errors << e
        @lock.synchronize { @stop_version += 1 }
      ensure
        @lock.synchronize { @active.delete(task.id) }
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
        deadline = monotonic + @shutdown_grace
        wait_until_idle(deadline)
        remaining = @lock.synchronize { @active.values }
        unless remaining.empty?
          remaining.each { |active| active.cancellation.cancel(:shutdown) }
          wait_until_idle(monotonic + UNWIND_WINDOW)
        end
        abandoned = @lock.synchronize { @active.values }
        abandoned.each { |active| active.ownership&.abandon }
        handlers.shutdown
        abandoned.size
      end

      def wait_until_idle(deadline)
        loop do
          return if @lock.synchronize { @active.empty? }

          remaining = deadline - monotonic
          return if remaining <= 0

          @wake.reset
          next if @lock.synchronize { @active.empty? }

          @wake.wait([remaining, 0.05].min)
        end
      end

      # --- Registration and maintenance -------------------------------------------------------

      def refresh_registration(force: false)
        return if @registry_ms.zero?

        now = monotonic
        return if !force && now - @last_registry_at < @registry_ms / 1000.0

        @last_registry_at = now
        active = @lock.synchronize { @active.size }
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
        changed = @lock.synchronize do
          previous = @remotely_paused
          @remotely_paused = paused
          @registered = true
          previous != paused
        end
        log(:debug, "workhorse.worker.registered", "Worker registration refreshed",
          "workhorse.worker.active_slots" => active, "workhorse.worker.draining" => @draining,
          "workhorse.worker.paused" => paused)
        return unless changed

        if paused
          log(:info, "workhorse.worker.paused", "Worker paused remotely")
        else
          log(:info, "workhorse.worker.resumed", "Worker resumed remotely")
        end
        @wake.set
      end

      def deregister
        return unless @lock.synchronize { @registered.tap { @registered = false } }

        @executor.rows(SqlCatalogue::DEREGISTER_WORKER_V1, [@worker_id])
      rescue
        nil
      end

      # Runs one maintenance pass when its interval elapsed. Returns whether it ran. The interval
      # restarts only after a pass succeeds, so a failed pass runs again on the next dispatch.
      def run_maintenance_if_due
        now = monotonic
        return false if now - @lock.synchronize { @last_maintenance_at } < @maintenance_ms / 1000.0

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
        @lock.synchronize { @last_maintenance_at = now }
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
        handler = @lock.synchronize { @handlers[task.type] }
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
        outcome = TELEMETRY_OUTCOMES.fetch(arbiter.outcome, "unknown")
        Telemetry.set_attribute(span, "workhorse.handler.outcome",
          state[:span_outcome] || SPAN_OUTCOMES.fetch(arbiter.outcome, "unknown"))
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
        @lock.synchronize { active.ownership = ownership }
        context = HandlerContext.new(executor: @executor, queue: @queue, task: task, worker_id: @worker_id,
          cancellation: cancellation, arbiter: arbiter, logger: @logger)
        begin
          result = handler.call(task.payload, context)
          validate_result(task, result)
          encoded = Values.json(result, "task result")
        rescue HandlerContext::Suspension
          return if finish_ownership(task, ownership, arbiter)

          raise Error, "Durable wait suspension was not accepted by the arbiter"
        rescue => e
          return if finish_ownership(task, ownership, arbiter)

          state[:span_outcome] = settle_failure(task, e, arbiter)
          state[:errors] << (task.redact_error_details ? REDACTED_NAME : e.class.name)
          return
        ensure
          ownership.release
        end
        if finish_ownership(task, ownership, arbiter)
          if arbiter.suspended?
            log(:warn, "workhorse.handler.signal_swallowed", "Task handler swallowed its suspension signal",
              {"workhorse.queue.name" => task.queue}.merge(Telemetry.task_span_attributes(task),
                "workhorse.handler.outcome" => "suspended"))
          end
          return
        end
        complete(task, encoded, arbiter)
      end

      def complete(task, encoded, arbiter)
        accepted = Telemetry.span("workhorse.complete", Telemetry.task_span_attributes(task)) do |span|
          accepted = fenced_row(SqlCatalogue::COMPLETE_V1, task, encoded)["accepted"] == "t"
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

      def finish_lifecycle(task, arbiter)
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

        schema = @lock.synchronize { @contracts[[task.type, version]] }
        if schema.nil?
          rows = @executor.rows(SqlCatalogue::GET_CONTRACT_DEFINITION_V1, [task.type, version])
          raise ContractUnavailableError.new(task.type, version) unless rows.one?

          document = Values.parse_json(rows.first["schema"])
          raise ContractUnavailableError.new(task.type, version) unless document.is_a?(Hash) && document.key?("result")

          schema = ContractSchema.new(document["result"])
          @lock.synchronize { @contracts[[task.type, version]] = schema }
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
