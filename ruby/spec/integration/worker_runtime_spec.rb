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
    allow(subject).to receive(:claim).and_wrap_original do |original, name, limit|
      raise "later queue claim failed" if name == failing

      original.call(name, limit)
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

  it "fires due schedules in its namespaces during maintenance" do
    namespace = "rb-#{SecureRandom.hex(6)}"
    # :skip evaluates only the last maintenance window, so the missed minute needs :latest.
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
end
