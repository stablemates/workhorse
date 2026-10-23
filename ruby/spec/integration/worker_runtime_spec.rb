# frozen_string_literal: true

require "connection_pool"
require "opentelemetry"
require "opentelemetry-metrics-api"

# Records every span and measurement the worker emits. Examples share the global providers, so
# each example reads only what names its own queue or task type.
module RecordedTelemetry
  Span = Struct.new(:name, :kind, :attributes, :parent, :status, :finished)

  class Tracer < OpenTelemetry::Trace::Tracer
    def start_span(name, with_parent: nil, attributes: nil, kind: nil, **)
      parent = OpenTelemetry::Trace.current_span(with_parent).context
      # A root span needs a real trace ID; a nil one reads as valid and breaks trace injection.
      trace_id = parent.valid? ? parent.trace_id : OpenTelemetry::Trace.generate_trace_id
      context = OpenTelemetry::Trace::SpanContext.new(trace_id: trace_id)
      RecordedSpan.new(Span.new(name, kind, (attributes || {}).dup, parent, nil, false), context)
    end
  end

  class RecordedSpan < OpenTelemetry::Trace::Span
    def initialize(record, context)
      super(span_context: context)
      @record = record
      RecordedTelemetry.spans << record
    end

    def recording? = true

    def set_attribute(key, value)
      @record.attributes[key] = value
      self
    end

    def add_event(*, **) = self

    def status=(status)
      @record.status = status
    end

    def finish(**)
      @record.finished = true
      self
    end
  end

  class TracerProvider < OpenTelemetry::Trace::TracerProvider
    def tracer(...) = Tracer.new
  end

  class Instrument
    def initialize(name) = @name = name

    def add(amount, attributes: {}) = RecordedTelemetry.measurements << [@name, amount, attributes]

    alias_method :record, :add
  end

  class Meter < OpenTelemetry::Metrics::Meter
    def create_counter(name, **) = Instrument.new(name)

    def create_histogram(name, **) = Instrument.new(name)
  end

  class MeterProvider < OpenTelemetry::Metrics::MeterProvider
    def meter(...) = Meter.new
  end

  def self.spans = @spans ||= Concurrent::Array.new

  def self.measurements = @measurements ||= Concurrent::Array.new
end

OpenTelemetry.tracer_provider = RecordedTelemetry::TracerProvider.new
begin
  # opentelemetry-metrics-api 0.9 defines the public accessor only behind this require; 0.8 has no
  # such file and defines the accessor itself.
  require "opentelemetry/metrics/global"
rescue LoadError
  nil
end
OpenTelemetry.meter_provider = RecordedTelemetry::MeterProvider.new

