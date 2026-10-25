# frozen_string_literal: true

require "connection_pool"

RSpec.describe "Worker against PostgreSQL" do
  include_context "with a scratch database"

  before { @pool = ConnectionPool.new(size: 4, timeout: 5) { ScratchDatabase.connect } }

  after { @pool&.shutdown(&:close) }

  status_sql = <<~SQL
    SELECT COALESCE(outcome.state, runtime.state) AS state, outcome.result,
           COALESCE(outcome.error, runtime.error) AS error, COALESCE(outcome.current_attempt, runtime.current_attempt) AS attempt
      FROM workhorse.task task
      LEFT JOIN workhorse.task_runtime runtime ON runtime.task_id = task.id
      LEFT JOIN workhorse.task_outcome outcome ON outcome.task_id = task.id
     WHERE task.id = $1
  SQL

  define_method(:status) { |task_id| @connection.exec_params(status_sql, [task_id]).first }

  def worker(**options)
    W::Worker.new(@pool, queues: [@queue_name], polling_only: true, poll_interval: 0.01, disable_registry: true,
      **options)
  end

  def make_ready(task_id)
    @connection.exec_params("UPDATE workhorse.task_runtime SET run_at = clock_timestamp(), state = 'ready',
      ready_at = clock_timestamp() WHERE task_id = $1 AND state = 'scheduled'", [task_id])
  end

  it "completes a task and stores its result" do
    task_id = queue.enqueue("add", {"a" => 2, "b" => 3}).task_id
    seen = nil
    ran = worker.handle("add") { |payload, context|
      seen = context.task.attempt
      {"sum" => payload["a"] + payload["b"]}
    }.run_once

    expect(ran).to be(true)
    expect(seen).to eq(1)
    row = status(task_id)
    expect(row["state"]).to eq("succeeded")
    expect(JSON.parse(row["result"])).to eq({"sum" => 5})
  end

  it "records a failure and schedules the retry by the task's policy" do
    task_id = queue.enqueue("boom", {}, max_attempts: 2).task_id
    worker.handle("boom") { raise ArgumentError, "bad input" }.run_once

    row = status(task_id)
    expect(row["state"]).to eq("scheduled")
    expect(JSON.parse(row["error"]).values_at("name", "message")).to eq(["ArgumentError", "bad input"])
  end

  it "fails the task once its attempts run out and redacts nothing by default" do
    task_id = queue.enqueue("boom", {}, max_attempts: 1).task_id
    worker.handle("boom") { raise "last try" }.run_once

    row = status(task_id)
    expect(row["state"]).to eq("failed")
    expect(JSON.parse(row["error"])["stack"]).to include("last try")
  end

  it "replays a checkpoint in the retry instead of running its block again" do
    task_id = queue.enqueue("charge", {}, max_attempts: 2).task_id
    runs = 0
    subject = worker(retry_delay: 0).handle("charge") do |_payload, context|
      charge = context.checkpoint("charge") { runs += 1 }
      raise "network" if context.task.attempt == 1

      {"charge" => charge}
    end
    subject.run_once
    make_ready(task_id)
    subject.run_once

    expect(runs).to eq(1)
    row = status(task_id)
    expect([row["state"], row["attempt"], JSON.parse(row["result"])]).to eq(["succeeded", "2", {"charge" => 1}])
  end

  it "fails the task at once when a replayed checkpoint input differs and keeps the attempt" do
    task_id = queue.enqueue("charge", {}, max_attempts: 3).task_id
    runs = 0
    subject = worker(retry_delay: 0).handle("charge") do |_payload, context|
      amount = (context.task.attempt == 1) ? 1000 : 900
      context.checkpoint("charge", input: {"amountCents" => amount}) { runs += 1 }
      raise "network" if context.task.attempt == 1

      {"charged" => true}
    end
    subject.run_once
    make_ready(task_id)
    subject.run_once

    expect(runs).to eq(1)
    row = status(task_id)
    expect(row.values_at("state", "attempt")).to eq(%w[failed 2])
    expect(JSON.parse(row["error"])["name"]).to eq("Stablemates::Workhorse::CheckpointInputConflictError")
    stored = W::Admin.new(@pool).get_checkpoint(task_id, "charge")
    expect(stored.input_fingerprint).to eq(W.checkpoint_input_fingerprint({"amountCents" => 1000}))
  end

  it "replays a checkpoint whose input matches or whose stored row has no fingerprint" do
    task_id = queue.enqueue("charge", {}, max_attempts: 2).task_id
    runs = 0
    subject = worker(retry_delay: 0).handle("charge") do |_payload, context|
      input = (context.task.attempt == 1) ? nil : {"amountCents" => 1000}
      plain = context.checkpoint("plain") { runs += 1 }
      matched = context.checkpoint("charge", input: {"amountCents" => 1000}) { runs += 1 }
      later = (input.nil? ? context.checkpoint("later") { runs += 1 } : context.checkpoint("later", input: input) { runs += 1 })
      raise "network" if context.task.attempt == 1

      {"values" => [plain, matched, later]}
    end
    subject.run_once
    make_ready(task_id)
    subject.run_once

    expect(runs).to eq(3)
    row = status(task_id)
    expect([row["state"], JSON.parse(row["result"])]).to eq(["succeeded", {"values" => [1, 2, 3]}])
    expect(W::Admin.new(@pool).get_checkpoint(task_id, "later").input_fingerprint).to be_nil
  end

  it "releases a task whose type has no handler without charging the attempt" do
    task_id = queue.enqueue("unknown", {}).task_id
    ran = worker.handle("other") { {} }.run_once

    expect(ran).to be(false)
    expect(status(task_id).values_at("state", "attempt")).to eq(%w[ready 1])
  end

  it "suspends a durable sleep and completes after the wake" do
    task_id = queue.enqueue("nap", {}).task_id
    subject = worker.handle("nap") do |_payload, context|
      context.sleep("nap", 0.2)
      {"woke" => true}
    end
    subject.run_once
    expect(status(task_id)["state"]).to eq("scheduled")

    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 5
    until status(task_id)["state"] == "succeeded" || Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline
      subject.run_once
      sleep 0.05
    end
    expect(status(task_id)["state"]).to eq("succeeded")
  end

  it "logs a handler that swallows its suspension signal and keeps the wait" do
    task_id = queue.enqueue("nap", {}).task_id
    output = StringIO.new
    worker(logger: Logger.new(output)).handle("nap") { |_payload, context|
      begin
        context.sleep("nap", 3600)
      rescue Exception # rubocop:disable Lint/RescueException
        nil
      end
      {"swallowed" => true}
    }.run_once

    expect(status(task_id)["state"]).to eq("scheduled")
    expect(output.string).to include("Task handler swallowed its suspension signal")
  end

  it "unwinds a scheduled sleep whose release the heartbeat reports as a lost lease first" do
    task_id = queue.enqueue("nap", {}).task_id
    context = nil
    continued = false
    output = StringIO.new
    # Only a heartbeat status reports the lost lease. The lease is longer than the 5 s wait, so the
    # lease watchdog cannot end the attempt first.
    subject = worker(lease: 10, heartbeat: 0.1, logger: Logger.new(output)).handle("nap") do |_payload, handler_context|
      context = handler_context
      context.sleep("nap", 3600)
      continued = true
      {}
    end
    allow(subject.instance_variable_get(:@executor)).to receive(:fenced_rows).and_wrap_original do |original, sql, *arguments|
      rows = original.call(sql, *arguments)
      if sql == W::SqlCatalogue::SCHEDULE_WAIT_V1
        deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 5
        sleep 0.01 until context.cancellation.reason == :lease_lost ||
            Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline
      end
      rows
    end
    subject.run_once

    expect([context.cancellation.reason, continued]).to eq([:lease_lost, false])
    expect(status(task_id)["state"]).to eq("scheduled")
    finished = output.string.lines.find { |line| line.include?("workhorse.task.execution_finished") }
    expect(JSON.parse(finished[/\{.*\}/])["workhorse.handler.outcome"]).to eq("suspended")
  end

  [false, true].each do |second|
    it "distinguishes a renamed single child from a second child (second=#{second})" do
      parent = queue.enqueue("rename-parent", {}).task_id
      name = "a"
      refusal = nil
      subject = worker
      child_queue = "#{@queue_name}-children"
      child_worker = W::Worker.new(@pool, queues: [child_queue], polling_only: true, disable_registry: true).handle("rename-child") { nil }
      subject.handle("rename-parent") do |_payload, context|
        begin
          context.run_child("a", "rename-child", {}, queue: child_queue) if second
          context.run_child(name, "rename-child", {}, queue: child_queue)
        rescue W::ConflictError, W::LimitExceededError => error
          refusal = error
        end
        nil
      end
      expect(subject.run_once).to be(true)
      expect(status(parent)["state"]).to eq("blocked")
      expect(child_worker.run_once).to be(true)
      name = "b"
      expect(subject.run_once).to be(true)
      expect(refusal).to be_a(second ? W::LimitExceededError : W::ConflictError)
      expect(refusal.message).to include('stored child "a", requested child "b"') unless second
      expect(@connection.exec_params("SELECT child_name FROM workhorse.task_child WHERE parent_task_id = $1", [parent]).column_values(0)).to eq(["a"])
    end
  end

  it "suspends a parent on its children and joins their results on replay" do
    single = queue.enqueue("single", {}).task_id
    fan = queue.enqueue("fan", {}).task_id
    subject = worker.handle("child") { |payload| payload["n"] * 2 }
    subject.handle("single") do |_payload, context|
      {"doubled" => context.run_child("double", "child", {"n" => 21}), "attempt" => context.task.attempt}
    end
    subject.handle("fan") do |_payload, context|
      children = [1, 2].map { |n| W::ChildTaskRequest.new(name: "c#{n}", task_type: "child", payload: {"n" => n}) }
      {"joined" => context.run_children_all(children), "attempt" => context.task.attempt}
    end

    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 10
    until [single, fan].all? { |id| status(id)["state"] == "succeeded" } ||
        Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline
      subject.run_once
    end
    expect([single, fan].map { |id| status(id).then { |row| [row["state"], JSON.parse(row["result"])] } }).to eq(
      [["succeeded", {"doubled" => 42, "attempt" => 1}], ["succeeded", {"joined" => {"c1" => 2, "c2" => 4}, "attempt" => 1}]]
    )
    queues = @connection.exec_params("SELECT task.queue_name FROM workhorse.task_child child JOIN workhorse.task task " \
      "ON task.id = child.child_task_id WHERE child.parent_task_id = ANY($1::uuid[])", ["{#{single},#{fan}}"])
    expect(queues.column_values(0)).to eq([@queue_name] * 3)
  end

  it "puts a child request with no queue on the queue of the parent task" do
    parent = queue.enqueue("parent", {}).task_id
    other = "#{@queue_name}-other"
    # The first queue of this worker is not the queue of the parent task.
    subject = W::Worker.new(@pool, queues: ["#{@queue_name}-first", @queue_name], polling_only: true,
      poll_interval: 0.01, disable_registry: true)
    subject.handle("parent") do |_payload, context|
      context.run_children([W::ChildTaskRequest.new(name: "unnamed", task_type: "child", payload: {}),
        W::ChildTaskRequest.new(name: "named", task_type: "child", payload: {}, options: {queue: other})])
    end
    expect(subject.run_once).to be(true)

    rows = @connection.exec_params("SELECT child.child_name, task.queue_name FROM workhorse.task_child child " \
      "JOIN workhorse.task task ON task.id = child.child_task_id WHERE child.parent_task_id = $1", [parent])
    expect(rows.to_h { |row| [row["child_name"], row["queue_name"]] }).to eq("unnamed" => @queue_name, "named" => other)
  end

  [false, true].each do |set|
    it "keeps the queue of a stored child when a replay names no queue (set=#{set})" do
      parent = queue.enqueue("parent", {}, max_attempts: 1).task_id
      legacy = "#{@queue_name}-legacy"
      subject = W::Worker.new(@pool, queues: [@queue_name, legacy], polling_only: true, poll_interval: 0.01,
        disable_registry: true)
      activations = 0
      subject.handle("child") { {"receipt" => 1} }
      subject.handle("parent") do |_payload, context|
        activations += 1
        # The first activation acts as an earlier SDK, which put a child with no queue on another
        # queue. The replay names no queue, so it keeps the queue of the stored child.
        options = (activations == 1) ? {queue: legacy, max_attempts: 1} : {max_attempts: 1}
        if set
          context.run_children_all([W::ChildTaskRequest.new(name: "charge", task_type: "child", payload: {},
            options: options)])
        else
          context.run_child("charge", "child", {}, **options)
        end
      end

      deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 10
      until %w[succeeded failed].include?(status(parent)["state"]) ||
          Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline
        subject.run_once
      end
      expect(activations).to eq(2)
      expect(status(parent)["state"]).to eq("succeeded")
      expect(JSON.parse(status(parent)["result"])).to eq(set ? {"charge" => {"receipt" => 1}} : {"receipt" => 1})
    end
  end

  it "resumes a signal wait and a human wait with what was delivered" do
    task_id = queue.enqueue("review", {}).task_id
    subject = worker.handle("review") do |_payload, context|
      signal = context.wait_for_signal("upload")
      decision = context.wait_for_human("approve", {"file" => signal["file"]})
      {"signal" => signal, "decision" => decision}
    end
    subject.run_once
    expect(status(task_id)["state"]).to eq("scheduled")
    queue.send_signal(task_id, "upload", {"file" => "a.csv"}, idempotency_key: "upload-1", requested_by: "spec")
    subject.run_once
    expect(status(task_id)["state"]).to eq("scheduled")
    queue.complete_human_wait(task_id, "approve", {"approved" => true}, idempotency_key: "approve-1",
      requested_by: "spec")
    subject.run_once

    row = status(task_id)
    expect([row["state"], row["attempt"], JSON.parse(row["result"])]).to eq(
      ["succeeded", "1", {"signal" => {"file" => "a.csv"}, "decision" => {"approved" => true}}]
    )
  end

  # PostgreSQL rate-limits a progress write that comes less than 100 ms after the previous one. A
  # host stall between the two writes can let the second one through (SM-1794). So the spec moves
  # the stored time of the first write one minute forward. Only a stall of a minute then lets the
  # second write leave the window.
  it "round-trips progress and rate-limits a quick change" do
    task_id = queue.enqueue("report", {}).task_id
    seen = nil
    worker.handle("report") { |_payload, context|
      saved = context.set_progress({"done" => 1})
      @connection.exec_params("UPDATE workhorse.task_progress SET updated_at = updated_at + interval '1 minute'
        WHERE task_id = $1", [task_id])
      retry_after = begin
        context.set_progress({"done" => 2})
      rescue W::ProgressRateLimitedError => e
        e.retry_after
      end
      seen = [saved.value, saved.revision, context.get_progress.value, retry_after.positive?]
      {}
    }.run_once

    expect(seen).to eq([{"done" => 1}, 1, {"done" => 1}, true])
    expect(status(task_id)["state"]).to eq("succeeded")
  end

  it "cancels the handler and keeps the task when the lease is taken over" do
    task_id = queue.enqueue("slow", {}).task_id
    reason = nil
    # Only a heartbeat status reports the new fence. The lease is longer than the 5 s wait, so the
    # lease watchdog cannot end the attempt first.
    subject = worker(lease: 10, heartbeat: 0.1).handle("slow") do |_payload, context|
      @connection.exec_params("UPDATE workhorse.task_runtime SET fence_token = fence_token + 1 WHERE task_id = $1",
        [task_id])
      context.cancellation.wait(5)
      reason = context.cancellation.reason
      {"late" => true}
    end
    subject.run_once

    expect(reason).to eq(:lease_lost)
    expect(status(task_id)["state"]).to eq("active")
  end

  # The handler moves a boundary into the past in PostgreSQL and returns at once. The worker's own
  # timers still wait for the claimed values and the heartbeat does not run in between, so the
  # boundary is due only when the completion write arrives.
  [["deadline", "deadline_at", "deadline_exceeded", "deadline_exceeded"],
    ["attempt timeout", "attempt_timeout_at", "timeout_exceeded", "timeout"]].each do |boundary, column, expiration, outcome|
    it "settles a #{boundary} that comes due before the completion write as #{outcome}" do
      task_id = queue.enqueue("late", {}, max_attempts: 1, deadline: Time.now + 3600,
        execution_timeout: 3600).task_id
      output = StringIO.new
      worker(lease: 30, heartbeat: 10, logger: Logger.new(output)).handle("late") {
        @connection.exec_params("UPDATE workhorse.task_runtime SET #{column} = clock_timestamp() - interval '1 second'
          WHERE task_id = $1", [task_id])
        {"late" => true}
      }.run_once

      row = status(task_id)
      expect(row["state"]).to eq("failed")
      expect(row["result"]).to be_nil
      expect(output.string).to include("workhorse.task.completion_rejected")
      expect(output.string).to include(%("workhorse.expiration.status":"#{expiration}"))
      expect(output.string).to include(%("workhorse.handler.outcome":"#{outcome}"))
    end
  end

  it "acknowledges a cancellation requested before the completion write" do
    task_id = queue.enqueue("late", {}, max_attempts: 1).task_id
    output = StringIO.new
    worker(lease: 30, heartbeat: 10, logger: Logger.new(output)).handle("late") {
      expect(queue.cancel(task_id, requested_by: "spec").status).to eq(:cancel_requested)
      {"late" => true}
    }.run_once

    expect(status(task_id)["state"]).to eq("canceled")
    expect(output.string).to include(%("workhorse.handler.outcome":"canceled"))
  end

  # The worker's own expiration answers stale, so the task stays active with an overdue deadline.
  # run_once also runs a due tick before the claim that finds no task. If the attempt takes more
  # than the 1 s default interval, that tick settles the deadline (SM-1795). The interval of one
  # hour lets only the tick before the first claim run.
  it "leaves a task whose lease was taken over before the completion write to recovery" do
    task_id = queue.enqueue("late", {}, max_attempts: 1, deadline: Time.now + 3600).task_id
    output = StringIO.new
    worker(lease: 30, heartbeat: 10, maintenance_interval: 3600, logger: Logger.new(output)).handle("late") {
      @connection.exec_params("UPDATE workhorse.task_runtime SET fence_token = fence_token + 1,
        deadline_at = clock_timestamp() - interval '1 second' WHERE task_id = $1", [task_id])
      {"late" => true}
    }.run_once

    expect(status(task_id)["state"]).to eq("active")
    expect(output.string).to include(%("workhorse.handler.outcome":"lease_lost"))
  end

  # The handler moves the attempt timeout 2.5 s later in PostgreSQL only, so the worker clock runs
  # ahead by more than the 2 s lease. PostgreSQL answers not_due until its own clock reaches the
  # timeout. Each expiry request locks the task row, and a heartbeat in that time answers busy. If the
  # renewals stop, the lease lapses and the reason is lease_lost. With the backoff, the worker sends
  # about 11 requests. A fixed 5 ms retry sends hundreds, so the count bound fails (SM-1701). The
  # timeout of 1.5 s gives the handler time to move the stored value before the local timer fires.
  it "keeps renewals while the worker clock leads the attempt timeout by more than one lease" do
    @connection.exec(<<~SQL)
      CREATE SEQUENCE public.workhorse_test_expiry_asks;
      ALTER FUNCTION workhorse.expire_owned_v1(uuid, text, bigint) RENAME TO expire_owned_v1__counted;
      CREATE FUNCTION workhorse.expire_owned_v1(p_task_id uuid, p_worker_id text, p_fence_token bigint)
      RETURNS text LANGUAGE plpgsql AS $counted$
      BEGIN
        PERFORM nextval('public.workhorse_test_expiry_asks');
        RETURN workhorse.expire_owned_v1__counted(p_task_id, p_worker_id, p_fence_token);
      END;
      $counted$;
    SQL
    task_id = queue.enqueue("slow", {}, max_attempts: 1, execution_timeout: 1.5).task_id
    reason = nil
    expiry = nil
    after_expiry = nil
    subject = worker(lease: 2, heartbeat: 0.2, maintenance_interval: 3600).handle("slow") do |_payload, context|
      expiry = @connection.exec_params("UPDATE workhorse.task_runtime SET attempt_timeout_at = attempt_timeout_at +
        interval '2500 milliseconds' WHERE task_id = $1 AND attempt_timeout_at > clock_timestamp()
        RETURNING attempt_timeout_at::text", [task_id]).getvalue(0, 0)
      context.cancellation.wait(30)
      after_expiry = @connection.exec_params("SELECT clock_timestamp() >= $1::timestamptz", [expiry]).getvalue(0, 0)
      reason = context.cancellation.reason
      context.cancellation.check!
    end
    subject.run_once

    asks = Integer(@connection.exec("SELECT last_value FROM public.workhorse_test_expiry_asks").getvalue(0, 0), 10)
    expect(reason).to eq(:execution_timeout)
    expect(after_expiry).to eq("t")
    expect(status(task_id)["state"]).to eq("failed")
    expect(asks).to be <= 20
  ensure
    @connection.exec(<<~SQL)
      DROP FUNCTION IF EXISTS workhorse.expire_owned_v1(uuid, text, bigint);
      ALTER FUNCTION workhorse.expire_owned_v1__counted(uuid, text, bigint) RENAME TO expire_owned_v1;
      DROP SEQUENCE IF EXISTS public.workhorse_test_expiry_asks;
    SQL
  end

  it "rejects a result that breaks the task type's registered contract" do
    task_type = "typed.#{@queue_name}"
    version = W::TaskContractVersion.new(result_schema: {"type" => "object", "required" => ["ok"]})
    queue.sync_contracts(task_type => W::TaskTypeContracts.new(current_version: "v1", versions: {"v1" => version}))
    task_id = queue.enqueue(task_type, {}, max_attempts: 1).task_id
    worker.handle(task_type) { {"wrong" => true} }.run_once

    row = status(task_id)
    expect(row["state"]).to eq("failed")
    expect(JSON.parse(row["error"])["name"]).to eq("Stablemates::Workhorse::ContractValidationError")
  end

  it "stamps a contracted child with the contract PostgreSQL holds" do
    child_type = "typed.child.#{@queue_name}"
    version = W::TaskContractVersion.new(payload_schema: {"type" => "object", "required" => ["n"]})
    queue.sync_contracts(child_type => W::TaskTypeContracts.new(current_version: "v1", versions: {"v1" => version}))
    single = queue.enqueue("single", {}).task_id
    fan = queue.enqueue("fan", {}).task_id
    subject = worker.handle(child_type) { |payload| payload["n"] * 2 }
    subject.handle("single") { |_payload, context| context.run_child("double", child_type, {"n" => 21}) }
    subject.handle("fan") do |_payload, context|
      context.run_children_all([1, 2].map { |n| W::ChildTaskRequest.new(name: "c#{n}", task_type: child_type, payload: {"n" => n}) })
    end

    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 10
    until [single, fan].all? { |id| status(id)["state"] == "succeeded" } ||
        Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline
      subject.run_once
    end
    expect([single, fan].map { |id| JSON.parse(status(id)["result"]) }).to eq([42, {"c1" => 2, "c2" => 4}])
    versions = @connection.exec_params("SELECT task.contract_version FROM workhorse.task_child child JOIN workhorse.task task " \
      "ON task.id = child.child_task_id WHERE child.parent_task_id = ANY($1::uuid[])", ["{#{single},#{fan}}"])
    expect(versions.column_values(0)).to eq(%w[v1] * 3)
  end

  it "replays children accepted under a contract version the task type no longer uses" do
    child_type = "upgraded.child.#{@queue_name}"
    version = W::TaskContractVersion.new(payload_schema: {"type" => "object", "required" => ["n"]})
    queue.sync_contracts(child_type => W::TaskTypeContracts.new(current_version: "v1", versions: {"v1" => version}))
    single = queue.enqueue("single", {}, max_attempts: 1).task_id
    fan = queue.enqueue("fan", {}, max_attempts: 1).task_id
    parents = lambda do |subject|
      subject.handle("single") { |_payload, context| context.run_child("double", child_type, {"n" => 21}) }
      subject.handle("fan") do |_payload, context|
        context.run_children_all([1, 2].map { |n| W::ChildTaskRequest.new(name: "c#{n}", task_type: child_type, payload: {"n" => n}) })
      end
    end
    edges = -> { @connection.exec_params("SELECT count(*) FROM workhorse.task_child WHERE parent_task_id = ANY($1::uuid[])", ["{#{single},#{fan}}"]).getvalue(0, 0).to_i }
    first = parents.call(worker)
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 10
    first.run_once until edges.call == 3 || Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline

    upgraded = W::TaskContractVersion.new(payload_schema: {"type" => "object", "required" => %w[n m]})
    queue.sync_contracts(child_type => W::TaskTypeContracts.new(current_version: "v2", versions: {"v1" => version, "v2" => upgraded}))
    restarted = parents.call(worker)
    restarted.handle(child_type) { |payload| payload["n"] * 2 }
    until [single, fan].all? { |id| %w[succeeded failed].include?(status(id)["state"]) } ||
        Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline
      restarted.run_once
    end
    expect([single, fan].map { |id| [status(id)["state"], JSON.parse(status(id)["result"] || "null")] })
      .to eq([["succeeded", 42], ["succeeded", {"c1" => 2, "c2" => 4}]])
    versions = @connection.exec_params("SELECT task.contract_version FROM workhorse.task_child child JOIN workhorse.task task " \
      "ON task.id = child.child_task_id WHERE child.parent_task_id = ANY($1::uuid[])", ["{#{single},#{fan}}"])
    expect(versions.column_values(0)).to eq(%w[v1] * 3)
  end

  # SM-1164: a handler that raised CancelledError(:shutdown) reached fail_v1, which charged the
  # attempt, so a task on its last attempt failed for good because its worker stopped.
  it "releases a task whose handler stops for shutdown without charging the attempt" do
    task_id = queue.enqueue("stopping", {}, max_attempts: 1).task_id
    started = Queue.new
    reasons = Queue.new
    subject = worker(shutdown_grace: 0.05).handle("stopping") do |_payload, context|
      started << true
      raise "the shutdown never reached the handler" unless context.cancellation.wait(5)

      reasons << context.cancellation.reason
      context.cancellation.check!
    end
    runner = Thread.new { subject.run }
    started.pop
    subject.stop
    runner.value

    expect(reasons.pop).to eq(:shutdown)
    expect(status(task_id).values_at("state", "attempt")).to eq(["ready", "1"])
    events = @connection.exec_params("SELECT event_type FROM workhorse.task_event WHERE task_id = $1 ORDER BY occurred_at, event_id",
      [task_id]).column_values(0)
    expect(events).to eq(%w[enqueued claimed released])
  end

  it "still charges the attempt when a handler raises its own error after the shutdown" do
    task_id = queue.enqueue("failing", {}, max_attempts: 1).task_id
    started = Queue.new
    subject = worker(shutdown_grace: 0.05).handle("failing") do |_payload, context|
      started << true
      raise "the shutdown never reached the handler" unless context.cancellation.wait(5)

      raise ArgumentError, "the upstream call failed"
    end
    runner = Thread.new { subject.run }
    started.pop
    subject.stop
    runner.value

    row = status(task_id)
    expect(row.values_at("state", "attempt")).to eq(["failed", "1"])
    expect(JSON.parse(row["error"])["name"]).to eq("ArgumentError")
  end

  it "charges the attempt of a handler that raises a shutdown CancelledError without a stop" do
    task_id = queue.enqueue("forged", {}, max_attempts: 1).task_id
    worker.handle("forged") { raise W::CancelledError.new(:shutdown) }.run_once

    expect(status(task_id).values_at("state", "attempt")).to eq(["failed", "1"])
  end

  it "raises ShutdownIncompleteError when a handler outlives the grace and the unwind window" do
    queue.enqueue("stuck", {})
    started = Queue.new
    release = Concurrent::Event.new
    subject = worker(shutdown_grace: 0.05).handle("stuck") do
      started << true
      release.wait(5)
      {}
    end
    runner = Thread.new { subject.run }
    runner.report_on_exception = false
    started.pop
    subject.stop

    expect { runner.value }.to raise_error(W::ShutdownIncompleteError) { |error| expect(error.abandoned).to eq(1) }
  ensure
    release&.set
  end
end
