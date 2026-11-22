# frozen_string_literal: true

require "opentelemetry"
require "spec_helper"

RSpec.describe "The workhorse.handler span" do
  # Records the parent context each span starts from.
  let(:tracer) do
    Class.new(OpenTelemetry::Trace::Tracer) do
      attr_reader :parents

      def initialize
        super
        @parents = {}
      end

      def start_span(name, with_parent: nil, **)
        @parents[name] = OpenTelemetry::Trace.current_span(with_parent).context
        OpenTelemetry::Trace.non_recording_span(OpenTelemetry::Trace::SpanContext.new)
      end
    end.new
  end

  let(:unrelated) { OpenTelemetry::Trace.non_recording_span(OpenTelemetry::Trace::SpanContext.new) }

  before { allow(W::Telemetry).to receive(:tracer).and_return(tracer) }

  def under_unrelated_span(&block)
    OpenTelemetry::Trace.with_span(unrelated, &block)
  end

  it "starts a new trace for a task without a stored trace context" do
    under_unrelated_span { W::Telemetry.span("workhorse.handler", {}, trace_context: nil, consumer: true) { nil } }
    expect(tracer.parents.fetch("workhorse.handler")).not_to be_valid
  end

  it "parents a task with a stored trace context to that context" do
    stored = {"traceparent" => "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"}
    under_unrelated_span { W::Telemetry.span("workhorse.handler", {}, trace_context: stored, consumer: true) { nil } }
    parent = tracer.parents.fetch("workhorse.handler")
    expect(parent.hex_trace_id).to eq("4bf92f3577b34da6a3ce929d0e0e4736")
    expect(parent.hex_span_id).to eq("00f067aa0ba902b7")
  end

  it "leaves an internal span parented to the current span" do
    under_unrelated_span { W::Telemetry.span("workhorse.claim", {}) { nil } }
    expect(tracer.parents.fetch("workhorse.claim")).to eq(unrelated.context)
  end
end

RSpec.describe "The worker instruments" do
  # The kind, unit, and description of each instrument in api/telemetry.txt.
  let(:contract) do
    text = File.read(File.expand_path("../../../api/telemetry.txt", __dir__))
    rows = text.split("## Instruments", 2).last.split("## Spans", 2).first.lines
    rows.map { |line| line.split(/\s+/, 4).map(&:strip) }
      .select { |row| row.size == 4 && row.first.start_with?("workhorse.") }
      .to_h { |name, kind, unit, description| [name, [kind.to_sym, description, unit]] }
  end

  it "match the kind, unit, and description in api/telemetry.txt" do
    W::Telemetry.const_get(:INSTRUMENTS).each do |name, declared|
      expect(declared).to eq(contract.fetch(name)), name
    end
  end
end

# A Logger that keeps each record that Telemetry.log writes as [severity, event, body, attributes].
class RecordingLogger < Logger
  LEVELS = {Logger::DEBUG => :debug, Logger::INFO => :info, Logger::WARN => :warn, Logger::ERROR => :error}.freeze

  attr_reader :records

  def initialize
    super(nil)
    self.level = Logger::DEBUG
    @records = Concurrent::Array.new
  end

  def add(severity, message = nil, progname = nil)
    text = message || (block_given? ? yield : progname)
    match = /\A(?<event>\S+): (?<body>.*?)(?: (?<attributes>\{.*\}))?\z/m.match(text)
    @records << [LEVELS.fetch(severity), match[:event], match[:body],
      match[:attributes] ? JSON.parse(match[:attributes]) : {}]
    true
  end

  def named(event) = records.select { |record| record[1] == event }
end