RSpec.describe "Worker runtime against PostgreSQL" do
  include_context "with a scratch database"

  before { @pool = ConnectionPool.new(size: 6, timeout: 5) { ScratchDatabase.connect } }

  after { @pool&.shutdown(&:close) }

  define_method(:audit) { W::AdminAudit.new("operator", "investigating", SecureRandom.uuid) }

  def worker(queues: [@queue_name], **options)
    W::Worker.new(@pool, queues: queues, polling_only: true, poll_interval: 0.01, disable_registry: true, **options)
  end

  def state(task_id)
    @connection.exec_params("SELECT COALESCE(outcome.state, runtime.state) AS state FROM workhorse.task task
      LEFT JOIN workhorse.task_runtime runtime ON runtime.task_id = task.id
      LEFT JOIN workhorse.task_outcome outcome ON outcome.task_id = task.id WHERE task.id = $1", [task_id])
      .getvalue(0, 0)
  end

  def wait_until(timeout = 10)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
    until yield
      raise "condition not met within #{timeout} seconds" if Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline

      sleep 0.02
    end
  end

  # Whether a heartbeat statement waits on the lock of the backend blocker_pid (waits true), or no
  # statement waits on it (waits false). An answer after the monotonic time deadline does not count.
  def heartbeats_reach(observer, blocker_pid, waits, deadline)
    loop do
      waiting = observer.exec_params(
        "SELECT count(*) FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid)) " \
        "AND query LIKE '%heartbeat_many%'", [blocker_pid]
      ).getvalue(0, 0).to_i
      return false if Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline
      return true if waiting.positive? == waits

      sleep 0.01
    end
  end

  # Runs +subject+ on a thread, yields, and then stops it and waits for the run to return.
  def running(subject)
    thread = Thread.new { subject.run }
    yield
  ensure
    subject.stop
    thread&.join(10)
  end

  it "wakes an idle worker on a notification well before its fallback poll" do
    subject = worker(polling_only: false, poll_interval: 60).handle("woken") { {} }
    claims = {completed: 0, in_flight: 0}
    lock = Mutex.new
    allow(subject.instance_variable_get(:@executor)).to receive(:rows).and_wrap_original do |original, sql, *arguments|
      next original.call(sql, *arguments) unless sql == W::SqlCatalogue::CLAIM_MANY_V1

      lock.synchronize { claims[:in_flight] += 1 }
      begin
        original.call(sql, *arguments)
      ensure
        lock.synchronize { claims.merge!(in_flight: claims[:in_flight] - 1, completed: claims[:completed] + 1) }
      end
    end
    listening = "SELECT count(*) FROM pg_stat_activity
      WHERE datname = current_database() AND state = 'idle' AND query = 'LISTEN workhorse_tasks'"
    running(subject) do
      # PostgreSQL holds the LISTEN, and the claims it woke have come back empty.
      wait_until { @connection.exec(listening).getvalue(0, 0) == "1" }
      wait_until { lock.synchronize { claims[:completed].positive? && claims[:in_flight].zero? } }
      sleep 0.1
      enqueued_at = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      task_id = queue.enqueue("woken", {}).task_id
      # Without the notification, the next claim waits for a fallback poll of several seconds.
      wait_until(1) { state(task_id) == "succeeded" }
      expect(Process.clock_gettime(Process::CLOCK_MONOTONIC) - enqueued_at).to be < 1
    end
  end

  it "runs what an earlier queue claimed when a later queue's claim fails" do
    task_id = queue.enqueue("partial", {}).task_id
    failing = "#{@queue_name}-failing"
    subject = worker(queues: [@queue_name, failing], concurrency: 2).handle("partial") { {} }
    allow(subject).to receive(:claim).and_wrap_original do |original, name, *limits|
      raise "later queue claim failed" if name == failing

      original.call(name, *limits)
    end

    expect { subject.run_once }.to raise_error(RuntimeError, "later queue claim failed")
    expect(state(task_id)).to eq("succeeded")
  end

  it "claims only for executor threads that are ready, so a claimed task is never rejected or queued" do
    task_ids = Array.new(6) { queue.enqueue("slow-return", {}).task_id }
    subject = worker(concurrency: 2).handle("slow-return") { {} }
    posted = Concurrent::Array.new
    allow(subject).to receive(:handler_executor).and_wrap_original do |original|
      executor = original.call
      # Widens the gap between a task leaving the active set and its thread becoming ready again.
      executor.define_singleton_method(:ready_worker) do |*arguments|
        sleep 0.05
        super(*arguments)
      end
      executor.define_singleton_method(:post) do |*arguments, &task|
        posted << queue_length
        super(*arguments, &task)
      end
      executor
    end
    thread = Thread.new { subject.run }
    # A rejected post ends the run, so the wait also ends when the thread does.
    wait_until { !thread.alive? || task_ids.all? { |task_id| state(task_id) == "succeeded" } }
    subject.stop

    expect(thread.join(10)&.value).to be_nil
    expect(posted.size).to eq(6)
    expect(posted.uniq).to eq([0])
  ensure
    subject&.stop
    thread&.join(10)
  end

  it "renews a short lease while a same-pool worker's longer heartbeat interval is pending" do
    short_queue = "#{@queue_name}-short"
    long_id = queue.enqueue("long", {}).task_id
    short_id = queue.enqueue("short", {}, queue: short_queue).task_id
    release = Concurrent::Event.new
    long = worker(lease: 3, heartbeat: 1).handle("long") { release.wait(10) && {} }
    running(long) do
      wait_until { state(long_id) == "active" }
      sleep 0.1
      # The short lease expires well before the long worker's next round would fall due.
      reason = :none
      short = worker(queues: [short_queue], lease: 0.3, heartbeat: 0.05).handle("short") do |_payload, context|
        context.cancellation.wait(0.9)
        reason = context.cancellation.reason
        {}
      end
      expect(short.run_once).to be(true)
      expect(reason).to be_nil
      expect(state(short_id)).to eq("succeeded")
    ensure
      release.set
    end
    expect(state(long_id)).to eq("succeeded")
  end

  # SM-1442: closing a connection does not stop its statement, so each round that timed out used to
  # leave one more backend waiting on the same lock. PostgreSQL now ends the round's transaction by
  # the round's deadline. A row lock now makes the round busy at once (SM-1443), so the blocker holds
  # a table lock on the fast tier. heartbeat_many_v2 locks that table first, so the statement waits.
  it "ends a heartbeat statement that waits on a lock on the server, by its round's deadline" do
    interval = 0.2
    task_id = queue.enqueue("bounded", {}).task_id
    release = Concurrent::Event.new
    started = Concurrent::Event.new
    subject = worker(lease: 30, heartbeat: interval).handle("bounded") do
      started.set
      release.wait(30)
      {}
    end
    samples = []
    blocker = ScratchDatabase.connect
    observer = ScratchDatabase.connect
    running(subject) do
      expect(started.wait(10)).to be(true)
      blocker.exec("BEGIN")
      blocker.exec("LOCK TABLE workhorse.fast_task_runtime IN EXCLUSIVE MODE")
      deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 8 * interval
      while Process.clock_gettime(Process::CLOCK_MONOTONIC) < deadline
        samples << observer.exec(<<~SQL).column_values(0).map { |age| Float(age) }
          SELECT extract(epoch FROM clock_timestamp() - query_start) * 1000
            FROM pg_stat_activity
           WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'active'
             AND query LIKE '%workhorse.heartbeat_many_v2%'
        SQL
        sleep 0.02
      end
      blocker.exec("COMMIT")
      release.set
      wait_until { state(task_id) == "succeeded" }
    ensure
      release.set
    end
    expect(samples.any?(&:any?)).to be(true)
    expect(samples.map(&:size).max).to be <= 1
    # A statement ends by its round's deadline. The slack allows for a slow host, and stays far below
    # the 1.6 s that the lock was held.
    expect(samples.flatten.max).to be < 5 * interval * 1000
  ensure
    blocker&.close
    observer&.close
  end

  # SM-1444: a round falls due one interval after the previous round started, also after a failed
  # round replaces the connection. So one timed-out round does not move the next round toward the end
  # of the lease. The lease is 2.3 intervals, shorter than the default of 3. The table lock on the
  # fast tier makes the first round wait, and the server ends it at about 1.4 intervals. The fixed
  # schedule sends the next round at 2 intervals, inside the lease. A schedule that starts again
  # after the failed round sends it at about 2.4 intervals, after the lease.
  #
  # The lease starts when the claim leaves, so the claim, the start of the handler, and the second
  # round must end in 0.3 intervals. The delays of a loaded host are absolute, so the interval is
  # 4 s, which gives them 1.2 s. A trace of the TypeScript test ran at a 1-minute load of 46 on 32
  # cores. The delay from the claim to the handler was up to 654 ms, and the second round took up to
  # 221 ms (SM-1479).
  it "keeps a renewal margin after one timed-out heartbeat round" do
    interval = 4.0
    task_id = queue.enqueue("margin", {}).task_id
    release = Concurrent::Event.new
    started = Concurrent::Event.new
    cancelled = nil
    lapsed = []
    subject = worker(lease: 9.2, heartbeat: interval).handle("margin") do |_payload, context|
      started.set
      release.wait(30)
      cancelled = context.cancellation.cancelled?
      {}
    end
    blocker = ScratchDatabase.connect
    observer = ScratchDatabase.connect
    running(subject) do
      expect(started.wait(10)).to be(true)
      handler_started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      blocker.exec("BEGIN")
      blocker.exec("LOCK TABLE workhorse.fast_task_runtime IN EXCLUSIVE MODE")
      # The first round falls due one interval after the lease registered, just before the handler
      # started. A lock that comes later than half an interval can miss that round.
      held = Process.clock_gettime(Process::CLOCK_MONOTONIC) - handler_started
      expect(held).to(be <= interval / 2, "precondition not met: the table lock came #{held} s after the handler started")
      # Hold the lock until the first round waits on it and then stops. While the lock is held, the
      # statement stops only when its round times out. Then release the lock before the second round.
      expect(heartbeats_reach(observer, blocker.backend_pid, true, handler_started + 1.5 * interval)).to(
        be(true), "precondition not met: the first round did not wait on the table lock"
      )
      expect(heartbeats_reach(observer, blocker.backend_pid, false, handler_started + 1.9 * interval)).to(
        be(true), "precondition not met: the first round did not time out"
      )
      blocker.exec("COMMIT")
      released = Process.clock_gettime(Process::CLOCK_MONOTONIC) - handler_started
      expect(released).to(be <= 1.9 * interval, "precondition not met: the table lock ended #{released} s after the handler started")
      # Run past the end of the lease from the claim, so only a renewal keeps the task. The stored
      # lease must not lapse before that renewal.
      until Process.clock_gettime(Process::CLOCK_MONOTONIC) >= handler_started + 2.6 * interval
        lapsed << blocker.exec_params(
          "SELECT expires_at <= clock_timestamp() FROM workhorse.task_runtime WHERE task_id = $1", [task_id]
        ).getvalue(0, 0)
        sleep 0.02
      end
      release.set
      wait_until { state(task_id) != "active" }
    ensure
      release.set
    end
    expect(lapsed).not_to be_empty
    expect(lapsed.uniq).to eq(["f"])
    expect(cancelled).to be(false)
    expect(state(task_id)).to eq("succeeded")
  ensure
    blocker&.close
    observer&.close
  end

  # SM-1443: a heartbeat that meets a row lock that another transaction holds does not wait for it.
  # It reports the lease busy, renews nothing, and the next round renews the lease after the commit.
  it "reports a lease busy at once while another transaction holds its row, and renews it after the commit" do
    task_id = queue.enqueue("busy", {}).task_id
    release = Concurrent::Event.new
    started = Concurrent::Event.new
    subject = worker(lease: 30, heartbeat: 0.2, shared_heartbeats: true).handle("busy") do
      started.set
      release.wait(30)
      {}
    end
    results = Concurrent::Array.new
    executor = subject.instance_variable_get(:@executor)
    original = executor.method(:rows)
    executor.define_singleton_method(:rows) do |sql, params = []|
      sent = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      rows = original.call(sql, params)
      if sql == W::SqlCatalogue::HEARTBEAT_MANY_V2
        results << [rows.map { |row| row["status"] }, Process.clock_gettime(Process::CLOCK_MONOTONIC) - sent]
      end
      rows
    end
    blocker = ScratchDatabase.connect
    expiry = lambda do
      Float(@connection.exec_params("SELECT extract(epoch FROM expires_at)::float8 FROM workhorse.task_runtime " \
        "WHERE task_id = $1", [task_id]).getvalue(0, 0))
    end
    running(subject) do
      expect(started.wait(10)).to be(true)
      wait_until { results.any? { |statuses, _| statuses == ["accepted"] } }
      blocker.exec("BEGIN")
      blocker.exec_params("SELECT FROM workhorse.task_runtime WHERE task_id = $1 FOR UPDATE", [task_id])
      held = expiry.call
      seen = results.size
      wait_until { results.drop(seen).any? { |statuses, _| statuses == ["busy"] } }
      busy = results.drop(seen).select { |statuses, _| statuses == ["busy"] }
      sleep 0.3
      expect(expiry.call).to eq(held)
      blocker.exec("COMMIT")
      seen = results.size
      wait_until { results.drop(seen).any? { |statuses, _| statuses == ["accepted"] } }
      wait_until { expiry.call > held }
      # A heartbeat that waited on the row would take the whole time that the row was held.
      expect(busy.map(&:last).max).to be < 0.1
      release.set
      wait_until { state(task_id) == "succeeded" }
    ensure
      release.set
    end
  ensure
    blocker&.close
  end

  # SM-1443: a busy round renews nothing. If the row stays held, the watchdog ends the attempt with
  # a lost lease at the end of its local window: not at the first busy round, and not later.
  it "lets a lease that stays busy lapse at the end of its local window" do
    lease = 0.8
    interval = 0.2
    task_id = queue.enqueue("held", {}).task_id
    started = Concurrent::Event.new
    cancelled = Concurrent::Event.new
    reason = nil
    cancelled_at = nil
    subject = worker(lease: lease, heartbeat: interval).handle("held") do |_payload, context|
      started.set
      context.cancellation.wait(10)
      cancelled_at = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      reason = context.cancellation.reason
      cancelled.set
      {}
    end
    blocker = ScratchDatabase.connect
    running(subject) do
      expect(started.wait(10)).to be(true)
      sleep 2 * interval
      blocker.exec("BEGIN")
      blocker.exec_params("SELECT FROM workhorse.task_runtime WHERE task_id = $1 FOR UPDATE", [task_id])
      held_at = Process.clock_gettime(Process::CLOCK_MONOTONIC)
      expect(cancelled.wait(5)).to be(true)
      blocker.exec("COMMIT")
      expect(reason).to eq(:lease_lost)
      # The last accepted round started at most one interval and one round before the lock.
      expect(cancelled_at - held_at).to be_between(lease - interval - 0.1, lease + 0.2)
    end
  ensure
    blocker&.close
  end

  it "fires due schedules in its namespaces during maintenance" do
    namespace = "rb-#{SecureRandom.hex(6)}"
    # :skip fires only inside the supported delay of at least 60 seconds, so the missed minute needs :latest.
    definition = W::ScheduleDefinition.new(name: "every-minute", schedule: "* * * * *", catchup_policy: :latest,
      task: W::ScheduledTask.new(task_type: "cron", payload: {}, queue: @queue_name))
    queue.sync_schedules(namespace, [definition])
    @connection.exec_params("UPDATE workhorse.schedule_definition SET last_evaluated_at = clock_timestamp() -
      interval '2 minutes' WHERE namespace = $1", [namespace])

    expect(worker(schedule_namespaces: [namespace]).handle("cron") { {"fired" => true} }.run_once).to be(true)
    fired = @connection.exec_params("SELECT count(*) FROM workhorse.schedule_occurrence WHERE namespace = $1",
      [namespace]).getvalue(0, 0)
    expect(Integer(fired, 10)).to be >= 1
  end

  it "registers the worker process and stops claiming while an operator pauses it" do
    admin = W::Admin.new(@connection)
    subject = worker(registry_interval: 0.1, disable_registry: false).handle("echo") { |payload| payload }
    running(subject) do
      entry = nil
      wait_until { entry = admin.list_workers.find { |candidate| candidate.worker_id == subject.worker_id } }
      expect([entry.pid, entry.queues, entry.concurrency]).to eq([Process.pid, [@queue_name], 1])

      expect(admin.set_worker_paused(subject.worker_id, true, audit: audit)).not_to be_nil
      sleep 0.3
      task_id = queue.enqueue("echo", {}).task_id
      sleep 0.5
      expect(state(task_id)).to eq("ready")

      admin.set_worker_paused(subject.worker_id, false, audit: audit)
      wait_until { state(task_id) == "succeeded" }
    end
    expect(admin.list_workers.map(&:worker_id)).not_to include(subject.worker_id)
  end

  it "runs terminal storage maintenance" do
    completed = "SELECT last_completed_at IS NOT NULL FROM workhorse.maintenance_state
                  WHERE routine_name = 'terminal_storage'"
    @connection.exec("UPDATE workhorse.maintenance_state SET last_completed_at = NULL
                       WHERE routine_name = 'terminal_storage'")

    expect(worker.run_once).to be(false)
    expect(@connection.exec(completed).getvalue(0, 0)).to eq("t")
  end

  it "binds the text now to maintenance so PostgreSQL chooses its time" do
    subject = worker
    bound = []
    allow(subject.instance_variable_get(:@executor)).to receive(:rows).and_wrap_original do |original, sql, *arguments|
      bound << arguments.first if sql == W::SqlCatalogue::RUN_MAINTENANCE_V1
      original.call(sql, *arguments)
    end

    subject.run_once
    expect(bound).to eq([["now"]])
  end

  it "keeps due state and retention on the database clock when the worker clock is fast" do
    @connection.exec("INSERT INTO workhorse.schedule_definition(
      namespace, schedule_name, cron_expression, queue_name, task_type, payload, max_attempts
    ) VALUES ('clock-skew', 'daily', '0 0 * * *', 'default', 'clock-skew', '{}'::jsonb, 1)")
    @connection.exec("INSERT INTO workhorse.schedule_occurrence(namespace, schedule_name, occurrence_at)
                       VALUES ('clock-skew', 'daily', clock_timestamp() - interval '13 days')")
    @connection.exec("UPDATE workhorse.retention_policy SET schedule_occurrence_retention_days = 14")
    @connection.exec("UPDATE workhorse.maintenance_policy
                         SET timezone = 'UTC', history_retention_local_time = '00:00'")
    @connection.exec("UPDATE workhorse.maintenance_state
                         SET last_started_at = NULL, last_completed_at = NULL, last_completed_local_date = NULL
                       WHERE routine_name IN ('history_partitions', 'history_retention')")
    subject = worker
    fast = Time.now + (2 * 86_400)
    allow(Time).to receive(:now).and_return(fast)

    subject.run_once
    expect(@connection.exec("SELECT count(*) FROM workhorse.schedule_occurrence
                              WHERE namespace = 'clock-skew'").getvalue(0, 0)).to eq("1")
    routines = @connection.exec("SELECT routine_name, last_started_at > clock_timestamp() AS ahead,
                                        last_started_at IS NOT NULL AS started
                                   FROM workhorse.maintenance_state
                                  WHERE routine_name IN ('history_partitions', 'history_retention')
                                  ORDER BY routine_name").to_a
    expect(routines).to eq([
      {"routine_name" => "history_partitions", "ahead" => "f", "started" => "t"},
      {"routine_name" => "history_retention", "ahead" => "f", "started" => "t"}
    ])
  end

  it "continues the enqueuing trace in the handler span and records the shared metrics" do
    parent = OpenTelemetry::Trace::SpanContext.new
    enqueue_context = OpenTelemetry::Trace.context_with_span(OpenTelemetry::Trace.non_recording_span(parent))
    task_id = OpenTelemetry::Context.with_current(enqueue_context) { queue.enqueue("traced", {}).task_id }
    stored = JSON.parse(task_row(task_id).fetch("trace_context"))
    expect(stored["traceparent"]).to include(parent.hex_trace_id)

    expect(worker.handle("traced") { {} }.run_once).to be(true)

    handler = RecordedTelemetry.spans.find do |span|
      span.name == "workhorse.handler" && span.attributes["workhorse.task.id"] == task_id
    end
    expect(handler.to_h.slice(:kind, :finished)).to eq(kind: :consumer, finished: true)
    expect(handler.parent.hex_trace_id).to eq(parent.hex_trace_id)
    recorded = RecordedTelemetry.measurements
      .select { |(_name, _amount, attributes)| attributes["workhorse.queue.name"] == @queue_name }
      .map(&:first)
    expect(recorded).to include("workhorse.tasks.claimed", "workhorse.claim.duration", "workhorse.tasks.completed",
      "workhorse.handler.duration")
  end

  it "parents a handler span only to its task's stored trace context" do
    untraced_id = queue.enqueue("trace-parent", {}).task_id
    producer = OpenTelemetry::Trace::SpanContext.new
    producer_context = OpenTelemetry::Trace.context_with_span(OpenTelemetry::Trace.non_recording_span(producer))
    traced_id = OpenTelemetry::Context.with_current(producer_context) { queue.enqueue("trace-parent", {}).task_id }

    subject = worker.handle("trace-parent") { {} }
    # Carry the posting thread's context to the handler thread, as OpenTelemetry's concurrent-ruby
    # instrumentation does.
    allow(subject).to receive(:handler_executor).and_wrap_original do |original|
      original.call.tap do |executor|
        allow(executor).to receive(:post).and_wrap_original do |post, &task|
          context = OpenTelemetry::Context.current
          post.call { OpenTelemetry::Context.with_current(context, &task) }
        end
      end
    end
    unrelated = OpenTelemetry::Trace.non_recording_span(OpenTelemetry::Trace::SpanContext.new)
    OpenTelemetry::Trace.with_span(unrelated) do
      expect(subject.run_once).to be(true)
      nil while subject.run_once
    end

    handlers = RecordedTelemetry.spans.select { |span| span.name == "workhorse.handler" }
      .to_h { |span| [span.attributes["workhorse.task.id"], span] }
    expect(handlers.fetch(untraced_id).parent).not_to be_valid
    expect(handlers.fetch(traced_id).parent.hex_trace_id).to eq(producer.hex_trace_id)
    expect(handlers.fetch(traced_id).parent.hex_span_id).to eq(producer.hex_span_id)
  end
end
