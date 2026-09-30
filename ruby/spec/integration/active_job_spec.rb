# frozen_string_literal: true

require "active_job"
require "active_record"
require "connection_pool"
require "json"
require "open3"
require "opentelemetry"
require "stablemates/workhorse/active_job"

ActiveJob::Base.logger = Logger.new(nil)

# What the jobs below saw. Each example resets it and names its own queue.
module ActiveJobSpec
  class << self
    attr_accessor :queue_name, :gate, :started, :hold, :failures_left, :running, :peak

    def seen = @seen ||= Concurrent::Array.new

    def reset(queue_name)
      self.queue_name = queue_name
      self.gate = Concurrent::Event.new
      self.started = Concurrent::Event.new
      self.hold = false
      self.failures_left = 0
      self.running = Concurrent::AtomicFixnum.new
      self.peak = Concurrent::AtomicFixnum.new
      seen.clear
    end
  end

  class Retryable < StandardError; end

  class Discardable < StandardError; end
end

class AjSpecJob < ActiveJob::Base
  include Stablemates::Workhorse::ActiveJob::Options

  queue_as { ActiveJobSpec.queue_name }
end

class AjDefaultJob < AjSpecJob
  workhorse_options tags: %w[spec], concurrency_key: ->(job) { "account:#{job.arguments.first}" }

  retry_on ActiveJobSpec::Retryable, wait: 0, attempts: 3
  discard_on ActiveJobSpec::Discardable

  def perform(account, symbol = nil)
    ActiveJobSpec.seen << {"account" => account, "symbol" => symbol, "executions" => executions,
                           "provider_job_id" => provider_job_id, "job_id" => job_id}
    if ActiveJobSpec.hold
      ActiveJobSpec.started.set
      ActiveJobSpec.gate.wait(10)
    end
    return if ActiveJobSpec.failures_left.zero?

    ActiveJobSpec.failures_left -= 1
    raise ActiveJobSpec::Retryable, "try again" if account == "retry"
    raise ActiveJobSpec::Discardable, "drop it" if account == "discard"

    raise "unhandled"
  end
end

class AjTypedJob < AjSpecJob
  workhorse_options task_type: "spec.active_job.typed", max_attempts: 3, concurrency_key: "typed"

  discard_on ActiveJobSpec::Discardable

  def perform(payload)
    ActiveJobSpec.seen << {"payload" => payload, "executions" => executions, "provider_job_id" => provider_job_id,
                           "job_id" => job_id}
    if ActiveJobSpec.hold
      ActiveJobSpec.started.set
      ActiveJobSpec.gate.wait(10)
    end
    raise ActiveJobSpec::Discardable, "drop it" if payload["discard"]
    retry_job if payload["retry"]
    raise "unhandled" if payload["fail"]
  end
end

class AjSingleAttemptJob < AjSpecJob
  workhorse_options max_attempts: 1

  def perform = raise("last try")
end

class AjPriorityJob < AjSpecJob
  queue_with_priority 101

  def perform = nil
end

class AjContractJob < AjSpecJob
  workhorse_options task_type: "spec.active_job.contract"

  def perform(_payload) = nil
end

class AjCountingJob < AjSpecJob
  def perform(_payload = nil)
    now = ActiveJobSpec.running.increment
    ActiveJobSpec.peak.update { |peak| [peak, now].max }
    sleep(0.2)
    ActiveJobSpec.running.decrement
  end
end

class AjTypedCountingJob < AjCountingJob
  workhorse_options task_type: "spec.active_job.counting"
end