# Each worker log event of the TypeScript union WorkhorseLogEvent, with the name, severity, body,
# and attributes of TypeScript (docs/architecture/telemetry.md, "Structured logs").
RSpec.describe "The worker log events" do
  task = "0190a6f8-0000-7000-8000-000000000001"
  target = "0190a6f8-0000-7000-8000-000000000002"
  audit = W::AdminAudit.new("operator", "investigating", "request-1")

  cancel_row = {"current_attempt" => "1", "requested_at" => nil, "requested_by" => nil, "reason" => nil,
                "finished_at" => nil}

  let(:logger) { RecordingLogger.new }

  describe "of the queue" do
    def queue(logger, &) = W::Queue.new(FakeExecutor.new(&), default_queue: "mail", logger: logger)

    it "writes one debug event for each enqueue outcome" do
      outcomes = {
        "accepted" => ["workhorse.task.enqueued", "Task enqueued", nil],
        "replayed" => ["workhorse.task.enqueue_replayed", "Idempotent enqueue replayed", nil],
        "replaced" => ["workhorse.task.debounced", "Pending task replaced", nil],
        "non_replaceable" => ["workhorse.task.debounce_rejected", "Debounced task not replaceable", "not_pending"],
        "coalesced" => ["workhorse.task.throttled", "Throttled enqueue coalesced", nil]
      }
      rows = outcomes.each_with_index.map do |(outcome, (_, _, reason)), index|
        {"ordinal" => (index + 1).to_s, "task_id" => task, "outcome" => outcome, "reason" => reason}
      end
      requests = outcomes.size.times.map do |index|
        W::EnqueueRequest.new(task_type: "send", payload: {}, queue: index.zero? ? nil : "billing")
      end
      queue(logger) { rows }.enqueue_many(requests)

      expect(logger.records).to eq(outcomes.values.each_with_index.map { |(event, body, _), index|
        [:debug, event, body, {"workhorse.task.id" => task, "workhorse.task.type" => "send",
                               "workhorse.queue.name" => index.zero? ? "mail" : "billing"}]
      })
    end

    it "builds no record when the logger level is above the event" do
      logger.level = Logger::WARN
      enqueued = [{"ordinal" => "1", "task_id" => task, "outcome" => "accepted", "reason" => nil}]
      queue(logger) { enqueued }.enqueue("send", {})
      queue(logger) { [cancel_row.merge("status" => "canceled", "state" => "canceled")] }.cancel(task, requested_by: nil)

      expect(logger.records).to eq([])
    end

    it "writes workhorse.task.cancellation_processed at info" do
      queue(logger) { [cancel_row.merge("status" => "canceled", "state" => "canceled")] }.cancel(task, requested_by: "ops",
        reason: "secret reason")
      queue(logger) { [cancel_row.merge("status" => "not_found", "state" => nil)] }.cancel(task, requested_by: nil)

      expect(logger.records).to eq([
        [:info, "workhorse.task.cancellation_processed", "Task cancellation processed",
          {"workhorse.task.id" => task, "workhorse.task.state" => "canceled", "workhorse.operation.status" => "canceled"}],
        [:info, "workhorse.task.cancellation_processed", "Task cancellation processed",
          {"workhorse.task.id" => task, "workhorse.task.state" => "not_found", "workhorse.operation.status" => "not_found"}]
      ])
    end

    it "writes workhorse.task.signal_processed and workhorse.task.human_wait_processed at info" do
      queue(logger) { [{"status" => "delivered", "payload" => nil, "delivered_at" => nil, "delivered_by" => nil}] }.send_signal(task, "go", {"secret" => 1}, idempotency_key: "k",
        requested_by: "ops")
      queue(logger) { [{"status" => "completed", "result" => nil, "completed_at" => nil, "completed_by" => nil}] }.complete_human_wait(task, "review", {"secret" => 1},
        idempotency_key: "k", requested_by: "ann")

      expect(logger.records).to eq([
        [:info, "workhorse.task.signal_processed", "Task signal processed",
          {"workhorse.task.id" => task, "workhorse.signal.name" => "go", "workhorse.signal.status" => "delivered"}],
        [:info, "workhorse.task.human_wait_processed", "Human wait completion processed",
          {"workhorse.task.id" => task, "workhorse.human_wait.name" => "review",
           "workhorse.human_wait.status" => "completed"}]
      ])
    end

    it "writes no signal or human wait event for an idempotency conflict" do
      subject = queue(logger) { [{"status" => "conflict"}] }
      expect { subject.send_signal(task, "go", {}, idempotency_key: "k", requested_by: "ops") }
        .to raise_error(W::SignalIdempotencyConflictError)
      expect { subject.complete_human_wait(task, "review", {}, idempotency_key: "k", requested_by: "ann") }
        .to raise_error(W::HumanWaitIdempotencyConflictError)
      expect(logger.records).to be_empty
    end

    it "writes the cancel, signal, and human wait events from a dashboard action" do
      rows = {
        W::SqlCatalogue::CANCEL_V1 => cancel_row.merge("status" => "not_found", "state" => nil),
        W::SqlCatalogue::SEND_SIGNAL_V2 => {"status" => "delivered", "payload" => nil, "delivered_at" => nil,
                                            "delivered_by" => nil},
        W::SqlCatalogue::COMPLETE_HUMAN_WAIT_V1 => {"status" => "conflict", "result" => nil, "completed_at" => nil,
                                                    "completed_by" => nil}
      }
      backend = W::Dashboard.const_get(:Backend).new(FakeExecutor.new { |sql, _params| [rows.fetch(sql)] }, environment: "test",
        configured_workers: [], maintenance_loops: {}, read_only: false, statement_timeout_ms: 1_000, logger: logger)
      expect { backend.send(:cancel_task, {"id" => task, "audit" => {}}, "operator") }
        .to raise_error(W::Dashboard::RpcError)
      backend.send(:signal_task, {"id" => task, "name" => "go", "payload" => {"secret" => 1}, "idempotencyKey" => "k"},
        "operator")
      backend.send(:complete_human_wait, {"id" => task, "name" => "review", "result" => {"secret" => 1},
                                          "idempotencyKey" => "k"}, "operator")

      expect(logger.records).to eq([
        [:info, "workhorse.task.cancellation_processed", "Task cancellation processed",
          {"workhorse.task.id" => task, "workhorse.task.state" => "not_found", "workhorse.operation.status" => "not_found"}],
        [:info, "workhorse.task.signal_processed", "Task signal processed",
          {"workhorse.task.id" => task, "workhorse.signal.name" => "go", "workhorse.signal.status" => "delivered"}]
      ])
    end

    it "writes workhorse.schedules.synchronized at info" do
      definition = W::ScheduleDefinition.new(name: "nightly", schedule: "0 3 * * *",
        task: W::ScheduledTask.new(task_type: "report", payload: {}))
      queue(logger).sync_schedules("reports", [definition, definition.with(name: "hourly")])

      expect(logger.records).to eq([[:info, "workhorse.schedules.synchronized", "Recurring schedules synchronized",
        {"workhorse.schedule.namespace" => "reports", "workhorse.schedule.count" => 2}]])
    end

    it "logs nothing without a logger" do
      expect { W::Queue.new(FakeExecutor.new { [cancel_row.merge("status" => "canceled", "state" => "canceled")] }).cancel(task, requested_by: nil) }
        .not_to output.to_stderr
    end
  end

  describe "of the admin client" do
    def admin(logger, &) = W::Admin.new(FakeExecutor.new(&), logger: logger)

    it "writes the queue administration events at info" do
      admin(logger).pause_queue("mail", audit: audit)
      admin(logger).resume_queue("mail", audit: audit)
      admin(logger) { [{"tier" => "fast"}] }.set_queue_tier("mail", :fast, audit: audit)
      admin(logger) { [{"deleted_count" => "4"}] }.purge_queue("mail", audit: audit)

      expect(logger.records).to eq([
        [:info, "workhorse.queue.paused", "Queue paused", {"workhorse.queue.name" => "mail"}],
        [:info, "workhorse.queue.resumed", "Queue resumed", {"workhorse.queue.name" => "mail"}],
        [:info, "workhorse.queue.tier_set", "Queue tier set", {"workhorse.queue.name" => "mail", "workhorse.queue.tier" => "fast"}],
        [:info, "workhorse.queue.purged", "Queue purged", {"workhorse.queue.name" => "mail", "workhorse.task.count" => 4}]
      ])
    end

    it "writes the redrive events at info" do
      redriven = {"status" => "redriven", "source_task_id" => task, "target_task_id" => target, "source_state" => "failed",
                  "target_state" => "ready", "requested_at" => nil}
      missing = redriven.merge("status" => "not_found", "target_task_id" => nil, "target_state" => nil)
      admin(logger) { [redriven] }.redrive(task, audit: audit)
      admin(logger) { [missing] }.redrive(task, audit: audit)
      admin(logger) { [redriven.merge("has_more" => "f"), missing.merge("has_more" => "f")] }
        .redrive_many(audit: audit, dry_run: true)

      expect(logger.records).to eq([
        [:info, "workhorse.task.redrive_processed", "Dead-letter task redrive processed",
          {"workhorse.task.id" => task, "workhorse.redrive.target_task_id" => target, "workhorse.operation.status" => "redriven"}],
        [:info, "workhorse.task.redrive_processed", "Dead-letter task redrive processed",
          {"workhorse.task.id" => task, "workhorse.redrive.target_task_id" => "none", "workhorse.operation.status" => "not_found"}],
        [:info, "workhorse.tasks.redrive_processed", "Dead-letter task redrive batch processed",
          {"workhorse.task.count" => 2, "workhorse.redrive.dry_run" => true}]
      ])
    end

    it "writes workhorse.worker.paused and workhorse.worker.resumed for a registered worker" do
      row = {"worker_id" => "w1", "paused" => "t", "paused_by" => "operator", "paused_reason" => "investigating",
             "paused_at" => nil, "last_heartbeat_at" => nil}
      admin(logger) { [row] }.set_worker_paused("w1", true, audit: audit)
      admin(logger) { [row.merge("paused" => "f")] }.set_worker_paused("w1", false, audit: audit)
      admin(logger) { [] }.set_worker_paused("w2", true, audit: audit)

      expect(logger.records).to eq([
        [:info, "workhorse.worker.paused", "Worker paused", {"workhorse.worker.id" => "w1"}],
        [:info, "workhorse.worker.resumed", "Worker resumed", {"workhorse.worker.id" => "w1"}]
      ])
    end
  end

  describe "of the worker" do
    pool_class = Class.new(FakeExecutor) do
      def size = 3

      def with(&) = FakeHeartbeatConnection.lend(&)
    end

    def worker(pool, **options)
      W::Worker.new(pool, queues: %w[mail billing], worker_id: "log-worker", concurrency: 2, polling_only: true,
        logger: logger, **options)
    end

    it "writes workhorse.handler.registered at debug for each handler" do
      subject = worker(pool_class.new)
      subject.handle("send") { nil }
      subject.handle_batch("digest", max_size: 2, linger: 0.25) { |items| items.map { {status: :succeeded, result: nil} } }

      expect(logger.named("workhorse.handler.registered")).to eq([
        [:debug, "workhorse.handler.registered", "Task handler registered",
          {"workhorse.worker.id" => "log-worker", "workhorse.task.type" => "send"}],
        [:debug, "workhorse.handler.registered", "Batch task handler registered",
          {"workhorse.worker.id" => "log-worker", "workhorse.task.type" => "digest", "workhorse.handler.batch.max_size" => 2,
           "workhorse.handler.batch.linger_ms" => 250}]
      ])
    end

    it "writes workhorse.worker.registered only on the first registration and on a change of state" do
      paused = "f"
      pool = pool_class.new { |sql, _params| (sql == W::SqlCatalogue::REGISTER_WORKER_V1) ? [{"paused" => paused}] : [] }
      subject = worker(pool)
      subject.instance_variable_set(:@instance_id, "instance-1")
      3.times { subject.send(:refresh_registration, force: true) }
      paused = "t"
      2.times { subject.send(:refresh_registration, force: true) }
      subject.instance_variable_set(:@draining, true)
      subject.send(:refresh_registration, force: true)

      base = {"workhorse.worker.id" => "log-worker", "workhorse.worker.queues" => %w[mail billing],
              "workhorse.worker.concurrency" => 2, "workhorse.worker.active_slots" => 0}
      expect(pool.statements.count { |sql, _| sql == W::SqlCatalogue::REGISTER_WORKER_V1 }).to eq(6)
      expect(logger.named("workhorse.worker.registered")).to eq([
        [:debug, "workhorse.worker.registered", "Worker registration changed",
          base.merge("workhorse.worker.draining" => false, "workhorse.worker.paused" => false)],
        [:debug, "workhorse.worker.registered", "Worker registration changed",
          base.merge("workhorse.worker.draining" => false, "workhorse.worker.paused" => true)],
        [:debug, "workhorse.worker.registered", "Worker registration changed",
          base.merge("workhorse.worker.draining" => true, "workhorse.worker.paused" => true)]
      ])
    end

    it "writes workhorse.worker.registered again after a deregistration" do
      pool = pool_class.new do |sql, _params|
        case sql
        when W::SqlCatalogue::REGISTER_WORKER_V1 then [{"paused" => "f"}]
        when W::SqlCatalogue::DEREGISTER_WORKER_V2 then [{"deregistered" => "t"}]
        else []
        end
      end
      subject = worker(pool)
      subject.instance_variable_set(:@instance_id, "instance-1")
      subject.send(:refresh_registration, force: true)
      subject.send(:deregister, "instance-1")
      subject.send(:refresh_registration, force: true)

      expect(logger.named("workhorse.worker.registered").size).to eq(2)
    end

    it "writes workhorse.worker.deregistered at debug with the result of PostgreSQL" do
      deregistered = "t"
      pool = pool_class.new do |sql, _params|
        case sql
        when W::SqlCatalogue::REGISTER_WORKER_V1 then [{"paused" => "f"}]
        when W::SqlCatalogue::DEREGISTER_WORKER_V2 then [{"deregistered" => deregistered}]
        else []
        end
      end
      subject = worker(pool)
      subject.instance_variable_set(:@instance_id, "instance-1")
      subject.send(:refresh_registration, force: true)
      subject.send(:deregister, "instance-1")
      deregistered = "f"
      subject.send(:refresh_registration, force: true)
      subject.send(:deregister, "instance-1")

      expect(logger.named("workhorse.worker.deregistered")).to eq([
        [:debug, "workhorse.worker.deregistered", "Worker deregistered",
          {"workhorse.worker.id" => "log-worker", "workhorse.worker.deregistered" => true}],
        [:debug, "workhorse.worker.deregistered", "Worker deregistered",
          {"workhorse.worker.id" => "log-worker", "workhorse.worker.deregistered" => false}]
      ])
    end

    it "writes workhorse.worker.registration_failed with the queues and the error type" do
      pool = pool_class.new { |sql, _params| raise "never-log-this" if sql == W::SqlCatalogue::REGISTER_WORKER_V1 }
      subject = worker(pool, on_registration_error: ->(_error) {})
      subject.instance_variable_set(:@instance_id, "instance-1")
      subject.send(:refresh_registration, force: true)

      expect(logger.named("workhorse.worker.registration_failed")).to eq([
        [:info, "workhorse.worker.registration_failed", "Worker registration failed",
          {"workhorse.worker.id" => "log-worker", "workhorse.worker.queues" => %w[mail billing],
           "error.type" => "RuntimeError"}]
      ])
      expect(logger.records.join).not_to include("never-log-this")
    end

    it "writes a remote pause and resume with the queues of the worker" do
      paused = "f"
      pool = pool_class.new { |sql, _params| (sql == W::SqlCatalogue::REGISTER_WORKER_V1) ? [{"paused" => paused}] : [] }
      subject = worker(pool)
      subject.instance_variable_set(:@instance_id, "instance-1")
      subject.send(:refresh_registration, force: true)
      paused = "t"
      subject.send(:refresh_registration, force: true)
      paused = "f"
      subject.send(:refresh_registration, force: true)

      attributes = {"workhorse.worker.id" => "log-worker", "workhorse.worker.queues" => %w[mail billing]}
      expect(logger.named("workhorse.worker.paused")).to eq([
        [:info, "workhorse.worker.paused", "Worker paused remotely", attributes]
      ])
      expect(logger.named("workhorse.worker.resumed")).to eq([
        [:info, "workhorse.worker.resumed", "Worker resumed remotely", attributes]
      ])
    end

    it "writes workhorse.task.claimed with the queue of the task" do
      claimed = Struct.new(:id, :type, :attempt, :queue).new(task, "send", 1, "mail")
      worker(pool_class.new).send(:record_claimed, "mail", Process.clock_gettime(Process::CLOCK_MONOTONIC), [claimed])

      expect(logger.named("workhorse.task.claimed")).to eq([
        [:debug, "workhorse.task.claimed", "Task claimed",
          {"workhorse.worker.id" => "log-worker", "workhorse.task.id" => task, "workhorse.task.type" => "send",
           "workhorse.task.attempt" => 1, "workhorse.queue.name" => "mail"}]
      ])
    end

    it "writes workhorse.maintenance.completed for each background routine that changed rows or failed" do
      routines = [
        {"phase" => "history_retention", "rows_affected" => "4", "duration_ms" => "1", "skipped_lock" => "f",
         "error" => nil},
        {"phase" => "stat_rollup", "rows_affected" => "0", "duration_ms" => "1", "skipped_lock" => "f", "error" => nil},
        {"phase" => "terminal_storage", "rows_affected" => "0", "duration_ms" => "1", "skipped_lock" => "f",
         "error" => "{\"message\":\"never-log-this\"}"}
      ]
      pool = pool_class.new { |sql, _params| (sql == W::SqlCatalogue::RUN_MAINTENANCE_V1) ? routines : [] }
      worker(pool, disable_registry: true).send(:run_maintenance_pass, Process.clock_gettime(Process::CLOCK_MONOTONIC) + 1e6)

      expect(logger.named("workhorse.maintenance.completed")).to eq([["history_retention", 4], ["terminal_storage", 0]].map { |phase, rows|
        [:info, "workhorse.maintenance.completed", "Maintenance phase completed",
          {"workhorse.worker.id" => "log-worker", "workhorse.maintenance.operation" => "background_routines",
           "workhorse.maintenance.phase" => phase, "workhorse.maintenance.rows_affected" => rows,
           "workhorse.maintenance.skipped_lock" => false}]
      })
      expect(logger.records.join).not_to include("never-log-this")
    end

    it "writes workhorse.worker.started and workhorse.worker.stopped for a run only" do
      subject = worker(FakeLendingPool.new, poll_interval: 0.01, disable_registry: true, heartbeat: 0.1)
      subject.run_once
      expect(logger.named("workhorse.worker.started")).to eq([])
      expect(logger.named("workhorse.worker.stopped")).to eq([])

      runner = Thread.new { subject.run }
      deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 10
      started = -> { logger.named("workhorse.worker.started").any? }
      sleep 0.01 until started.call || Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline
      subject.stop
      runner.join(10)

      queues = {"workhorse.worker.id" => "log-worker", "workhorse.worker.queues" => %w[mail billing]}
      expect(logger.named("workhorse.worker.started")).to eq([
        [:info, "workhorse.worker.started", "Worker started", queues.merge("workhorse.worker.concurrency" => 2)]
      ])
      expect(logger.named("workhorse.worker.stopped")).to eq([
        [:info, "workhorse.worker.stopped", "Worker stopped", queues.merge("workhorse.worker.active_slots" => 0)]
      ])
    end

    it "writes no workhorse.worker.stopped for a run that fails, as TypeScript does" do
      subject = worker(FakeLendingPool.new, poll_interval: 0.01, disable_registry: true, heartbeat: 0.1)
      subject.define_singleton_method(:dispatch) { |*| raise "loop failure" }

      expect { subject.run }.to raise_error(RuntimeError, "loop failure")
      expect(logger.named("workhorse.worker.started").size).to eq(1)
      expect(logger.named("workhorse.worker.stopped")).to eq([])
    end

    it "writes workhorse.worker.started before the readiness check, as TypeScript does" do
      subject = worker(FakeLendingPool.new, poll_interval: 0.01, disable_registry: true, heartbeat: 0.1)
      subject.define_singleton_method(:start_heartbeat) { |*| raise W::WorkerStartupError, "no heartbeat connection" }

      expect { subject.run }.to raise_error(W::WorkerStartupError)
      expect(logger.named("workhorse.worker.started").size).to eq(1)
      expect(logger.named("workhorse.worker.stopped")).to eq([])
    end

    it "writes workhorse.worker.started before the first workhorse.worker.registered" do
      pool = FakeLendingPool.new do |sql, _params|
        case sql
        when W::SqlCatalogue::REGISTER_WORKER_V1 then [{"paused" => "f"}]
        when W::SqlCatalogue::DEREGISTER_WORKER_V2 then [{"deregistered" => "t"}]
        else []
        end
      end
      subject = worker(pool, poll_interval: 0.01, heartbeat: 0.1)
      runner = Thread.new { subject.run }
      deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 10
      registered = -> { logger.named("workhorse.worker.registered").any? }
      sleep 0.01 until registered.call || Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline
      subject.stop
      runner.join(10)

      names = logger.records.map { |record| record[1] }
        .select { |name| %w[workhorse.worker.started workhorse.worker.registered].include?(name) }
      expect(names.first(2)).to eq(%w[workhorse.worker.started workhorse.worker.registered])
    end

    it "writes no workhorse.task.execution_finished for an attempt without an outcome" do
      claimed = Struct.new(:id, :type, :attempt, :queue).new(task, "send", 1, "mail")
      attributes = {"workhorse.queue.name" => "mail"}.merge(W::Telemetry.task_span_attributes(claimed))
      measured = []
      allow(W::Telemetry).to receive(:add) { |name, _amount, metric = {}| measured << [name, metric] }
      allow(W::Telemetry).to receive(:record) { |name, _amount, metric = {}| measured << [name, metric] }
      # The arbiter has no outcome, as after a settlement statement that failed.
      worker(pool_class.new).send(:finish_telemetry, claimed, nil, W::Arbiter.new, {span_outcome: nil, errors: []},
        Process.clock_gettime(Process::CLOCK_MONOTONIC), attributes)

      expect(logger.named("workhorse.handler.finished").size).to eq(1)
      expect(logger.named("workhorse.task.execution_finished")).to eq([])
      # As in TypeScript, the duration records the outcome unknown, and the executions counter does
      # not count the attempt.
      expect(measured.map(&:first)).to eq(%w[workhorse.handler.duration workhorse.handler.runtime])
      expect(measured.first.last["workhorse.handler.outcome"]).to eq("unknown")
    end

    it "writes workhorse.worker.polling_only at warn once for a run without a listener" do
      subject = worker(FakeLendingPool.new, poll_interval: 0.01, disable_registry: true, heartbeat: 0.1)
      runner = Thread.new { subject.run }
      deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 10
      # The start record comes before the readiness check, so the run waits for the warning itself.
      warned = -> { logger.named("workhorse.worker.polling_only").any? }
      sleep 0.01 until warned.call || Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline
      subject.stop
      runner.join(10)
      subject.run_once

      expect(logger.named("workhorse.worker.polling_only")).to eq([
        [:warn, "workhorse.worker.polling_only", "Worker has no notification listener and dispatches by polling",
          {"workhorse.worker.id" => "log-worker", "workhorse.worker.queues" => %w[mail billing],
           "workhorse.worker.pool_max_size" => 3}]
      ])
    end
  end
end
