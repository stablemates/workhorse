# frozen_string_literal: true

require "active_support/ordered_options"
require_relative "../../examples/active_job"

ActiveJob::Base.logger = Logger.new(nil)

# Runs every Ruby snippet the Active Job page shows against PostgreSQL.
#
# The snippets name the fixed queues `default` and `ml`, so each example runs in a database of its
# own rather than in the scratch database other specs share.
RSpec.describe "Active Job documentation examples against PostgreSQL" do
  examples = ActiveJobExamples

  around do |example|
    url = ScratchDatabase.extra("active-job-docs")
    skip(ScratchDatabase.skip_reason || "no scratch database") if url.nil?
    @url = url
    @connection = PG.connect(url)
    @connection.exec("SET client_min_messages TO warning;
      CREATE TABLE public.orders (id text PRIMARY KEY, status text)")
    ActiveRecord::Base.establish_connection("#{url}?pool=2")
    previous_adapter = ActiveJob::Base.queue_adapter
    ActiveJob::Base.queue_adapter = :stablemates_workhorse
    examples.performed.clear
    examples.timeouts = 0
    example.run
  ensure
    ActiveJob::Base.queue_adapter = previous_adapter if previous_adapter
    ActiveRecord::Base.remove_connection
    @connection&.close
    ScratchDatabase.drop_extra("active-job-docs")
  end

  def tasks
    @connection.exec("SELECT task.id, task.task_type, task.queue_name, task.priority, task.max_attempts,
        task.payload, task.tags, COALESCE(outcome.state, runtime.state) AS state
      FROM workhorse.task task
      LEFT JOIN workhorse.task_runtime runtime ON runtime.task_id = task.id
      LEFT JOIN workhorse.task_outcome outcome ON outcome.task_id = task.id
      ORDER BY task.created_at, task.id").to_a
  end

  def state(task_id) = tasks.find { |task| task["id"] == task_id }&.fetch("state")

  def worker
    @pool = ConnectionPool.new(size: 3) { PG.connect(@url) }
    W::Worker.new(@pool, queues: %w[default ml], polling_only: true, poll_interval: 0.01, disable_registry: true)
  end

  after { @pool&.shutdown(&:close) }

  it "selects the adapter by name" do
    config = ActiveSupport::OrderedOptions.new
    config.active_job = ActiveSupport::OrderedOptions.new
    examples.configure(config)

    expect(ActiveJob::QueueAdapters.lookup(config.active_job.queue_adapter))
      .to be(ActiveJob::QueueAdapters::StablematesWorkhorseAdapter)
  end

  it "enqueues the documented jobs and runs them beside a native handler" do
    examples.enqueue
    W::Queue.new(@connection).enqueue("invoice.charge", {"invoice_id" => "inv-1"})

    by_type = tasks.group_by { |task| task["task_type"] }
    classify = by_type.fetch("images.classify")
    expect(classify.map { |task| [task["queue_name"], task["priority"], task["max_attempts"], task["state"]] })
      .to eq([["ml", "0", "5", "ready"], ["ml", "0", "5", "scheduled"], ["ml", "90", "5", "ready"]])
    expect(JSON.parse(classify.first.fetch("payload"))).to eq({"blob_id" => 42, "model" => "v3"})
    expect(by_type.fetch("active_job").map { |task| [task["queue_name"], task["max_attempts"]] })
      .to eq([["default", "1"]])

    subject = nil
    allow(W).to receive(:run_worker_process) do |booted|
      subject = booted
      nil while booted.run_once
    end
    previous_url = ENV["DATABASE_URL"]
    begin
      ENV["DATABASE_URL"] = @url
      examples.boot_worker
    ensure
      ENV["DATABASE_URL"] = previous_url
    end
    # The snippet builds its own pool, which the worker holds.
    subject.instance_variable_get(:@pool).shutdown(&:close)

    expect(examples.performed).to contain_exactly(["classify", 42, "v3"], ["classify", 44, "v3"],
      ["sync", "sku-1"], ["charge", "inv-1"])
    expect(tasks.map { |task| task["state"] }.tally).to eq({"succeeded" => 4, "scheduled" => 1})
  end

  it "leaves retries to Active Job for a job that allows one attempt" do
    examples.timeouts = 1
    job = examples::SyncInventoryJob.perform_later("sku-2")
    subject = worker
    W::ActiveJob.handle(subject)
    subject.run_once

    retry_task = tasks.find { |task| task["id"] != job.provider_job_id }
    expect(state(job.provider_job_id)).to eq("succeeded")
    expect(retry_task.values_at("task_type", "max_attempts", "state")).to eq(["active_job", "1", "scheduled"])
    expect(retry_task.fetch("tags")).to include("active_job_id:#{job.job_id}")
  end

  it "enqueues inside the caller's transaction" do
    @connection.exec("INSERT INTO public.orders (id, status) VALUES ('order-1', 'open'), ('order-2', 'open')")
    examples.pay("order-1")
    ActiveRecord::Base.transaction do
      examples.pay("order-2")
      raise ActiveRecord::Rollback
    end

    expect(examples::ReceiptJob.enqueue_after_transaction_commit).to be(false)
    expect(@connection.exec("SELECT id, status FROM public.orders ORDER BY id").values)
      .to eq([["order-1", "paid"], ["order-2", "open"]])
    receipts = tasks.map { |task| JSON.parse(task.fetch("payload")).fetch("arguments") }
    expect(receipts).to eq([["order-1"]])
  end

  it "moves a typed job to a native handler without changing its call site" do
    subject = examples.native_worker(worker)
    job = examples::ClassifyImageJob.perform_later({"blob_id" => 7, "model" => "v4"})
    subject.run_once

    expect(state(job.provider_job_id)).to eq("succeeded")
    expect(examples.performed).to eq([["label", 7, "v4"]])
  end
end