RSpec.describe "Active Job adapter against PostgreSQL" do
  include_context "with a scratch database"

  typed_type = "spec.active_job.typed"

  before do
    # A fork would otherwise close these connections, which the parent still holds.
    @pool = ConnectionPool.new(size: 6, timeout: 5, auto_reload_after_fork: false) { ScratchDatabase.connect }
    @adapter = ActiveJob::QueueAdapters::StablematesWorkhorseAdapter.new(@pool)
    @previous_adapter = ActiveJob::Base.queue_adapter
    ActiveJob::Base.queue_adapter = @adapter
    ActiveJobSpec.reset(@queue_name)
  end

  after do
    ActiveJob::Base.queue_adapter = @previous_adapter
    @pool&.shutdown(&:close)
  end

  status_sql = <<~SQL
    SELECT COALESCE(outcome.state, runtime.state) AS state, COALESCE(outcome.error, runtime.error) AS error,
           COALESCE(outcome.current_attempt, runtime.current_attempt) AS attempt
      FROM workhorse.task task
      LEFT JOIN workhorse.task_runtime runtime ON runtime.task_id = task.id
      LEFT JOIN workhorse.task_outcome outcome ON outcome.task_id = task.id
     WHERE task.id = $1
  SQL

  define_method(:status) { |task_id| @connection.exec_params(status_sql, [task_id]).first }

  def state(task_id) = status(task_id)["state"]

  def worker(pool = @pool, jobs: [AjTypedJob], concurrency: 1, **options)
    subject = W::Worker.new(pool, queues: [@queue_name], polling_only: true, poll_interval: 0.01,
      disable_registry: true, concurrency: concurrency, **options)
    W::ActiveJob.handle(subject, jobs: jobs)
  end

  def tasks
    @connection.exec_params("SELECT task.*, runtime.run_at FROM workhorse.task task
      LEFT JOIN workhorse.task_runtime runtime ON runtime.task_id = task.id
      WHERE task.queue_name = $1 ORDER BY task.created_at, task.id", [@queue_name]).to_a
  end

  def payload(task_id) = JSON.parse(task_row(task_id).fetch("payload"))

  def tags(task_id) = PG::TextDecoder::Array.new.decode(task_row(task_id).fetch("tags"))

  def make_ready(task_id)
    @connection.exec_params("UPDATE workhorse.task_runtime SET run_at = clock_timestamp(), state = 'ready',
      ready_at = clock_timestamp(), sequence = nextval('workhorse.ready_sequence_seq') WHERE task_id = $1 AND state = 'scheduled'", [task_id])
  end

  def wait_until(timeout = 10)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
    until yield
      raise "condition not met within #{timeout} seconds" if Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline

      sleep 0.02
    end
  end

  def root = File.expand_path("../../..", __dir__)

  def peer(*arguments)
    output, error, status = Open3.capture3(File.join(root, "node_modules/.bin/tsx"),
      File.join(root, "typescript/core/test/ruby-active-job-peer.ts"), *arguments, chdir: root)
    raise "the TypeScript peer failed: #{error}" unless status.success?

    output
  end

  def epoch(time) = task_time(time).to_f

  def task_time(text) = Time.parse("#{text} UTC")

  it "runs a default job and a typed job through the worker" do
    default = AjDefaultJob.perform_later("a", :sym)
    typed = AjTypedJob.perform_later({"n" => 1})

    expect(worker.run_once).to be(true)

    expect([state(default.provider_job_id), state(typed.provider_job_id)]).to eq(%w[succeeded succeeded])
    by_task = ActiveJobSpec.seen.to_h { |entry| [entry["provider_job_id"], entry] }
    expect(by_task[default.provider_job_id].values_at("account", "symbol", "job_id"))
      .to eq(["a", :sym, default.job_id])
    expect(by_task[typed.provider_job_id].values_at("payload", "job_id")).to eq([{"n" => 1}, typed.job_id])
    expect(task_row(default.provider_job_id).values_at("task_type", "queue_name")).to eq(["active_job", @queue_name])
    expect(payload(default.provider_job_id).values_at("job_class", "job_id", "arguments"))
      .to eq(JSON.parse(JSON.generate(default.serialize.values_at("job_class", "job_id", "arguments"))))
    expect(task_row(typed.provider_job_id).values_at("task_type", "queue_name")).to eq([typed_type, @queue_name])
    expect(payload(typed.provider_job_id)).to eq({"n" => 1})
  end

  it "tags each task with its job class and job ID and applies workhorse_options" do
    default = AjDefaultJob.perform_later("a")
    typed = AjTypedJob.perform_later({})

    expect(tags(default.provider_job_id)).to eq(["active_job:AjDefaultJob", "active_job_id:#{default.job_id}", "spec"])
    expect(tags(typed.provider_job_id)).to eq(["active_job:AjTypedJob", "active_job_id:#{typed.job_id}"])
    expect(task_row(default.provider_job_id)["max_attempts"]).to eq("25")
    expect(task_row(typed.provider_job_id)["max_attempts"]).to eq("3")
  end

  it "omits the class tag of a class name longer than a tag" do
    long = Class.new(AjSpecJob) { def perform = nil }
    stub_const("Aj#{"Long" * 25}Job", long)
    job = long.perform_later

    expect(tags(job.provider_job_id)).to eq(["active_job_id:#{job.job_id}"])
  end

  it "sets a concurrency key from a String or a lambda over the job" do
    default = AjDefaultJob.perform_later("42")
    typed = AjTypedJob.perform_later({})

    expect(task_row(default.provider_job_id)["concurrency_key"]).to eq("account:42")
    expect(task_row(typed.provider_job_id)["concurrency_key"]).to eq("typed")
  end

  it "passes queue_as and priority through for both formats and refuses an out-of-range priority" do
    default = AjDefaultJob.set(priority: 7).perform_later("a")
    typed = AjTypedJob.set(priority: 100, queue: "#{@queue_name}-other").perform_later({})
    refused = AjPriorityJob.perform_later

    expect(task_row(default.provider_job_id).values_at("queue_name", "priority")).to eq([@queue_name, "7"])
    expect(task_row(typed.provider_job_id).values_at("queue_name", "priority")).to eq(["#{@queue_name}-other", "100"])
    expect(refused).to be(false)
    expect(AjPriorityJob.new.tap { |job| job.priority = -1 }.enqueue).to be(false)
    expect(task_count).to eq(1)
  end

  it "records enqueue_error when perform_later refuses a priority" do
    job = AjPriorityJob.new
    expect(job.enqueue).to be(false)
    expect(job.successfully_enqueued?).to be(false)
    expect(job.enqueue_error).to be_a(ActiveJob::EnqueueError)
    expect(job.enqueue_error.message).to include("priority must be nil or an Integer from 0 through 100")
    expect(job.provider_job_id).to be_nil
    expect(task_count).to eq(0)
  end

  it "sets run_at from set(wait:) and set(wait_until:) for both formats" do
    at = Time.utc(2099, 1, 2, 3, 4, 5.25r)
    jobs = [
      AjDefaultJob.set(wait: 3600).perform_later("a"),
      AjTypedJob.set(wait: 3600).perform_later({}),
      AjDefaultJob.set(wait_until: at).perform_later("b"),
      AjTypedJob.set(wait_until: at).perform_later({})
    ]

    run_at = jobs.map do |job|
      task_time(@connection.exec_params("SELECT run_at FROM workhorse.task_runtime WHERE task_id = $1",
        [job.provider_job_id]).getvalue(0, 0))
    end
    expect(run_at.first(2)).to all(be_within(60).of(Time.now + 3600))
    expect(run_at.last(2)).to eq([at, at])
    expect(jobs.map { |job| state(job.provider_job_id) }).to all(eq("scheduled"))
  end

  it "enqueues perform_all_later jobs of both formats in one batch and records enqueue_error on an invalid priority" do
    jobs = [AjDefaultJob.new("a"), AjTypedJob.new({"n" => 1}), AjPriorityJob.new,
      AjTypedJob.new({"n" => 2}).set(wait: 3600)]
    batches = []
    allow_any_instance_of(W::Queue).to receive(:enqueue_many).and_wrap_original do |original, requests|
      batches << requests.length
      original.call(requests)
    end

    expect(ActiveJob.perform_all_later(jobs)).to be_nil
    expect(batches).to eq([3])
    expect(jobs.map(&:successfully_enqueued?)).to eq([true, true, false, true])
    expect(jobs[2].enqueue_error).to be_a(ActiveJob::EnqueueError)
    expect(tasks.map { |row| row["id"] }).to match_array(jobs.values_at(0, 1, 3).map(&:provider_job_id))
    expect(state(jobs[3].provider_job_id)).to eq("scheduled")
  end

  it "clears a perform_all_later job's earlier enqueue_error once a later call enqueues it" do
    job = AjPriorityJob.new
    expect(ActiveJob.perform_all_later([job])).to be_nil
    expect([job.successfully_enqueued?, job.enqueue_error]).to match([false, be_a(ActiveJob::EnqueueError)])

    job.priority = 5
    expect(ActiveJob.perform_all_later([job])).to be_nil
    expect([job.successfully_enqueued?, job.enqueue_error]).to eq([true, nil])
    expect(task_row(job.provider_job_id)["priority"]).to eq("5")
  end

  it "records the enqueuing trace context for both formats" do
    parent = OpenTelemetry::Trace::SpanContext.new
    context = OpenTelemetry::Trace.context_with_span(OpenTelemetry::Trace.non_recording_span(parent))
    jobs = OpenTelemetry::Context.with_current(context) do
      [AjDefaultJob.perform_later("a"), AjTypedJob.perform_later({})]
    end

    jobs.each do |job|
      expect(JSON.parse(task_row(job.provider_job_id).fetch("trace_context"))["traceparent"])
        .to include(parent.hex_trace_id)
    end
  end

  it "completes a default job's task and enqueues a new one when retry_on matches" do
    ActiveJobSpec.failures_left = 1
    first = AjDefaultJob.perform_later("retry")
    expect(worker.run_once).to be(true)

    second = tasks.map { |row| row["id"] } - [first.provider_job_id]
    expect(second.length).to eq(1)
    expect([state(first.provider_job_id), state(second.first)]).to eq(%w[succeeded succeeded])
    expect(tags(second.first)).to include("active_job_id:#{first.job_id}")
    expect(payload(second.first)["executions"]).to eq(1)
    expect(ActiveJobSpec.seen.map { |entry| entry.values_at("job_id", "executions") })
      .to eq([[first.job_id, 1], [first.job_id, 2]])
  end

  it "completes the task when discard_on matches, for both formats" do
    ActiveJobSpec.failures_left = 1
    default = AjDefaultJob.perform_later("discard")
    typed = AjTypedJob.perform_later({"discard" => true})
    subject = worker
    2.times { subject.run_once }

    expect([state(default.provider_job_id), state(typed.provider_job_id)]).to eq(%w[succeeded succeeded])
    expect(task_count).to eq(2)
  end

  it "fails the attempt under the Workhorse retry policy on an exception Active Job re-raises" do
    ActiveJobSpec.failures_left = 1
    retried = AjDefaultJob.perform_later("unhandled")
    last = AjSingleAttemptJob.perform_later
    subject = worker
    2.times { subject.run_once }

    expect(state(retried.provider_job_id)).to eq("scheduled")
    expect(JSON.parse(status(retried.provider_job_id)["error"])["message"]).to eq("unhandled")
    expect(state(last.provider_job_id)).to eq("failed")
    expect(task_count).to eq(2)

    make_ready(retried.provider_job_id)
    expect(subject.run_once).to be(true)
    expect(status(retried.provider_job_id).values_at("state", "attempt")).to eq(["succeeded", "2"])
  end

  it "refuses retry_job in a typed job, which fails the attempt without a second task" do
    typed = AjTypedJob.perform_later({"retry" => true})
    worker.run_once

    row = status(typed.provider_job_id)
    expect(row["state"]).to eq("scheduled")
    expect(JSON.parse(row["error"]).values_at("name", "message"))
      .to eq(["ArgumentError", "AjTypedJob is a typed job for #{typed_type}; retry_job would enqueue a second " \
        "task, so its retries belong to the Workhorse retry policy"])
    expect(task_count).to eq(1)
  end

  it "sets a typed job's executions from the attempt number" do
    typed = AjTypedJob.perform_later({"fail" => true})
    subject = worker
    subject.run_once
    make_ready(typed.provider_job_id)
    subject.run_once
    make_ready(typed.provider_job_id)
    subject.run_once

    expect(ActiveJobSpec.seen.map { |entry| entry["executions"] }).to eq([1, 2, 3])
    expect(status(typed.provider_job_id).values_at("state", "attempt")).to eq(["failed", "3"])
  end

  it "refuses a typed payload that is not one Hash with String keys before any statement" do
    executor = FakeExecutor.new
    ActiveJob::Base.queue_adapter = ActiveJob::QueueAdapters::StablematesWorkhorseAdapter.new(executor)

    [[{n: 1}], [{"n" => :symbol}], [[1]], ["text"], [{}, {}], [], [{"at" => Time.now}]].each do |arguments|
      expect { AjTypedJob.perform_later(*arguments) }.to raise_error(ArgumentError, /AjTypedJob/)
    end
    expect { ActiveJob.perform_all_later([AjTypedJob.new({n: 1})]) }.to raise_error(ArgumentError)
    expect(executor.statements).to eq([])
  end

  it "runs a typed task another SDK enqueued, with a reserved key as a plain key" do
    input = {"_aj_globalid" => "gid://other/Thing/1", "_aj_symbol_keys" => ["n"], "n" => 1}
    task_id = peer("enqueue", ScratchDatabase.url, @queue_name, typed_type, JSON.generate(input))

    expect(worker.run_once).to be(true)
    expect(state(task_id)).to eq("succeeded")
    expect(ActiveJobSpec.seen.map { |entry| entry.values_at("payload", "job_id", "provider_job_id", "executions") })
      .to eq([[input, task_id, task_id, 1]])
  end

  it "hands a typed perform_later task to a handler in another SDK" do
    job = AjTypedJob.perform_later({"from" => "ruby", "list" => [1, 2.5, nil, true]})
    received = peer("run", ScratchDatabase.url, @queue_name, typed_type)

    expect(JSON.parse(received)).to eq({"from" => "ruby", "list" => [1, 2.5, nil, true]})
    expect(state(job.provider_job_id)).to eq("succeeded")
    expect(ActiveJobSpec.seen).to eq([])
  end

  it "applies the payload contract synced for a typed task type at enqueue" do
    schema = {"type" => "object", "properties" => {"to" => {"type" => "string"}}, "required" => ["to"]}
    version = W::TaskContractVersion.new(payload_schema: schema)
    queue.sync_contracts("spec.active_job.contract" => W::TaskTypeContracts.new(current_version: "v1",
      versions: {"v1" => version}))

    expect { AjContractJob.perform_later({"cc" => "x"}) }.to raise_error(W::ContractValidationError)
    accepted = AjContractJob.perform_later({"to" => "a@b.c"})
    expect(task_row(accepted.provider_job_id)["contract_version"]).to eq("v1")
    expect(task_count).to eq(1)
  end

  it "refuses to handle a listed class without a task type or two classes with one task type" do
    subject = W::Worker.new(@pool, queues: [@queue_name], disable_registry: true)
    twin = Class.new(AjSpecJob) { workhorse_options task_type: "spec.active_job.typed" }
    stub_const("AjTwinJob", twin)

    expect { W::ActiveJob.handle(subject, jobs: [AjDefaultJob]) }
      .to raise_error(ArgumentError, "AjDefaultJob declares no task type; a default job runs under active_job " \
        "without being listed")
    expect { W::ActiveJob.handle(subject, jobs: [AjTypedJob, twin]) }
      .to raise_error(ArgumentError, "AjTypedJob and AjTwinJob both declare task type spec.active_job.typed")
    expect { W::ActiveJob.handle(subject, jobs: [Object]) }.to raise_error(ArgumentError)
    expect { W::ActiveJob.handle(Object.new) }.to raise_error(ArgumentError, "handle needs a Worker")
  end

  it "rejects unknown workhorse_options keys and invalid values when the class loads" do
    define = ->(**options) { Class.new(AjSpecJob) { workhorse_options(**options) } }

    expect { define.call(retry_policy: {}) }
      .to raise_error(ArgumentError, "workhorse_options does not accept :retry_policy")
    [{task_type: ""}, {task_type: "active_job"}, {task_type: :sym}, {task_type: "x" * 257},
      {max_attempts: 0}, {max_attempts: 101}, {tags: ["a"] * 19}, {tags: [""]}, {tags: "a"},
      {concurrency_key: ""}, {concurrency_key: 1}].each do |options|
      expect { define.call(**options) }.to raise_error(ArgumentError, /workhorse_options #{options.keys.first}:/)
    end
    expect(define.call(task_type: "x" * 256, max_attempts: 100, tags: ["a"] * 18).workhorse_settings.keys)
      .to eq(%i[task_type max_attempts tags])
  end

  it "runs no more jobs of either format at once than the worker's concurrency" do
    jobs = Array.new(3) { AjCountingJob.perform_later } + Array.new(3) { AjTypedCountingJob.perform_later({}) }
    subject = worker(jobs: [AjTypedCountingJob], concurrency: 2)
    thread = Thread.new { subject.run }
    wait_until { jobs.all? { |job| state(job.provider_job_id) == "succeeded" } }
    subject.stop
    expect(thread.join(10)&.value).to be_nil

    expect(ActiveJobSpec.peak.value).to eq(2)
  end

  it "drains a running job of either format when the worker stops" do
    ActiveJobSpec.hold = true
    jobs = [AjDefaultJob.perform_later("a"), AjTypedJob.perform_later({})]
    subject = worker(concurrency: 2)
    thread = Thread.new { subject.run }
    wait_until { ActiveJobSpec.seen.length == 2 }
    subject.stop
    wait_until { @adapter.stopping? == false && subject.stopping? }
    sleep 0.1
    expect(thread).to be_alive

    ActiveJobSpec.gate.set
    expect(thread.join(10)&.value).to be_nil
    expect(jobs.map { |job| state(job.provider_job_id) }).to eq(%w[succeeded succeeded])
  end

  it "reruns a job of either format whose worker died mid-perform" do
    jobs = [AjDefaultJob.perform_later("crash"), AjTypedJob.perform_later({"crash" => true})]
    url = ScratchDatabase.url
    queue_name = @queue_name
    reader, writer = IO.pipe
    pid = Process.fork do
      reader.close
      pool = ConnectionPool.new(size: 4, timeout: 5) { PG.connect(url) }
      ActiveJob::Base.queue_adapter = ActiveJob::QueueAdapters::StablematesWorkhorseAdapter.new(pool)
      ActiveJobSpec.reset(queue_name)
      ActiveJobSpec.hold = true
      subject = W::Worker.new(pool, queues: [queue_name], polling_only: true, poll_interval: 0.01,
        disable_registry: true, concurrency: 2, lease: 0.5, heartbeat: 0.1)
      W::ActiveJob.handle(subject, jobs: [AjTypedJob])
      Thread.new do
        2.times { ActiveJobSpec.started.wait(10) && sleep(0.05) }
        wait_until { ActiveJobSpec.seen.length == 2 }
        writer.puts("running")
        writer.flush
      end
      subject.run
      Kernel.exit!(0)
    rescue Exception => e # standard:disable Lint/RescueException
      warn("#{e.class}: #{e.message}")
      Kernel.exit!(99)
    end
    writer.close
    expect(IO.select([reader], nil, nil, 15)).not_to be_nil
    expect(reader.gets).to eq("running\n")
    Process.kill("KILL", pid)
    Process.wait(pid)
    pid = nil
    expect(jobs.map { |job| state(job.provider_job_id) }).to eq(%w[active active])

    subject = worker
    wait_until(15) do
      subject.run_once
      jobs.all? { |job| state(job.provider_job_id) == "succeeded" }
    end
    expect(jobs.map { |job| status(job.provider_job_id)["attempt"] }).to eq(%w[2 2])
    # A default job reruns from its enqueued payload. A typed job counts the attempt the crash cost.
    expect(ActiveJobSpec.seen.to_h { |entry| [entry["provider_job_id"], entry["executions"]] })
      .to eq(jobs[0].provider_job_id => 1, jobs[1].provider_job_id => 2)
  ensure
    if pid
      Process.kill("KILL", pid)
      Process.wait(pid)
    end
    reader&.close
  end

  it "resumes a continuation that the worker's stop interrupted as a new task" do
    skip("Active Job #{ActiveJob.gem_version} has no continuations") unless defined?(ActiveJob::Continuable)

    continuation = Class.new(AjSpecJob) do
      include ActiveJob::Continuable

      self.resume_options = {wait: 0}

      def perform
        step(:first) do
          ActiveJobSpec.seen << "first"
          ActiveJobSpec.started.set
          ActiveJobSpec.gate.wait(10)
        end
        step(:second) { ActiveJobSpec.seen << "second" }
      end
    end
    stub_const("AjContinuationJob", continuation)
    first = continuation.perform_later
    subject = worker
    thread = Thread.new { subject.run }
    expect(ActiveJobSpec.started.wait(10)).to be(true)
    subject.stop
    wait_until { subject.stopping? }
    ActiveJobSpec.gate.set
    expect(thread.join(10)&.value).to be_nil

    expect(state(first.provider_job_id)).to eq("succeeded")
    resumed = tasks.map { |row| row["id"] } - [first.provider_job_id]
    expect(resumed.length).to eq(1)
    expect(payload(resumed.first)["continuation"]).to include("completed" => ["first"])
    expect(worker.run_once).to be(true)
    expect(state(resumed.first)).to eq("succeeded")
    expect(ActiveJobSpec.seen).to eq(%w[first second])
  end

  context "with Active Record connected" do
    before do
      ActiveRecord::Base.establish_connection("#{ScratchDatabase.url}?pool=2")
      ActiveJob::Base.queue_adapter = ActiveJob::QueueAdapters::StablematesWorkhorseAdapter.new
      AjSpecJob.enqueue_after_transaction_commit = false if AjSpecJob.respond_to?(:enqueue_after_transaction_commit=)
    end

    after do
      ActiveRecord::Base.connection_handler.clear_all_connections!
      ActiveRecord::Base.remove_connection
    end

    it "commits and rolls back a perform_later of either format with the caller's Active Record transaction" do
      committed = nil
      ActiveRecord::Base.transaction do
        committed = [AjDefaultJob.perform_later("a"), AjTypedJob.perform_later({})]
        expect(task_count).to eq(0)
      end
      expect(task_count).to eq(2)

      ActiveRecord::Base.transaction do
        AjDefaultJob.perform_later("b")
        ActiveJob.perform_all_later([AjTypedJob.new({}), AjDefaultJob.new("c")])
        raise ActiveRecord::Rollback
      end
      expect(task_count).to eq(2)
      expect(tasks.map { |row| row["id"] }).to match_array(committed.map(&:provider_job_id))
    end
  end

  it "loads beside the workhorse gem in either order" do
    lib = File.expand_path("../../lib", __dir__)
    check = "ActiveJob::Base.queue_adapter = :stablemates_workhorse; " \
      'raise "adapter" unless ActiveJob::Base.queue_adapter.is_a?(ActiveJob::QueueAdapters::StablematesWorkhorseAdapter); ' \
      'raise "sitrox" unless Workhorse.is_a?(Module) && defined?(Workhorse::Worker) && ' \
      "Workhorse::Worker != Stablemates::Workhorse::Worker; print :ok"
    [%w[workhorse active_job stablemates/workhorse], %w[active_job stablemates/workhorse workhorse]].each do |order|
      requires = order.flat_map { |name| ["-r", name] }
      output, error, status = Open3.capture3(RbConfig.ruby, "-I", lib, *requires, "-e", check)
      expect([status.success?, output]).to eq([true, "ok"]), error
    end
  end
end
