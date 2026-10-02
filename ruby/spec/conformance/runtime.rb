# frozen_string_literal: true

require "connection_pool"
require "json"
require "opentelemetry"
require "pg"

# The error a failures fixture declares by name. It lives at the top level so its class name is
# the bare name the envelope records.
class PaymentDeclined < StandardError; end

module Conformance
  # Drives the failures and runtime fixtures through Stablemates::Workhorse::Worker against a
  # scratch database. Faults are injected around the worker's executor or into installed
  # functions, never into the worker itself.
  class Runtime
    # Runtime fixtures that need a handler surface the Ruby worker does not have yet.
    GAPS = {}.freeze
    CANCEL_NAMES = {
      requested: "CancellationRequestedError",
      deadline_exceeded: "DeadlineExceededError",
      execution_timeout: "ExecutionTimeoutError"
    }.freeze
    ADMISSION_SHARDS = "SELECT pg_advisory_xact_lock(hashtextextended('workhorse:admission-shard:' || $1 || ':' || " \
      "shard, 0)) FROM generate_series(0, 7) AS shard"
    WAITS_ON = "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock' " \
      "AND ($2::text IS NULL OR wait_event = $2::text))"
    STATE = "SELECT state, current_attempt, error->>'name' AS error_name FROM workhorse.task_runtime " \
      "WHERE task_id = $1 UNION ALL SELECT state, current_attempt, error->>'name' FROM workhorse.task_outcome " \
      "WHERE task_id = $1"

    # Records the parent of every span the worker starts while a trace fixture runs.
    class Tracer < ::OpenTelemetry::Trace::Tracer
      attr_reader :spans

      def initialize
        super
        @spans = Concurrent::Array.new
      end

      def start_span(name, with_parent: nil, attributes: nil, kind: nil, **)
        parent = ::OpenTelemetry::Trace.current_span(with_parent).context
        @spans << [name, parent]
        trace_id = parent.valid? ? parent.trace_id : ::OpenTelemetry::Trace.generate_trace_id
        ::OpenTelemetry::Trace.non_recording_span(::OpenTelemetry::Trace::SpanContext.new(trace_id: trace_id))
      end
    end

    class TracerProvider < ::OpenTelemetry::Trace::TracerProvider
      def initialize(tracer)
        super()
        @recorder = tracer
      end

      def tracer(...) = @recorder
    end

    def initialize(url, connection)
      @url = url
      @connection = connection
      @envelope = JSON.parse(File.read(File.join(PROTOCOL, "failures.json"))).fetch("envelope")
    end

    def run(fixture)
      case fixture["kind"]
      when "trace-propagation" then trace(fixture)
      when "cooperative-cancellation" then cancellation(fixture)
      when "expiration" then expiration(fixture)
      when "heartbeat-cadence" then heartbeat_cadence(fixture)
      when "poll-cadence" then poll_cadence(fixture)
      when "graceful-drain" then graceful_drain(fixture)
      when "slot-refill" then slot_refill(fixture)
      when "budget-admission-race" then budget_race(fixture)
      when "missing-handler" then missing_handler(fixture)
      when "json-round-trip" then json_round_trip(fixture)
      when "heartbeat-failure" then heartbeat_failure(fixture)
      when "maintenance-phase-error" then maintenance_phase_error(fixture)
      when "suspension-replay" then suspension_replay(fixture)
      when "lease-loss" then lease_loss(fixture)
      when "batch" then batch(fixture)
      when "replay-conflict" then replay_conflict(fixture)
      else raise Failure, "unknown runtime fixture kind #{Matcher.render(fixture["kind"])}"
      end
    rescue Failure
      raise
    rescue => e
      raise Failure, "#{e.class}: #{e.message}"
    end

    def failure(fixture)
      name = "failures-#{fixture["id"]}"
      task_id = queue.enqueue("protocol.failure", {}, queue: name, max_attempts: 1).task_id
      redacted = fixture["redactErrorDetails"] == true
      if redacted
        @connection.exec_params("UPDATE workhorse.task SET payload_redact_keys = ARRAY['secret'] WHERE id = $1",
          [task_id])
      end
      declared = fixture.fetch("error")
      error = (declared["declaresName"] ? PaymentDeclined : StandardError).new(declared["message"])
      # An error raised with a backtrace already set keeps it, so a stackless error stays stackless.
      error.set_backtrace([]) unless declared["declaresStack"]
      sent = []
      with_pool do |pool|
        subject = W::Worker.new(pool, queues: [name], worker_id: "ruby-#{name}", polling_only: true,
          disable_registry: true).handle("protocol.failure") { raise error }
        # PostgreSQL also redacts, so the envelope is checked before it leaves the worker.
        wrap_rows(subject) do |original, sql, params|
          sent << JSON.parse(params[3]) if sql == W::SqlCatalogue::FAIL_V1
          original.call(sql, params)
        end
        check(subject.run_once == true, "the worker did not run the failing task")
      end
      check(error.backtrace.empty? != declared["declaresStack"],
        "the handler raised #{error.backtrace.empty? ? "no" : "a"} backtrace, want declaresStack " \
        "#{declared["declaresStack"]}")
      check(sent.length == 1, "the worker sent #{sent.length} fail_v1 calls, want 1")
      stored = JSON.parse(value("SELECT error FROM workhorse.task_outcome WHERE task_id = $1", task_id))
      [["sent", sent.first], ["stored", stored]].each { |label, envelope| failure_envelope(fixture, label, envelope) }
    end

    private

    def failure_envelope(fixture, label, stored)
      redacted = fixture["redactErrorDetails"] == true
      fields = @envelope.fetch(redacted ? "redactedFields" : "fields")
      check(stored.keys.sort == fields.sort, "#{label} envelope fields #{stored.keys.sort}, want #{fields.sort}")
      expected = fixture.fetch("envelope")
      want = expected["name"]
      want = @envelope.dig("genericName", "ruby") if want == "$generic"
      check(stored["name"] == want, "#{label} envelope name #{Matcher.render(stored["name"])}, want #{want}")
      check(stored["message"] == expected["message"],
        "#{label} envelope message #{Matcher.render(stored["message"])}, want #{Matcher.render(expected["message"])}")
      case expected["stack"]
      when "string"
        check(stored["stack"].is_a?(String) && !stored["stack"].empty?, "#{label} envelope stack is not a string")
      when "stringOrNull"
        check(stored["stack"].nil? || stored["stack"].is_a?(String), "#{label} envelope stack is neither a string nor null")
      end
      @envelope.fetch("forbiddenNameCharacters").each do |character|
        check(!stored["name"].to_s.include?(character), "#{label} envelope name #{stored["name"]} contains #{character}")
      end
    end

    # ----- fixtures ------------------------------------------------------------------------------

    def trace(fixture)
      recorder = Tracer.new
      provider = TracerProvider.new(recorder)
      caller_span = ::OpenTelemetry::Trace::SpanContext.new
      ::OpenTelemetry.define_singleton_method(:tracer_provider) { provider }
      begin
        context = ::OpenTelemetry::Trace.context_with_span(::OpenTelemetry::Trace.non_recording_span(caller_span))
        task_id = ::OpenTelemetry::Context.with_current(context) do
          queue.enqueue(fixture["taskType"], {}, queue: queue_name(fixture)).task_id
        end
        carrier = JSON.parse(value("SELECT trace_context FROM workhorse.task WHERE id = $1", task_id) || "null")
        traceparent = carrier.is_a?(Hash) ? carrier["traceparent"].to_s : ""
        check(traceparent.split("-")[1] == caller_span.hex_trace_id, "enqueue stored no caller trace context")
        with_pool do |pool|
          check(worker(pool, fixture).handle(fixture["taskType"]) { nil }.run_once == true,
            "the worker did not run the traced task")
        end
      ensure
        ::OpenTelemetry.singleton_class.send(:remove_method, :tracer_provider)
      end
      parents = recorder.spans.filter_map { |name, parent| parent if name == "workhorse.handler" }
      check(parents.length == 1, "recorded #{parents.length} handler spans, want 1")
      parent = parents.first
      check(parent.hex_trace_id == caller_span.hex_trace_id, "the handler span left the enqueuing trace")
      check(parent.hex_span_id == traceparent.split("-")[2], "the handler span's parent is not the stored context")
    end

    def cancellation(fixture)
      task_id = queue.enqueue(fixture["taskType"], {}, queue: queue_name(fixture)).task_id
      started = Concurrent::Event.new
      reasons = Concurrent::Array.new
      with_pool do |pool|
        subject = worker(pool, fixture, lease: fixture["leaseMs"] / 1000.0, heartbeat: fixture["heartbeatMs"] / 1000.0,
          shared_heartbeats: true).handle(fixture["taskType"]) do |_payload, context|
          started.set
          raise "the cancellation never reached the handler" unless context.cancellation.wait(5)

          reasons << CANCEL_NAMES[context.cancellation.reason]
          context.cancellation.check!
        end
        running(-> { subject.run_once }) do |result|
          check(started.wait(5), "the handler never started")
          cancel = queue.cancel(task_id, requested_by: "runtime-fixture", reason: fixture["cancelReason"])
          check(cancel.status == :cancel_requested, "cancel returned #{cancel.status}")
          check(result.call == true, "the worker did not report the cancelled run")
        end
      end
      check(reasons.to_a == [fixture["expectedAbortReason"]], "abort reasons #{reasons.to_a}")
      expect_state(task_id, fixture["expectedState"])
      expect_outcomes(task_id, [fixture["expectedAttemptOutcome"]])
    end

    def expiration(fixture)
      deadline = fixture["mode"] == "deadline"
      options = {queue: queue_name(fixture), max_attempts: fixture["maxAttempts"],
                 retry_policy: {"type" => "fixed", "delayMs" => 0}}
      # The deadline budget starts after the claim, inside the claim wrapper. The placeholder only
      # has to be far enough away that the claim never skips the task.
      if deadline
        options[:deadline] = Time.now + 3600
      else
        options[:execution_timeout] = fixture["durationMs"] / 1000.0
      end
      task_id = queue.enqueue(fixture["taskType"], {}, **options).task_id
      reasons = Concurrent::Array.new
      with_pool do |pool|
        subject = worker(pool, fixture, lease: fixture["leaseMs"] / 1000.0, heartbeat: fixture["heartbeatMs"] / 1000.0,
          shared_heartbeats: true)
        subject.handle(fixture["taskType"]) do |_payload, context|
          raise "the expiration never reached the handler" unless context.cancellation.wait(5)

          reasons << CANCEL_NAMES[context.cancellation.reason]
          subject.pause
          context.cancellation.check!
        end
        # The local timer reads the claimed row, so shifting it models a clock that runs ahead of
        # or behind PostgreSQL.
        wrap_rows(subject) do |original, sql, params|
          rows = original.call(sql, params)
          next rows unless sql == W::SqlCatalogue::CLAIM_MANY_V1 && rows.any?

          field = deadline ? "deadline_at" : "attempt_timeout_at"
          anchor = if deadline
            value("UPDATE workhorse.task_runtime SET deadline_at = clock_timestamp() + ($1 * interval " \
              "'1 millisecond') WHERE task_id = $2 RETURNING deadline_at::text", fixture["durationMs"], task_id)
          else
            rows.first.fetch(field)
          end
          shifted = value("SELECT ($1::timestamptz - $2 * interval '1 millisecond')::text", anchor,
            fixture["localClockLeadMs"])
          [rows.first.merge(field => shifted)]
        end
        fixture["expectedAfterRuns"].each_with_index do |expected, index|
          await_heartbeat_idle(subject)
          subject.resume
          check(subject.run_once == true, "run #{index + 1} did not run the task")
          expect_state(task_id, expected)
        end
      end
      check(reasons.to_a == fixture["expectedAbortReasons"], "abort reasons #{reasons.to_a}")
      expect_outcomes(task_id, fixture["expectedAttemptOutcomes"])
    end

    def heartbeat_cadence(fixture)
      queue.enqueue(fixture["taskType"], {}, queue: queue_name(fixture))
      handler_started = Concurrent::Event.new
      release_handler = Concurrent::Event.new
      first_started = Concurrent::Event.new
      release_first = Concurrent::Event.new
      lock = Mutex.new
      counts = {calls: 0, active: 0, overlap: 0}
      calls = -> { lock.synchronize { counts[:calls] } }
      with_pool do |pool|
        subject = worker(pool, fixture, lease: fixture["leaseMs"] / 1000.0, heartbeat: fixture["heartbeatMs"] / 1000.0,
          shared_heartbeats: true).handle(fixture["taskType"]) do
          handler_started.set
          raise "the handler was never released" unless release_handler.wait(5)
        end
        wrap_rows(subject) do |original, sql, params|
          next original.call(sql, params) unless sql == W::SqlCatalogue::HEARTBEAT_MANY_V1

          call = lock.synchronize do
            counts[:calls] += 1
            counts[:active] += 1
            counts[:overlap] = [counts[:overlap], counts[:active]].max
            counts[:calls]
          end
          begin
            if call == 1
              first_started.set
              raise "the first heartbeat was never released" unless release_first.wait(5)
            end
            original.call(sql, params)
          ensure
            lock.synchronize { counts[:active] -= 1 }
          end
        end
        running(-> { subject.run_once }) do |result|
          check(handler_started.wait(5), "the handler never started")
          check(first_started.wait(5), "no heartbeat started")
          sleep(fixture["heartbeatMs"] * 3 / 1000.0)
          check(calls.call == fixture["expectedCallsWhileBlocked"], "#{calls.call} heartbeats started while one was blocked")
          release_first.set
          eventually("no heartbeat followed the blocked one") do
            calls.call >= fixture["expectedMinimumCallsBeforeSettlement"]
          end
          overlap = lock.synchronize { counts[:overlap] }
          check(overlap == fixture["expectedMaximumOverlap"], "#{overlap} heartbeats overlapped")
          release_handler.set
          check(result.call == true, "the worker did not run the task")
        ensure
          release_first.set
          release_handler.set
        end
        settled = calls.call
        sleep(fixture["heartbeatMs"] * 3 / 1000.0)
        check(calls.call == settled, "heartbeats continued after the attempt settled")
      end
    end

    # Holds the worker after each empty claim until the driver releases it, so an uncounted poll
    # cannot advance the backoff step the delay is measured against.
    def poll_cadence(fixture)
      name = queue_name(fixture)
      reached = ::Queue.new
      released = ::Queue.new
      holding = Concurrent::AtomicBoolean.new(true)
      handled_at = Concurrent::AtomicReference.new
      handled = Concurrent::Event.new
      maximum = fixture["expectedMaximumDelayMs"] / 1000.0
      with_pool do |pool|
        subject = worker(pool, fixture, poll_interval: fixture["pollMs"] / 1000.0).handle(fixture["taskType"]) do
          handled_at.set(monotonic)
          handled.set
          nil
        end
        wrap_rows(subject) do |original, sql, params|
          rows = original.call(sql, params)
          if sql == W::SqlCatalogue::CLAIM_MANY_V1 && rows.empty? && holding.true?
            reached << true
            released.pop(timeout: 5)
          end
          rows
        end
        thread = Thread.new { subject.run }
        begin
          enqueued_at = nil
          1.upto(fixture["emptyPollsBeforeEnqueue"]) do |poll|
            check(reached.pop(timeout: maximum + 1), "the worker did not complete empty poll #{poll}")
            if poll == fixture["emptyPollsBeforeEnqueue"]
              # A stall longer than one backoff step changes nothing for a held worker.
              sleep(fixture["enqueueStallMs"] / 1000.0)
              queue.enqueue(fixture["taskType"], {}, queue: name)
              enqueued_at = monotonic
              holding.make_false
            end
            released << true
          end
          check(handled.wait(maximum + 1), "the worker never ran the enqueued task")
          delay = (handled_at.get - enqueued_at) * 1000
          check(delay.between?(fixture["expectedMinimumDelayMs"], fixture["expectedMaximumDelayMs"]),
            "the task ran #{delay.round} ms after enqueue")
        ensure
          holding.make_false
          released << true
          subject.stop
          check(thread.join(10), "the worker did not stop")
        end
      end
    end

    def graceful_drain(fixture)
      name = queue_name(fixture)
      task_ids = Array.new(fixture["taskCount"]) do |sequence|
        queue.enqueue(fixture["taskType"], {"sequence" => sequence}, queue: name).task_id
      end
      release = Concurrent::Event.new
      with_pool do |pool|
        subject = worker(pool, fixture, concurrency: fixture["concurrency"], poll_interval: 5)
          .handle(fixture["taskType"]) { raise "the handler was never released" unless release.wait(5) }
        thread = Thread.new { subject.run }
        begin
          eventually("the worker did not fill its slots") { active(subject) == fixture["expectedActiveAtStop"] }
          subject.stop
          check(active(subject) == fixture["expectedActiveAtStop"], "stop abandoned an active slot")
          sleep(fixture["settleCheckMs"] / 1000.0)
          check(thread.alive?, "run returned before its handlers finished")
        ensure
          release.set
          subject.stop
          check(thread.join(10), "the worker did not drain")
        end
        thread.value
        check(active(subject).zero?, "slots remain active after the drain")
      end
      states = task_ids.map { |task_id| state(task_id)["state"] }
      check(states.count("succeeded") == fixture["expectedSucceeded"], "states after the drain: #{states}")
      check(states.count("ready") == fixture["expectedReady"], "states after the drain: #{states}")
    end

    # The batch handler pauses the worker, so each run_once delivers one batch. The retrying task
    # fails its first attempt and succeeds on the next run.
    def batch(fixture)
      name = queue_name(fixture)
      task_ids = fixture.fetch("tasks").to_h do |task|
        [task["key"], queue.enqueue(fixture["taskType"], {"key" => task["key"], "outcome" => task["outcome"]},
          queue: name, priority: task["priority"], max_attempts: task["maxAttempts"],
          retry_policy: {"type" => "fixed", "delayMs" => 0}).task_id]
      end
      seen = Concurrent::Array.new
      with_pool do |pool|
        subject = worker(pool, fixture, concurrency: fixture["concurrency"])
        subject.handle_batch(fixture["taskType"], max_size: fixture["batchMaxSize"], linger: 0.1) do |items|
          seen.concat(items.map { |item| item.payload["key"] })
          subject.pause
          items.map do |item|
            payload = item.payload
            task = item.context.task
            if payload["outcome"] == "succeed" || task.attempt > 1
              {status: :succeeded, result: {"attempt" => task.attempt}}
            else
              {status: :failed, error: RuntimeError.new("#{payload["outcome"]} on attempt #{task.attempt}")}
            end
          end
        end
        check(subject.run_once == true, "the first run delivered no batch")
        check(seen == fixture["expectedHandlerOrder"], "handler order #{seen}, want #{fixture["expectedHandlerOrder"]}")
        batch_states(task_ids, fixture["expectedAfterFirstRun"], "first")
        subject.resume
        check(subject.run_once == true, "the second run delivered no batch")
        batch_states(task_ids, fixture["expectedAfterSecondRun"], "second")
      end
    end

    def slot_refill(fixture)
      name = queue_name(fixture)
      task_ids = Array.new(fixture["taskCount"]) do |sequence|
        queue.enqueue(fixture["taskType"], {"sequence" => sequence}, queue: name).task_id
      end
      lock = Mutex.new
      claims = {limits: [], with_tasks: 0, in_flight: 0, maximum: 0, holding: false, held: []}
      # +running+ and +peak+ count handler bodies, so the whole run shows concurrency is never exceeded.
      handlers = {started: [], open: false, running: 0, peak: 0}
      release_held = lambda do
        held = lock.synchronize do
          claims[:holding] = false
          claims.fetch(:held).slice!(0..)
        end
        held.each(&:set)
      end
      open_all = lambda do
        waiting = lock.synchronize do
          handlers[:open] = true
          handlers.fetch(:started).slice!(0..)
        end
        waiting.each(&:set)
      end
      finish_first = -> { lock.synchronize { handlers.fetch(:started).shift }.set }
      started = -> { lock.synchronize { handlers.fetch(:started).length } }
      claim_count = -> { lock.synchronize { claims.fetch(:limits).length } }
      with_pool(6) do |pool|
        subject = worker(pool, fixture, concurrency: fixture["concurrency"], shared_heartbeats: true)
          .handle(fixture["taskType"]) do
          finished = Concurrent::Event.new
          blocked = lock.synchronize do
            handlers[:running] += 1
            handlers[:peak] = [handlers[:peak], handlers[:running]].max
            handlers.fetch(:started) << finished unless handlers[:open]
            !handlers[:open]
          end
          begin
            raise "the handler was never finished" if blocked && !finished.wait(10)
          ensure
            lock.synchronize { handlers[:running] -= 1 }
          end
        end
        # Holding a claim keeps it in flight, so the next claim is observed while the first is open.
        wrap_rows(subject) do |original, sql, params|
          next original.call(sql, params) unless sql == W::SqlCatalogue::CLAIM_MANY_V1

          release = Concurrent::Event.new
          lock.synchronize do
            claims.fetch(:limits) << Integer(params[2], 10)
            claims[:in_flight] += 1
            claims[:maximum] = [claims[:maximum], claims[:in_flight]].max
            claims[:holding] ? claims.fetch(:held) << release : release.set
          end
          begin
            raise "a held claim was never released" unless release.wait(10)

            rows = original.call(sql, params)
            lock.synchronize { claims[:with_tasks] += 1 } if rows.any?
            rows
          ensure
            lock.synchronize { claims[:in_flight] -= 1 }
          end
        end
        thread = Thread.new { subject.run }
        begin
          eventually("the worker did not fill its slots") { started.call == fixture["concurrency"] }
          lock.synchronize { claims[:holding] = true }
          1.upto(3) do |finished|
            finish_first.call
            if finished == 2
              # One more free slot is below the refill batch while the first refill is held.
              sleep(fixture["settleCheckMs"] / 1000.0)
              check(claim_count.call == 2, "a single free slot started claim #{claim_count.call}")
            else
              expected = (finished == 1) ? 2 : 3
              eventually("the worker did not start claim #{expected}") { claim_count.call >= expected }
            end
          end
          limits, maximum = lock.synchronize { [claims.fetch(:limits).dup, claims[:maximum]] }
          check(limits == fixture["expectedClaimLimits"], "claim limits #{limits}")
          check(maximum == fixture["expectedOverlappingClaims"], "#{maximum} claims overlapped")
          release_held.call
          open_all.call
          eventually("the worker did not run every task", 20) do
            task_ids.all? { |task_id| state(task_id)["state"] == "succeeded" }
          end
          ratio = lock.synchronize { claims[:with_tasks] } / fixture["taskCount"].to_f
          check(ratio <= fixture["expectedMaximumClaimsPerTask"], "#{ratio} claims per task")
          peak = lock.synchronize { handlers[:peak] }
          check(peak == fixture["concurrency"], "#{peak} handlers ran at once with concurrency #{fixture["concurrency"]}")
        ensure
          release_held.call
          open_all.call
          subject.stop
          check(thread.join(10), "the worker did not stop")
        end
      end
    end

    # Commits a budgeted task on one queue while that queue's claim is already past its first read.
    # A test session parks the late claim on its queue's admission shards. Mirrors
    # typescript/core/test/support/budget-race.ts.
    def budget_race(fixture)
      name = queue_name(fixture)
      late_queue = "#{name}-late"
      holder_queue = "#{name}-holder"
      rate = fixture.fetch("queueRate")
      lease = fixture["leaseMs"].to_s
      queue.sync_budgets(name, [W::BudgetDefinition.new(name: name, max_active: fixture["maxActive"])])
      queue.sync_rate_limit_policies(name, [W::RateLimitPolicyDefinition.new(queue: late_queue,
        rate: W::RateLimit.new(limit: rate["limit"], interval: rate["intervalMs"] / 1000.0, burst: rate["burst"]))])
      # One unbudgeted start proves the late queue admits before the blocker parks its claim.
      queue.enqueue(fixture["taskType"], {"role" => "bucket"}, queue: late_queue)
      bucket = @connection.exec_params(W::SqlCatalogue::CLAIM_V1, [late_queue, "#{name}-bucket", lease]).ntuples
      check(bucket == 1, "the late queue did not admit its unbudgeted start")
      queue.enqueue(fixture["taskType"], {"role" => "holder"}, queue: holder_queue, budget: name)

      sessions = Array.new(3) { PG.connect(@url, connect_timeout: ScratchDatabase::CONNECT_TIMEOUT) }
      blocker, late, holder = sessions
      late_thread = nil
      begin
        late_pid = late.backend_pid
        blocker.exec("BEGIN")
        blocker.exec_params(ADMISSION_SHARDS, [late_queue])
        late_thread = Thread.new { late.exec_params(W::SqlCatalogue::CLAIM_V1, [late_queue, "#{name}-late", lease]).ntuples }
        eventually("the late claim never reached the admission shards") { waits_on(late_pid, nil) }
        queue.enqueue(fixture["taskType"], {"role" => "late"}, queue: late_queue, budget: name)
        holder.exec("BEGIN")
        holder_claims = holder.exec_params(W::SqlCatalogue::CLAIM_V1, [holder_queue, "#{name}-holder", lease]).ntuples
        blocker.exec("COMMIT")
        eventually("the late claim neither finished nor waited for the budget") do
          !late_thread.alive? || waits_on(late_pid, "advisory")
        end
        holder.exec("COMMIT")
        check(late_thread.join(10), "the late claim did not finish")
        late_claims = late_thread.value
        active = Integer(value("SELECT count(*) FROM workhorse.task_runtime WHERE state = 'active' AND " \
          "budget_name = $1", name), 10)
        check(holder_claims == fixture["expectedHolderClaims"], "the holder claimed #{holder_claims}")
        check(late_claims == fixture["expectedLateClaims"], "the late claim admitted #{late_claims}")
        check(active == fixture["expectedActive"], "#{active} budgeted tasks are active")
      ensure
        [blocker, holder].each do |session|
          session.exec("ROLLBACK") unless session.transaction_status == PG::PQTRANS_IDLE
        rescue PG::Error
          nil
        end
        late_thread&.join(10)
        sessions.each(&:close)
      end
    end

    def replay_conflict(fixture)
      fixture.fetch("cases").each do |entry|
        name = "#{queue_name(fixture)}-#{entry["errorKind"]}"
        task_id = queue.enqueue(fixture["taskType"], {}, queue: name, max_attempts: fixture["maxAttempts"]).task_id
        @connection.exec_params("UPDATE workhorse.task SET payload_redact_keys = ARRAY['secret'] WHERE id=$1", [task_id]) if entry["redactErrorDetails"]
        delay_calls = 0
        with_pool do |pool|
          subject = W::Worker.new(pool, queues: [name], polling_only: true, disable_registry: true,
            retry_delay: ->(*) {
              delay_calls += 1
              60
            })
            .handle(fixture["taskType"]) do
              operation = {"checkpoint" => :checkpoint, "wait" => :sleep, "child" => :run_child,
                           "redacted-child" => :run_child, "child-set" => :run_children, "human" => :wait_for_human}
              case entry["errorKind"]
              when "child-limit" then raise W::LimitExceededError.new(:run_child, "saved")
              when "signal-wait" then raise W::AlreadyWaitingError.new(:wait_for_signal, "saved")
              when "transient" then raise StandardError, "transient"
              else raise W::ConflictError.new(operation.fetch(entry["errorKind"]), "saved")
              end
            end
          check(subject.run_once == true, "conflict handler did not run")
        end
        expect_state(task_id, {"state" => entry["expectedState"], "attempt" => entry["expectedAttempt"],
          "errorName" => entry["expectedErrorNames"]["ruby"]})
        terminal = entry["expectedState"] == "failed"
        check(delay_calls == (terminal ? 0 : 1), "retry callback called #{delay_calls} times")
        outcomes = @connection.exec_params("SELECT outcome FROM workhorse.attempt_history WHERE task_id = $1", [task_id])
          .map { |row| row["outcome"] }
        check(outcomes == [terminal ? "failed" : "retry"], "attempt outcomes #{outcomes}")
      end
    end

    def missing_handler(fixture)
      name = queue_name(fixture)
      task_id = queue.enqueue(fixture["taskType"], {"index" => 1}, queue: name).task_id
      handled = Concurrent::Array.new
      with_pool do |pool|
        older = W::Worker.new(pool, queues: [name], worker_id: "ruby-#{fixture["id"]}-older", polling_only: true,
          disable_registry: true, lease: fixture["leaseMs"] / 1000.0, poll_interval: fixture["pollMs"] / 1000.0)
          .handle(fixture["registeredTaskType"]) { nil }
        older.run_once
        expect_state(task_id, fixture["expectedAfterRelease"])
        attempts = Integer(value("SELECT count(*) FROM workhorse.attempt_history WHERE task_id = $1", task_id), 10)
        releases = Integer(value("SELECT count(*) FROM workhorse.task_event WHERE task_id = $1 AND " \
          "event_type = 'released'", task_id), 10)
        # The refusal belongs to no attempt, so the task keeps the attempt it was enqueued with.
        check(attempts == fixture["expectedAttempts"], "the release recorded #{attempts} attempts")
        check(releases == fixture["expectedReleaseEvents"], "the release recorded #{releases} events")
        # The released task is ready again, so a worker that reported the release as progress would
        # claim and release it without waiting.
        processed = fixture["expectedRunOutcomeAfterRelease"] != "unprocessed"
        check(older.run_once == processed, "the pass after the release reported progress")

        newer = W::Worker.new(pool, queues: [name], worker_id: "ruby-#{fixture["id"]}-newer", polling_only: true,
          disable_registry: true, lease: fixture["leaseMs"] / 1000.0).handle(fixture["taskType"]) do |payload|
          handled << payload
          nil
        end
        check(newer.run_once == true, "the registered worker did not run the task")
      end
      check(handled.to_a == [{"index" => 1}], "the handler received #{handled.to_a}")
      expect_state(task_id, fixture["expectedAfterHandled"])
    end

    def json_round_trip(fixture)
      payload = fixture.fetch("payload")
      task_id = queue.enqueue(fixture["taskType"], payload, queue: queue_name(fixture)).task_id
      received = Concurrent::Array.new
      with_pool do |pool|
        subject = worker(pool, fixture).handle(fixture["taskType"]) do |handled|
          received << handled
          handled
        end
        check(subject.run_once == true, "the worker did not run the task")
      end
      check(received.to_a == [payload], "the handler received #{Matcher.render(received.to_a)}")
      stored = JSON.parse(value("SELECT payload FROM workhorse.task WHERE id = $1", task_id))
      check(stored == payload, "the stored payload is #{Matcher.render(stored)}")
      result = JSON.parse(value("SELECT result FROM workhorse.task_outcome WHERE task_id = $1", task_id))
      check(result == payload, "the stored result is #{Matcher.render(result)}")
      expect_state(task_id, fixture["expectedState"])
      expect_outcomes(task_id, [fixture["expectedAttemptOutcome"]])
    end

    def heartbeat_failure(fixture)
      task_id = queue.enqueue(fixture["taskType"], {}, queue: queue_name(fixture)).task_id
      started = Concurrent::Event.new
      release = Concurrent::Event.new
      cancellations = Concurrent::Array.new
      timeout = fixture["renewalTimeoutMs"] / 1000.0
      with_pool do |pool|
        subject = worker(pool, fixture, lease: fixture["leaseMs"] / 1000.0, heartbeat: fixture["heartbeatMs"] / 1000.0)
          .handle(fixture["taskType"]) do |_payload, context|
          started.set
          raise "the handler was never released" unless release.wait(10)

          cancellations << task_id if context.cancellation.cancelled?
          nil
        end
        running(-> { subject.run_once }) do |result|
          check(started.wait(5), "the handler never started")
          renewed = renewal(task_id, expiry(task_id), timeout)
          injected(fixture.fetch("injection")) do |failed_calls|
            eventually("fewer than #{fixture["expectedMinimumFailedRounds"]} heartbeat rounds failed", timeout) do
              failed_calls.call >= fixture["expectedMinimumFailedRounds"]
            end
            renewed = expiry(task_id)
          end
          # Once the rounds answer again the lease renews, so the failures cost the attempt nothing.
          renewal(task_id, renewed, timeout)
          release.set
          check(result.call == true, "the worker did not run the task")
        ensure
          release.set
        end
      end
      check(cancellations.length == fixture["expectedCancellations"], "the handler saw a cancellation")
      expect_state(task_id, fixture["expectedState"])
      expect_outcomes(task_id, [fixture["expectedAttemptOutcome"]])
    end

    def maintenance_phase_error(fixture)
      injection = fixture.fetch("injection")
      # tick_v1 returns a phase failure as data, so a raising promote_v1 models a lock timeout
      # inside the promote phase.
      injected(injection) do
        task_id = queue.enqueue(fixture["taskType"], {}, queue: queue_name(fixture)).task_id
        ticks = []
        with_pool do |pool|
          subject = worker(pool, fixture, maintenance_interval: 0.1).handle(fixture["taskType"]) { nil }
          wrap_rows(subject) do |original, sql, params|
            rows = original.call(sql, params)
            ticks << rows if sql == W::SqlCatalogue::TICK_V1
            rows
          end
          # The failing phase runs on this pass, and the pass still claims and settles the task.
          check(subject.run_once == true, "the worker did not run the task")
        end
        check(ticks.length == 1, "the worker ran #{ticks.length} ticks, want 1")
        error = ticks.first.find { |row| row["phase"] == fixture["expectedPhase"] }&.fetch("error")
        check(error.to_s.include?(injection["message"]), "the worker's tick reported #{Matcher.render(error)}")
        expect_state(task_id, fixture["expectedState"])
      end
    end

    def suspension_replay(fixture)
      name = queue_name(fixture)
      task_ids = {"suspension" => queue.enqueue(fixture["taskType"], {}, queue: name).task_id,
                  "following" => queue.enqueue(fixture["followingTaskType"], {}, queue: name).task_id}
      seen = Concurrent::Array.new
      counts = Concurrent::Hash.new(0)
      with_pool do |pool|
        subject = worker(pool, fixture, maintenance_interval: 0.1)
        subject.handle(fixture["taskType"]) do |_payload, context|
          counts[:runs] += 1
          seen << "suspension:#{context.task.attempt}"
          prepared = context.checkpoint(fixture["checkpointName"]) { {"operation" => counts[:operations] += 1} }
          subject.pause if counts[:runs] == 1
          context.sleep(fixture["waitName"], fixture["waitMs"] / 1000.0)
          {"prepared" => prepared, "handlerRuns" => counts[:runs]}
        end
        subject.handle(fixture["followingTaskType"]) do |_payload, context|
          seen << "following:#{context.task.attempt}"
          {"handled" => true}
        end
        check(subject.run_once == true, "the worker did not run the suspending task")
        expect_states(task_ids, fixture["expectedAfterSuspension"])
        expect_attempts(task_ids["suspension"], fixture["expectedAttemptsAfterSuspension"])
        subject.resume
        check(subject.run_once == true, "the released slot did not run the following task")
        expect_states(task_ids, fixture["expectedAfterSlotRelease"])
        # The wait is long enough that it cannot elapse on a slow runner, so the fixture rewinds it
        # and promotes it instead of sleeping through it.
        @connection.exec_params("UPDATE workhorse.task_runtime SET run_at = clock_timestamp() - " \
          "interval '1 millisecond' WHERE task_id = $1", [task_ids["suspension"]])
        @connection.exec("SELECT * FROM workhorse.tick_v1(100, 100)")
        check(subject.run_once == true, "the worker did not replay the woken task")
        expect_states(task_ids, fixture["expectedAfterReplay"])
      end
      expect_attempts(task_ids["suspension"], fixture["expectedAttemptsAfterReplay"])
      check(seen.to_a == fixture["expectedHandlerOrder"], "handler order #{seen.to_a}")
      check(counts[:runs] == fixture["expectedHandlerRuns"], "the handler ran #{counts[:runs]} times")
      check(counts[:operations] == fixture["expectedCheckpointOperations"],
        "the checkpoint operation ran #{counts[:operations]} times")
    end

    def lease_loss(fixture)
      task_id = queue.enqueue(fixture["taskType"], {}, queue: queue_name(fixture), max_attempts: fixture["maxAttempts"],
        retry_policy: {"type" => "fixed", "delayMs" => 0}).task_id
      started = Concurrent::Event.new
      reasons = Concurrent::Array.new
      rejected = Concurrent::Array.new
      with_pool do |pool|
        subject = worker(pool, fixture, lease: fixture["leaseMs"] / 1000.0, heartbeat: fixture["heartbeatMs"] / 1000.0)
        subject.handle(fixture["taskType"]) do |_payload, context|
          started.set
          raise "the lease loss never reached the handler" unless context.cancellation.wait(5)

          reasons << context.cancellation.reason
          late_writes(context).each do |write, call|
            call.call
          rescue W::LeaseLostError
            rejected << write
          end
          # The worker survives the loss and would claim the retried attempt next, so claims pause
          # to keep the ready state observable.
          subject.pause
          {"late" => true}
        end
        running(-> { subject.run_once }) do |result|
          check(started.wait(5), "the handler never started")
          @connection.exec_params("UPDATE workhorse.task_runtime SET expires_at = clock_timestamp() - " \
            "interval '1 millisecond' WHERE task_id = $1", [task_id])
          recovered = value("SELECT rows_affected FROM workhorse.recover_expired_telemetry_v1(100, 0)")
          check(recovered == "1", "recovery expired #{Matcher.render(recovered)} leases, want 1")
          check(result.call == true, "the worker did not report the lost run")
        end
      end
      check(fixture["expectedRunOutcome"] == "processed", "unexpected run outcome #{fixture["expectedRunOutcome"]}")
      check(reasons.to_a == [:lease_lost], "abort reasons #{reasons.to_a}")
      check(rejected.to_a == fixture["portableRejectedWrites"], "rejected writes #{rejected.to_a}")
      expect_state(task_id, fixture["expectedState"])
      expect_outcomes(task_id, [fixture["expectedAttemptOutcome"]])
    end

    # ----- support -------------------------------------------------------------------------------

    def queue = @queue ||= W::Queue.new(@connection)

    def queue_name(fixture) = "runtime-#{fixture["id"]}"

    def worker(pool, fixture, **options)
      W::Worker.new(pool, queues: [queue_name(fixture)], worker_id: "ruby-#{fixture["id"]}", polling_only: true,
        disable_registry: true, poll_interval: 0.005, **options)
    end

    def with_pool(size = 4)
      pool = ConnectionPool.new(size: size, timeout: 5) do
        PG.connect(@url, connect_timeout: ScratchDatabase::CONNECT_TIMEOUT)
      end
      yield pool
    ensure
      pool&.shutdown(&:close)
    end

    # Waits until no heartbeat round from an earlier attempt is still running. Such a round can
    # begin before that attempt settles, and it holds the task's row lock until it ends. The claim
    # skips a locked row, so a run that starts during that round finds no task to claim.
    def await_heartbeat_idle(subject)
      thread = subject.instance_variable_get(:@heartbeat).instance_variable_get(:@thread)
      check(thread.nil? || !thread.join(5).nil?, "a heartbeat round outlived the previous attempt")
    end

    # Replaces the worker's executor calls with +block+, which receives the original call.
    def wrap_rows(subject, &block)
      executor = subject.instance_variable_get(:@executor)
      original = executor.method(:rows)
      executor.define_singleton_method(:rows) { |sql, params = []| block.call(original, sql, params) }
    end

    # Runs +action+ on a thread and yields a reader for its result. The reader re-raises the
    # thread's error, and the thread never outlives the block.
    def running(action)
      thread = Thread.new(&action)
      thread.report_on_exception = false
      yield lambda {
        check(thread.join(10), "the worker run did not return")
        thread.value
      }
    ensure
      thread&.join(10)
    end

    # Replaces one installed function with a raising body, and restores it afterwards. The
    # exception rolls the call back, so only a sequence carries the count of raised calls out.
    def injected(injection)
      original = value("SELECT pg_get_functiondef($1::regprocedure)", injection["function"])
      sequence = injection["counterSequence"]
      @connection.exec("CREATE SEQUENCE #{sequence} MINVALUE 0 START 0") if sequence
      count = sequence ? "PERFORM nextval('#{sequence}');" : ""
      @connection.exec(<<~SQL)
        CREATE OR REPLACE FUNCTION #{injection["header"]} LANGUAGE plpgsql AS $injected$
        BEGIN
          #{count}
          RAISE EXCEPTION '#{injection["message"]}' USING ERRCODE = '#{injection["errorCode"]}';
        END;
        $injected$
      SQL
      yield(-> { sequence ? Integer(value("SELECT last_value FROM #{sequence}"), 10) : 0 })
    ensure
      @connection.exec(original) if original
      @connection.exec("DROP SEQUENCE IF EXISTS #{sequence}") if sequence
    end

    def expiry(task_id)
      text = value("SELECT expires_at::text FROM workhorse.task_runtime WHERE task_id = $1", task_id)
      check(text, "task #{task_id} holds no lease")
      Database::TIMESTAMPTZ_DECODER.decode(text)
    end

    def renewal(task_id, previous, timeout)
      renewed = nil
      eventually("the lease of #{task_id} was not renewed", timeout) { (renewed = expiry(task_id)) > previous }
      renewed
    end

    def waits_on(pid, lock) = value(WAITS_ON, pid, lock) == "t"

    def active(subject) = subject.instance_variable_get(:@active).size

    def batch_states(task_ids, expected, run)
      expected.each do |key, want|
        got = state(task_ids.fetch(key)).slice("state", "attempt")
        check(got == want, "after the #{run} run #{key} is #{got}, want #{want}")
      end
    end

    def state(task_id)
      result = @connection.exec_params(STATE, [task_id])
      check(result.ntuples == 1, "task #{task_id} has #{result.ntuples} state rows")
      row = result[0]
      {"state" => row["state"], "attempt" => Integer(row["current_attempt"], 10), "errorName" => row["error_name"]}
    end

    def expect_state(task_id, expected)
      actual = state(task_id)
      want = {"state" => expected["state"], "attempt" => expected["attempt"]}
      want["errorName"] = expected["errorName"] if expected.key?("errorName")
      check(actual.slice(*want.keys) == want, "task state #{actual}, want #{want}")
    end

    # Each durable write a handler may attempt after its lease is gone, by its portable name.
    def late_writes(context)
      child = ["too-late", "protocol.child", {}]
      {"checkpoint" => -> { context.checkpoint("too-late") { {"late" => true} } },
       "sleep" => -> { context.sleep("too-late", 0.001) },
       "sleepUntil" => -> { context.sleep_until("too-late-until", Time.now) },
       "waitForSignal" => -> { context.wait_for_signal("too-late") },
       "waitForHuman" => -> { context.wait_for_human("too-late", {"late" => true}) },
       "runChild" => -> { context.run_child(*child) },
       "runChildren" => lambda {
         context.run_children([W::ChildTaskRequest.new(name: child[0], task_type: child[1], payload: child[2])])
       }}
    end

    def expect_states(task_ids, expected)
      expected.each { |key, want| expect_state(task_ids.fetch(key), want) }
    end

    def expect_attempts(task_id, expected)
      count = Integer(value("SELECT count(*) FROM workhorse.attempt_history WHERE task_id = $1", task_id), 10)
      check(count == expected, "task #{task_id} recorded #{count} attempts, want #{expected}")
    end

    def expect_outcomes(task_id, expected)
      outcomes = @connection.exec_params("SELECT outcome::text FROM workhorse.attempt_history WHERE task_id = $1 " \
        "ORDER BY attempt", [task_id]).column_values(0)
      check(outcomes == expected, "attempt outcomes #{outcomes}, want #{expected}")
    end

    def value(sql, *params)
      result = @connection.exec_params(sql, params)
      (result.ntuples == 1) ? result.getvalue(0, 0) : nil
    end

    def eventually(message, timeout = 10)
      deadline = monotonic + timeout
      until yield
        raise Failure, message if monotonic > deadline

        sleep 0.005
      end
    end

    def check(condition, message)
      raise Failure, message unless condition
    end

    def monotonic = Process.clock_gettime(Process::CLOCK_MONOTONIC)
  end
end
