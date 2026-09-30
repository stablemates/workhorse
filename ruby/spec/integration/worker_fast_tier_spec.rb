# frozen_string_literal: true

require "connection_pool"

RSpec.describe "Worker on the fast tier against PostgreSQL" do
  include_context "with a scratch database"

  before { @pool = ConnectionPool.new(size: 6, timeout: 5) { ScratchDatabase.connect } }

  after { @pool&.shutdown(&:close) }

  outcomes_sql = "SELECT task_id::text, state, attempt FROM workhorse.fast_task_outcome WHERE task_id = ANY($1::uuid[])"

  def make_fast(name = @queue_name)
    tier = @connection.exec_params(W::SqlCatalogue::SET_QUEUE_TIER_V1,
      [name, "fast", "ruby-fast-tier-spec", "exercise the fast tier"]).getvalue(0, 0)
    expect(tier).to eq("fast")
  end

  def worker(**options)
    W::Worker.new(@pool, queues: [@queue_name], polling_only: true, poll_interval: 0.01, disable_registry: true,
      shared_heartbeats: true, **options)
  end

  # Runs +subject+ until the block holds, then stops it and returns the run's error, if any.
  def run_until(subject, timeout = 20)
    runner = Thread.new { subject.run }
    runner.report_on_exception = false
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + timeout
    until yield
      raise "the worker did not finish in time" if Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline
      raise runner.value.inspect unless runner.alive?

      sleep 0.02
    end
  ensure
    subject.stop
    expect(runner.join(10)).not_to be_nil
    runner.value
  end

  # Records every complete_many_and_claim_v1 call as [completions, claim limit, tasks claimed].
  def record_fused(subject, calls)
    executor = subject.instance_variable_get(:@executor)
    original = executor.method(:rows)
    executor.define_singleton_method(:rows) do |sql, params = []|
      rows = original.call(sql, params)
      if sql == W::SqlCatalogue::COMPLETE_MANY_AND_CLAIM_V1
        completions = params[1].delete("{}").split(",").size
        calls << [completions, Integer(params[5], 10), rows.count { |row| row["task_id"] }]
      end
      rows
    end
  end

  define_method(:outcomes) do |task_ids|
    @connection.exec_params(outcomes_sql, [PG::TextEncoder::Array.new.encode(task_ids)]).values
  end

  it "runs fast-tier tasks and records one fast_task_outcome row for each" do
    make_fast
    succeeding = Array.new(12) { |index| queue.enqueue("fast", {"index" => index}).task_id }
    failing = queue.enqueue("fast-failure", {}, max_attempts: 1).task_id
    task_ids = succeeding + [failing]
    subject = worker(concurrency: 4).handle("fast") { |payload| {"index" => payload["index"]} }
      .handle("fast-failure") { raise "fast failure" }

    run_until(subject) { outcomes(task_ids).size == task_ids.size }

    rows = outcomes(task_ids)
    expect(rows.map(&:first)).to match_array(task_ids)
    expect(rows.to_h { |task_id, state, attempt| [task_id, [state, attempt]] })
      .to eq(succeeding.to_h { |task_id| [task_id, %w[succeeded 1]] }.merge(failing => %w[failed 1]))
    expect(@connection.exec_params("SELECT count(*) FROM workhorse.task_outcome WHERE task_id = ANY($1::uuid[])",
      [PG::TextEncoder::Array.new.encode(task_ids)]).getvalue(0, 0)).to eq("0")
  end

  it "fails a fast-tier attempt that calls a durable step, before any durable write" do
    make_fast
    task_id = queue.enqueue("fast-durable", {}, max_attempts: 1).task_id
    raised = Queue.new
    subject = worker(concurrency: 1).handle("fast-durable") do |_payload, context|
      context.checkpoint("step") { raise "the checkpoint block must not run" }
    rescue => e
      raised << e
      raise
    end

    run_until(subject) { outcomes([task_id]).size == 1 }

    error = raised.pop
    expect(error).to be_a(W::FastTierUnsupportedError)
    expect([error.queue, error.feature, error.message])
      .to eq([@queue_name, "checkpoints", "Fast-tier queue #{@queue_name} does not support checkpoints"])
    row = @connection.exec_params("SELECT state, error->>'name' FROM workhorse.fast_task_outcome WHERE task_id = $1",
      [task_id]).values
    expect(row).to eq([%w[failed Stablemates::Workhorse::FastTierUnsupportedError]])
    expect(@connection.exec_params("SELECT count(*) FROM workhorse.task_checkpoint WHERE task_id = $1",
      [task_id]).getvalue(0, 0)).to eq("0")
  end

  it "fails a durable step on a queue that moved to the fast tier while the worker claimed it as full" do
    raised = Queue.new
    subject = worker(concurrency: 1).handle("fast-durable") do |_payload, context|
      context.checkpoint("step") { raise "the checkpoint block must not run" }
    rescue => e
      raised << e
      raise
    end
    # The first run learns that the empty queue is on the full tier and stops probing it.
    run_until(subject) { subject.instance_variable_get(:@full_tier_until).key?(@queue_name) }
    make_fast
    task_id = queue.enqueue("fast-durable", {}, max_attempts: 1).task_id

    # The second run claims through claim_many_v1 until the probe, and so claims a fast-tier task.
    run_until(subject) { outcomes([task_id]).size == 1 }

    expect(raised.pop).to be_a(W::FastTierUnsupportedError)
    expect(outcomes([task_id])).to eq([[task_id, "failed", "1"]])
    expect(@connection.exec_params("SELECT count(*) FROM workhorse.task_checkpoint WHERE task_id = $1",
      [task_id]).getvalue(0, 0)).to eq("0")
    expect(subject.instance_variable_get(:@full_tier_until)).not_to have_key(@queue_name)
  end

  # Delays each tier read of +subject+ by +delay+ seconds, and fails the first one when +fail_first+.
  def slow_tier_reads(subject, delay, fail_first: false)
    reads = Concurrent::AtomicFixnum.new
    executor = subject.instance_variable_get(:@executor)
    original = executor.method(:rows)
    executor.define_singleton_method(:rows) do |sql, params = []|
      if sql == W::SqlCatalogue::QUEUE_CONTROL
        sleep delay
        raise "the tier read failed" if fail_first && reads.increment == 1
      end
      original.call(sql, params)
    end
  end

  # Runs +subject+ once so it caches the empty queue as full-tier, then moves the queue to the fast
  # tier and enqueues one single-attempt task that the next run claims through claim_many_v1.
  def cut_over(subject)
    run_until(subject) { subject.instance_variable_get(:@full_tier_until).key?(@queue_name) }
    make_fast
    queue.enqueue("fast-durable", {}, max_attempts: 1).task_id
  end

  def fast_outcome(task_id)
    @connection.exec_params("SELECT state, attempt, error->>'name' FROM workhorse.fast_task_outcome WHERE task_id = $1",
      [task_id]).values
  end

  def checkpoint_count(task_id)
    @connection.exec_params("SELECT count(*) FROM workhorse.task_checkpoint WHERE task_id = $1", [task_id]).getvalue(0, 0)
  end

  it "reads the tier of a cutover claim under the heartbeat, so a slow read keeps the lease" do
    raised = Queue.new
    subject = worker(concurrency: 1, lease: 0.2, heartbeat: 0.05).handle("fast-durable") do |_payload, context|
      context.checkpoint("step") { raise "the checkpoint block must not run" }
    rescue => e
      raised << e
      raise
    end
    task_id = cut_over(subject)
    slow_tier_reads(subject, 0.5)

    run_until(subject) { fast_outcome(task_id).any? }

    expect(raised.pop).to be_a(W::FastTierUnsupportedError)
    # The handler's own failure, not an expired lease, ended the attempt.
    expect(fast_outcome(task_id)).to eq([%w[failed 1 Stablemates::Workhorse::FastTierUnsupportedError]])
    expect(checkpoint_count(task_id)).to eq("0")
  end

  it "raises a slow failed tier read from the durable call before any durable write" do
    raised = Queue.new
    subject = worker(concurrency: 1, lease: 0.2, heartbeat: 0.05).handle("fast-durable") do |_payload, context|
      context.checkpoint("step") { raise "the checkpoint block must not run" }
    rescue => e
      raised << e
      raise
    end
    task_id = cut_over(subject)
    slow_tier_reads(subject, 0.5, fail_first: true)

    run_until(subject) { fast_outcome(task_id).any? }

    expect(raised.pop.message).to eq("the tier read failed")
    expect(fast_outcome(task_id)).to eq([%w[failed 1 RuntimeError]])
    expect(checkpoint_count(task_id)).to eq("0")
    expect(subject.instance_variable_get(:@tier_reads)).to be_empty
  end

  it "keeps the lease of a full-tier task while a slow tier read admits its checkpoint" do
    reads = Concurrent::AtomicFixnum.new
    subject = worker(concurrency: 1, lease: 0.2, heartbeat: 0.05).handle("full-durable") do |_payload, context|
      context.checkpoint("step") { reads.increment }
      {}
    end
    slow_tier_reads(subject, 0.5)
    task_id = queue.enqueue("full-durable", {}, max_attempts: 1).task_id
    state = lambda do
      @connection.exec_params("SELECT state FROM workhorse.task_outcome WHERE task_id = $1", [task_id]).values
    end

    run_until(subject) { state.call.any? }

    expect(state.call).to eq([["succeeded"]])
    expect(reads.value).to eq(1)
    expect(checkpoint_count(task_id)).to eq("1")
  end

  it "fuses each completion with a refill claim bounded by its slot cohort" do
    make_fast
    task_ids = Array.new(40) { |index| queue.enqueue("cohort", {"index" => index}).task_id }
    lock = Mutex.new
    running = {now: 0, peak: 0}
    calls = Concurrent::Array.new
    subject = worker(concurrency: 8, cohorts: 2).handle("cohort") do
      lock.synchronize do
        running[:now] += 1
        running[:peak] = [running[:peak], running[:now]].max
      end
      sleep 0.01
      {}
    ensure
      lock.synchronize { running[:now] -= 1 }
    end
    expect(subject.cohorts).to eq(2)
    record_fused(subject, calls)

    run_until(subject) { outcomes(task_ids).size == task_ids.size }

    expect(outcomes(task_ids).map { |_, state, attempt| [state, attempt] }.uniq).to eq([%w[succeeded 1]])
    completing = calls.select { |completions, _limit, _claimed| completions.positive? }
    expect(completing.sum { |completions, _, _| completions }).to eq(task_ids.size)
    # Each cohort's startup claim fills its own four slots.
    expect(calls.reject { |completions, _, _| completions.positive? }.first(2)).to eq([[0, 4, 4], [0, 4, 4]])
    # A statement carries only one cohort's completions and claims only into that cohort.
    expect(completing.map { |completions, limit, _| [completions, limit].max }.max).to be <= 4
    expect(completing.count { |_, _, claimed| claimed.positive? }).to be_positive
    expect(running[:peak]).to be <= 8
  end

  it "delivers a batch handler's tasks in one call on the fast tier and settles each on its own" do
    make_fast
    task_ids = Array.new(3) { |index| queue.enqueue("batch", {"index" => index}, priority: index, max_attempts: 1).task_id }
    calls = Concurrent::Array.new
    subject = worker(concurrency: 3)
    subject.handle_batch("batch", max_size: 3, linger: 1) do |payloads, context|
      calls << [payloads.map { |payload| payload["index"] }, context.tasks.map(&:id), context.cancellation.cancelled?]
      payloads.map do |payload|
        next {status: :failed, error: ArgumentError.new("odd")} if payload["index"].odd?

        {status: :succeeded, result: {"index" => payload["index"]}}
      end
    end

    expect(subject.run_once).to be(true)
    expect(calls).to eq([[[2, 1, 0], task_ids.reverse, false]])
    expect(outcomes(task_ids).to_h { |task_id, state, _| [task_id, state] })
      .to eq(task_ids.zip(%w[succeeded failed succeeded]).to_h)
  end

  it "fails every batch member when the handler returns the wrong number of outcomes" do
    task_ids = Array.new(2) { queue.enqueue("short", {}, max_attempts: 1).task_id }
    subject = worker(concurrency: 2)
    subject.handle_batch("short", max_size: 2, linger: 1) { |payloads, _| [{status: :succeeded, result: {}}] * (payloads.size - 1) }

    expect(subject.run_once).to be(true)
    errors = task_ids.map do |task_id|
      JSON.parse(@connection.exec_params("SELECT error FROM workhorse.task_outcome WHERE task_id = $1", [task_id])
        .getvalue(0, 0))
    end
    expect(errors.map { |error| error["message"] }.uniq.size).to eq(1)
    expect(errors.first["message"]).to match(/outcome/)
  end

  it "fails every member with a RuntimeError when the batch handler returns or raises a non-StandardError" do
    task_ids = Array.new(2) { |index| queue.enqueue("exit", {"raise" => index.zero?}, max_attempts: 1).task_id }
    subject = worker(concurrency: 2)
    subject.handle_batch("exit", max_size: 1, linger: 0) do |payloads, _|
      raise SystemExit, "raised exit" if payloads.first["raise"]

      [{status: :failed, error: SystemExit.new("returned exit")}]
    end

    expect(subject.run_once).to be(true)
    errors = task_ids.map do |task_id|
      JSON.parse(@connection.exec_params("SELECT error FROM workhorse.task_outcome WHERE task_id = $1", [task_id])
        .getvalue(0, 0))
    end
    expect(errors.map { |error| error["message"] })
      .to eq(["Batch handler for exit raised SystemExit: raised exit", "Batch handler for exit returned SystemExit: returned exit"])
  end

  it "runs a lingering batch as soon as a stopping worker drains" do
    task_ids = Array.new(2) { queue.enqueue("linger", {}, max_attempts: 1).task_id }
    calls = Concurrent::Array.new
    subject = worker(concurrency: 3, shutdown_grace: 0.05)
    subject.handle_batch("linger", max_size: 3, linger: 30) do |payloads, context|
      calls << [payloads.size, context.cancellation.cancelled?]
      payloads.map { {status: :succeeded, result: {}} }
    end
    started = Process.clock_gettime(Process::CLOCK_MONOTONIC)

    expect(subject.run_once).to be(true)
    expect(Process.clock_gettime(Process::CLOCK_MONOTONIC) - started).to be < 10
    expect(calls).to eq([[2, false]])
    expect(outcomes(task_ids)).to be_empty
    expect(@connection.exec_params("SELECT count(*) FROM workhorse.task_outcome WHERE task_id = ANY($1::uuid[]) AND state = 'succeeded'",
      [PG::TextEncoder::Array.new.encode(task_ids)]).getvalue(0, 0)).to eq("2")
  end

  it "stops a continuous run during a batch's linger without abandoning its members" do
    task_ids = Array.new(2) { queue.enqueue("linger", {}, max_attempts: 1).task_id }
    calls = Concurrent::Array.new
    subject = worker(concurrency: 3, shutdown_grace: 0.05)
    subject.handle_batch("linger", max_size: 3, linger: 30) do |payloads, _|
      calls << payloads.size
      payloads.map { {status: :succeeded, result: {}} }
    end
    active = subject.instance_variable_get(:@active)

    expect(run_until(subject) { active.size == 2 }).to be_nil
    expect(calls).to eq([2])
    expect(@connection.exec_params("SELECT count(*) FROM workhorse.task_outcome WHERE task_id = ANY($1::uuid[]) AND state = 'succeeded'",
      [PG::TextEncoder::Array.new.encode(task_ids)]).getvalue(0, 0)).to eq("2")
  end

  it "cancels the batch token with the first member cancellation" do
    2.times { queue.enqueue("cancel", {}, max_attempts: 1) }
    reasons = Concurrent::Array.new
    subject = worker(concurrency: 2)
    subject.handle_batch("cancel", max_size: 2, linger: 1) do |payloads, context|
      active = subject.instance_variable_get(:@active)
      active[context.tasks.last.id].cancellation.cancel(:lease_lost)
      active[context.tasks.first.id].cancellation.cancel(:shutdown)
      reasons << context.cancellation.reason
      payloads.map { {status: :succeeded, result: {}} }
    end

    subject.run_once
    expect(reasons).to eq([:lease_lost])
  end

  it "keeps a plain claim and a fused refill from reserving the same free slot" do
    make_fast
    first = queue.enqueue("race", {"hold" => true}).task_id
    lock = Mutex.new
    running = {now: 0, peak: 0}
    release = Queue.new
    reserved = Queue.new
    started = Concurrent::Event.new
    armed = Concurrent::AtomicBoolean.new(false)
    subject = worker(concurrency: 2).handle("race") do |payload|
      lock.synchronize do
        running[:now] += 1
        running[:peak] = [running[:peak], running[:now]].max
      end
      if payload["hold"]
        started.set
        release.pop
      else
        sleep 0.3
      end
      {}
    ensure
      lock.synchronize { running[:now] -= 1 }
    end
    original_reserve = subject.method(:reserve_completion_claim)
    subject.define_singleton_method(:reserve_completion_claim) do |task|
      original_reserve.call(task).tap { reserved << true if task.id == first }
    end
    # The held task completes, and its fused claim reserves, after the dispatcher planned its
    # next plain claim but before that claim runs.
    original_start = subject.method(:start_claim)
    subject.define_singleton_method(:start_claim) do |*args|
      if armed.make_false
        release << true
        reserved.pop(timeout: 10)
      end
      original_start.call(*args)
    end
    task_ids = [first]

    expect(run_until(subject) do
      if started.set? && task_ids.size == 1
        task_ids.concat(Array.new(4) { queue.enqueue("race", {}).task_id })
        armed.make_true
      end
      outcomes(task_ids).size == 5
    end).to be_nil
    expect(running[:peak]).to be <= 2
  end

  it "keeps fused refills within the executor's threads while completions hand over in a row" do
    make_fast
    task_ids = Array.new(6) { |index| queue.enqueue("chain", {"index" => index}).task_id }
    errors = Concurrent::Array.new
    subject = worker(concurrency: 1, on_registration_error: ->(error) { errors << error }).handle("chain") { {} }
    # Each handler thread lingers after its fused completion, as a slow return would.
    original = subject.method(:settle_completion_claim)
    subject.define_singleton_method(:settle_completion_claim) do |*args|
      original.call(*args)
      sleep 0.05
    end

    expect(run_until(subject) { outcomes(task_ids).size == task_ids.size }).to be_nil
    expect(outcomes(task_ids).map { |_, state, attempt| [state, attempt] }.uniq).to eq([%w[succeeded 1]])
    expect(errors).to be_empty
  end
end
