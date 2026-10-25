# frozen_string_literal: true

require "bigdecimal"
require "spec_helper"

RSpec.describe W::Worker do
  pool_class = Class.new(FakeExecutor) do
    attr_accessor :capacity

    def size = capacity || 3

    # Lends the heartbeat reservation and the readiness query a fake connection. Statements run
    # through FakeExecutor#rows, without a checkout.
    def with(&) = FakeHeartbeatConnection.lend(&)
  end

  let(:pool) { pool_class.new }

  def worker(**options)
    described_class.new(pool, queues: ["default"], polling_only: true, poll_interval: 0.01, disable_registry: true,
      **options)
  end

  claim_statements = [W::SqlCatalogue::CLAIM_MANY_V1, W::SqlCatalogue::COMPLETE_MANY_AND_CLAIM_V1].freeze

  define_method(:claims) { pool.statements.count { |sql, _| claim_statements.include?(sql) } }

  it "validates its options before it touches PostgreSQL" do
    expect { worker(queues: []) }.to raise_error(ArgumentError, /queues/)
    expect { worker(concurrency: 0) }.to raise_error(ArgumentError, /concurrency/)
    expect { worker(lease: 1, heartbeat: 1) }.to raise_error(ArgumentError, /heartbeat/)
    expect { worker(worker_id: "") }.to raise_error(ArgumentError, /worker_id/)
    expect { worker(retry_delay: -1) }.to raise_error(ArgumentError, /retry_delay/)
    expect { worker.handle("") { {} } }.to raise_error(ArgumentError, /task_type/)
    expect(pool.statements).to be_empty
  end

  # SM-1668 PAR-09: Ruby accepts a zero grace. The stop deadline is then the moment the dispatch
  # loop ends, so the drain cancels every handler at once, and the stop ends within one unwind window.
  it "accepts a shutdown grace from 0 through one day, and refuses a negative grace" do
    expect(worker(shutdown_grace: 0).instance_variable_get(:@shutdown_grace)).to eq(0.0)
    expect(worker(shutdown_grace: 0.0004).instance_variable_get(:@shutdown_grace)).to eq(0.0)
    expect(worker(shutdown_grace: 86_400).instance_variable_get(:@shutdown_grace)).to eq(86_400.0)
    [-0.001, 86_400.001, nil].each do |grace|
      expect { worker(shutdown_grace: grace) }.to raise_error(ArgumentError, /shutdown_grace/)
    end
    expect(pool.statements).to be_empty
  end

  # SM-1668 PAR-09 (ADR 0112): register_worker_v1 takes each interval as a PostgreSQL integer, so
  # every SDK accepts 100 through 2147483647 ms and refuses other values at construction.
  it "accepts a maintenance, routine, or registry interval from 0.1 s through 2147483.647 s" do
    {maintenance_interval: :@maintenance_ms, maintenance_routine_interval: :@routine_ms,
     registry_interval: :@registry_ms}.each do |option, ivar|
      [[0.1, 100], [Rational(2_147_483_647, 1000), 2_147_483_647]].each do |seconds, milliseconds|
        subject = worker(option => seconds, :disable_registry => false)
        expect(subject.instance_variable_get(ivar)).to eq(milliseconds)
      end
      [0, 0.001, 0.099, Rational(2_147_483_648, 1000), -1, nil].each do |seconds|
        expect { worker(option => seconds, :disable_registry => false) }
          .to raise_error(ArgumentError, /#{option} must be .* between 0.1 and 2147483.647/)
      end
    end
    expect(worker(registry_interval: 0, disable_registry: true).instance_variable_get(:@registry_ms)).to eq(0)
    expect(pool.statements).to be_empty
  end

  # SM-1668 PAR-09 (ADR 0112): with a live subscription, an explicit poll interval is the fallback
  # interval, so the 5,000 ms cap does not apply. Without one, the cap applies before the jitter. A
  # worker that registers then cuts the wait to its registry interval.
  describe "the wait after an empty claim" do
    slots_class = Struct.new(:listener, :empty, :listened_at_last_wait)

    def wait_ms(subject, listening:, jitter:)
      allow(subject).to receive(:rand).and_return(jitter)
      listener = Struct.new(:listening?).new(listening)
      (subject.send(:dispatch_wait, slots_class.new(listener, 4, listening)) * 1000).round
    end

    define_method(:slots_class) { slots_class }

    it "caps an explicit poll interval only while the worker polls" do
      subject = worker(poll_interval: 30)
      expect([0.9, 1.1].map { |jitter| wait_ms(subject, listening: true, jitter:) }).to eq([27_000, 33_000])
      expect([0.9, 1.1].map { |jitter| wait_ms(subject, listening: false, jitter:) }).to eq([4_500, 5_500])
    end

    it "cuts the jittered wait to the registry interval of a registered worker" do
      subject = worker(poll_interval: 30, disable_registry: false, registry_interval: 5)
      expect(wait_ms(subject, listening: true, jitter: 0.9)).to eq(5_000)
      expect(wait_ms(subject, listening: false, jitter: 1.1)).to eq(5_000)
    end
  end

  it "accepts a zero supervisor grace, and refuses a negative one before it forks" do
    supervisor = instance_double(W::Supervisor, run: nil)
    allow(W::Supervisor).to receive_messages(fork_supported?: true, new: supervisor)
    W.run_worker_processes(processes: 1, shutdown_grace: 0) { nil }
    expect(W::Supervisor).to have_received(:new).with(1, 0.0, an_instance_of(Proc))
    expect { W.run_worker_processes(processes: 1, shutdown_grace: -1) { nil } }
      .to raise_error(ArgumentError, /shutdown_grace/)
  end

  # fail_v1 takes an integer, so the override range ends at 2147483647 ms (SM-1668 PAR-06, ADR 0111).
  describe "the retry delay override" do
    let(:task) do
      W::ClaimedTask.new(
        id: "00000000-0000-4000-8000-000000000001", queue: "default", type: "t", priority: 0, payload: {},
        contract_version: nil, result_max_bytes: nil, redact_error_details: false, trace_context: nil,
        attempt: 1, max_attempts: 3, retry_policy: nil, deadline_at: nil, execution_timeout_ms: nil,
        attempt_timeout_at: nil, fence_token: 7, lease_expires_at: nil
      )
    end

    def override(delay) = worker(retry_delay: ->(_attempt, _task) { delay }).send(:retry_delay_override, task)

    it "sends the limit, zero, and a fraction rounded half up" do
      expect(override(Rational(2_147_483_647, 1000))).to eq(2_147_483_647)
      expect(override(0)).to eq(0)
      expect(override(Rational(14, 10_000))).to eq(1)
      expect(override(Rational(15, 10_000))).to eq(2)
      expect(override(Rational(1001, 2000))).to eq(501)
      expect(override(0.0015)).to eq(2)
      expect(worker(retry_delay: Rational(1001, 2000)).send(:retry_delay_override, task)).to eq(501)
      expect(override(BigDecimal("0.5005"))).to eq(501)
      expect(worker(retry_delay: BigDecimal("0.5005")).send(:retry_delay_override, task)).to eq(501)
      expect(override(BigDecimal("2147483.6474999999"))).to eq(2_147_483_647)
      expect(worker(retry_delay: BigDecimal("2147483.6474999999")).send(:retry_delay_override, task))
        .to eq(2_147_483_647)
      expect(override(nil)).to be_nil
    end

    it "refuses one above the limit and every negative value, before fail_v1" do
      [Rational(2_147_483_648, 1000), Rational(4_294_967_295, 2000), BigDecimal("2147483.6475"), -1,
        Rational(-1, 10_000), BigDecimal("-0.0001"), BigDecimal("NaN"), Float::INFINITY].each do |delay|
        expect { override(delay) }.to raise_error(ArgumentError, /retry_delay/)
        expect { worker(retry_delay: delay) }.to raise_error(ArgumentError, /retry_delay/)
      end
      expect(pool.statements).to be_empty
    end
  end

  it "refuses a pool too small to keep a heartbeat connection unless heartbeats share it" do
    pool.capacity = 2
    expect { worker }.to raise_error(ArgumentError, /capacity must be at least 3 \(found 2\)/)
    expect { worker(shared_heartbeats: true) }.not_to raise_error
  end

  # A completion's fused claim hands its slot to a task it claims while the handler thread still
  # finishes, so the pool keeps a second thread for each slot.
  it "runs handlers on a bounded pool that never queues a claimed task" do
    executor = worker(concurrency: 3).send(:handler_executor)
    expect([executor.min_length, executor.max_length, executor.max_queue, executor.synchronous,
      executor.fallback_policy]).to eq([3, 6, 0, true, :abort])
  ensure
    executor&.shutdown
  end

  it "claims once per queue in a pass and reports that nothing ran" do
    expect(described_class.new(pool, queues: %w[a b], polling_only: true, disable_registry: true).run_once).to be(false)
    expect(pool.statements.select { |sql, _| sql == W::SqlCatalogue::COMPLETE_MANY_AND_CLAIM_V1 }.map { |_, params| params[4] })
      .to contain_exactly("a", "b")
  end

  it "claims nothing while paused and resumes claiming" do
    subject = worker
    subject.pause
    expect(subject).to be_paused
    expect(subject.run_once).to be(false)
    expect(claims).to eq(0)

    subject.resume
    subject.run_once
    expect(claims).to be >= 1
  end

  it "sends no claim when a pause arrives during the notification delay" do
    subject = worker(poll_interval: 60)
    delayed = Concurrent::Event.new
    allow(subject).to receive(:sleep) do
      subject.pause
      delayed.set
    end
    runner = Thread.new { subject.run }
    sleep 0.01 until claims == 1
    subject.send(:notify)

    expect(delayed.wait(5)).to be(true)
    sleep 0.2
    expect(claims).to eq(1)
  ensure
    subject.stop
    runner&.join(5)
  end

  # SM-1648: the empty claims of a live subscription do not count toward the backoff after its loss.
  it "restarts the empty-claim backoff when the subscription is lost" do
    subject = worker(poll_interval: 0.04)
    listening = Concurrent::AtomicBoolean.new(true)
    subscription = Struct.new(:flag) { def listening? = flag.true? }.new(listening)
    # The stand-in subscription reports the live state, so the worker waits the flat base.
    allow(subject).to receive(:dispatch).and_wrap_original do |original, continuous, version, handlers, _listener, *rest|
      original.call(continuous, version, handlers, subscription, *rest)
    end
    runner = Thread.new { subject.run }
    sleep 0.005 until claims >= 6
    # The listener clears the flag and then wakes the worker when the subscription is lost.
    listening.make_false
    lost = claims
    subject.send(:notify)
    sleep 1

    # The backoff restarts at the base: the woken claim, then waits of 40 ms and 80 ms. A backoff
    # that counts the live empty claims waits more than two seconds after the woken claim.
    expect(claims - lost).to be >= 3
  ensure
    subject.stop
    runner&.join(5)
  end

  it "polls while idle and returns from run once stopped" do
    subject = worker
    runner = Thread.new { subject.run }
    sleep 0.01 until claims >= 2
    subject.stop

    expect(runner.join(5)&.value).to be_nil
  end

  it "defaults dispatch cohorts to one below concurrency 8, else concurrency / 8 within 2 to 8" do
    pool.capacity = 20
    cohorts = [1, 7, 8, 16, 17, 64, 100].map { |concurrency| worker(concurrency: concurrency).cohorts }
    expect(cohorts).to eq([1, 1, 2, 2, 3, 8, 8])
    expect(worker(concurrency: 16, cohorts: 4).cohorts).to eq(4)
  end

  it "keeps a claim connection for each default cohort and validates an explicit count" do
    pool.capacity = 4
    # A listening worker leaves one connection to the listener and one to the heartbeat.
    expect(worker(concurrency: 64, polling_only: false).cohorts).to eq(2)
    expect(worker(concurrency: 64, polling_only: false, shared_heartbeats: true).cohorts).to eq(3)
    # A polling-only worker opens no listener, so it reserves no connection for one.
    expect(worker(concurrency: 64).cohorts).to eq(3)
    expect(worker(concurrency: 64, shared_heartbeats: true).cohorts).to eq(4)
    [0, 9, 2.0, "2"].each do |cohorts|
      expect { worker(concurrency: 8, cohorts: cohorts) }.to raise_error(ArgumentError, /cohorts/)
    end
  end

  it "validates a batch handler's size and linger before it registers the handler" do
    subject = worker(concurrency: 4)
    expect { subject.handle_batch("b", max_size: 2, linger: 0.01) }.to raise_error(ArgumentError, /block/)
    [0, 101, 2.5].each do |size|
      expect { subject.handle_batch("b", max_size: size, linger: 0.01) { [] } }
        .to raise_error(ArgumentError, /max_size must be an integer/)
    end
    expect { subject.handle_batch("b", max_size: 5, linger: 0.01) { [] } }
      .to raise_error(ArgumentError, /max_size must not exceed worker concurrency/)
    [-0.001, 60.001, Float::NAN, Complex(1, 1), "1", nil].each do |linger|
      expect { subject.handle_batch("b", max_size: 2, linger: linger) { [] } }
        .to raise_error(ArgumentError, /linger must be a finite Numeric count of seconds between 0 and 60/)
    end
    expect(subject.handle_batch("b", max_size: 4, linger: 0) { [] }).to be(subject)
    expect(subject.handle_batch("b", max_size: 4, linger: Rational(3, 2)) { [] }).to be(subject)
    expect(pool.statements).to be_empty
  end

  # SM-1443: a heartbeat round can answer after the local lease window ended, while the watchdog
  # thread is still late. That accepted answer must not reopen the window.
  describe "a late accepted heartbeat" do
    ownership_class = described_class.const_get(:Ownership)
    let(:task) do
      W::ClaimedTask.new(
        id: "00000000-0000-4000-8000-000000000001", queue: "default", type: "t", priority: 0, payload: {},
        contract_version: nil, result_max_bytes: nil, redact_error_details: false, trace_context: nil,
        attempt: 1, max_attempts: 3, retry_policy: nil, deadline_at: nil, execution_timeout_ms: nil,
        attempt_timeout_at: nil, fence_token: 7, lease_expires_at: nil
      )
    end
    let(:arbiter) { W::Arbiter.new }
    let(:cancellation) { W::CancellationToken.new }

    def monotonic = Process.clock_gettime(Process::CLOCK_MONOTONIC)

    # Registers +ownership+ with a heartbeat that only records the member, and with a watchdog
    # that never runs, as when its thread is late. Returns the member.
    def own(ownership)
      subject = worker
      members = []
      heartbeat = Object.new
      heartbeat.define_singleton_method(:register) { |member| (members << member) && -> {} }
      subject.instance_variable_set(:@heartbeat, heartbeat)
      allow(subject).to receive(:watch_expiration)
      subject.send(:own, task, ownership, arbiter, cancellation)
      members.first
    end

    it "does not renew a window that ended, and ends the attempt with a lost lease" do
      ownership = ownership_class.new(monotonic - 1.0, 0.5)
      deadline = ownership.lease_deadline
      own(ownership).renew.call(monotonic - 0.1)
      expect(ownership.lease_deadline).to eq(deadline)
      expect([arbiter.outcome, cancellation.reason, ownership.stop.set?]).to eq([:lease_expired, :lease_lost, true])
    end

    it "renews a window that is still open" do
      ownership = ownership_class.new(monotonic, 30.0)
      sent_at = monotonic
      own(ownership).renew.call(sent_at)
      expect(ownership.lease_deadline).to eq(sent_at + 30.0)
      expect([arbiter.outcome, cancellation.reason, ownership.stop.set?]).to eq([nil, nil, false])
    end
  end
  # SM-1649: a heartbeat round that read the membership before the release can settle the attempt
  # while PostgreSQL refuses its completion. The reconciliation waits for that settlement, and a
  # round after the release changes nothing. The heartbeat thread delivers statuses inline, so the
  # reconciliation must not hold the lock while it waits for PostgreSQL.
  describe "a refused completion" do
    ownership_class = described_class.const_get(:Ownership)
    let(:task) do
      W::ClaimedTask.new(
        id: "00000000-0000-4000-8000-000000000002", queue: "default", type: "t", priority: 0, payload: {},
        contract_version: nil, result_max_bytes: nil, redact_error_details: false, trace_context: nil,
        attempt: 1, max_attempts: 1, retry_policy: nil, deadline_at: nil, execution_timeout_ms: nil,
        attempt_timeout_at: nil, fence_token: 7, lease_expires_at: nil
      )
    end
    let(:arbiter) { W::Arbiter.new }
    let(:ownership) { ownership_class.new(Process.clock_gettime(Process::CLOCK_MONOTONIC), 30.0) }
    let(:expirations) { [] }
    let(:locked_during_statements) { [] }
    let(:pool) do
      answers = expirations
      locked = locked_during_statements
      settlement = ownership.settlement
      pool_class.new do |sql, _params|
        next [] unless sql == W::SqlCatalogue::EXPIRE_OWNED_TELEMETRY_V1

        locked << settlement.locked?
        [{"status" => answers.shift || "stale", "retry_state" => nil}]
      end
    end

    define_method(:expiries) { pool.statements.count { |sql, _| sql == W::SqlCatalogue::EXPIRE_OWNED_TELEMETRY_V1 } }

    def reconcile(subject) = subject.send(:reconcile_rejected_completion, task, ownership, arbiter)

    it "settles a due boundary under the fence without holding the settlement lock" do
      expirations << "deadline_exceeded"
      reconcile(worker)
      expect([arbiter.outcome, expiries, locked_during_statements]).to eq([:deadline_exceeded, 1, [false]])
    end

    it "ignores a heartbeat status that arrives after the release" do
      subject = worker
      members = []
      heartbeat = Object.new
      heartbeat.define_singleton_method(:register) { |member| (members << member) && -> {} }
      subject.instance_variable_set(:@heartbeat, heartbeat)
      allow(subject).to receive(:watch_expiration)
      subject.send(:own, task, ownership, arbiter, W::CancellationToken.new)
      ownership.release
      members.first.settle.call("deadline_exceeded")
      members.first.settle.call("stale")
      expect([arbiter.outcome, expiries]).to eq([nil, 0])

      expirations << "timeout_exceeded"
      reconcile(subject)
      expect([arbiter.outcome, expiries]).to eq([:attempt_timeout, 1])
    end

    it "waits for a heartbeat settlement that holds the lock and finishes with its outcome" do
      subject = worker
      ownership.settlement.lock
      reconciliation = Thread.new { reconcile(subject) }
      Thread.pass until reconciliation.status == "sleep" || !reconciliation.alive?
      expect(expiries).to eq(0)
      arbiter.submit(:attempt_timeout)
      ownership.settlement.unlock
      reconciliation.join

      expect([arbiter.outcome, expiries]).to eq([:attempt_timeout, 0])
    end

    it "raises the lost lease of a heartbeat settlement that decided first" do
      arbiter.submit(:lease_expired)
      expect { reconcile(worker) }.to raise_error(W::LeaseLostError)
      expect(expiries).to eq(0)
    end
  end

  # SM-1676: while a fairness skip waits for its plain claim, a later completion of the same cohort
  # must not take the slot that the skip gave back.
  describe "a fused claim while a fairness skip is pending" do
    slots_class = described_class.const_get(:DispatchSlots)
    handlers_class = Struct.new(:active_count, :max_length)
    task_class = Struct.new(:id, :queue)

    it "keeps the slot of a fairness skip free for a plain claim" do
      pool.capacity = 6
      subject = worker(queues: %w[a b], concurrency: 4, cohorts: 2, poll_interval: 0.01)
      handlers = handlers_class.new(4, 8)
      gate = Struct.new(:ready?).new(true)
      slots = slots_class.new(4, 2, nil, subject.send(:stop_version), [], handlers, gate)
      tasks = Array.new(4) { |index| task_class.new("t#{index}", "a") }
      tasks.each_with_index { |task, index| slots.thread_cohorts[task.id] = index / 2 }
      slots.cohort_active.replace([2, 2])
      subject.instance_variable_set(:@dispatch_slots, slots)
      # Queue b had no claim for more than the poll interval.
      subject.instance_variable_set(:@queue_asked_at, {"a" => subject.send(:monotonic), "b" => subject.send(:monotonic) - 1})
      # Task t3 returned, and a plain claim for cohort 1 holds its slot in flight.
      slots.thread_cohorts.delete("t3")
      slots.cohort_active[1] -= 1
      handlers.active_count -= 1
      slots.reserved += 1
      slots.cohort_reserved[1] += 1
      slots.cohort_claims[1] += 1

      # The first cohort 0 completion skips its refill, and its handler then returns.
      expect(subject.send(:reserve_completion_claim, tasks[0]).limit).to eq(0)
      expect(slots.fairness_skip_pending).to be(true)
      slots.thread_cohorts.delete("t0")
      slots.cohort_active[0] -= 1
      handlers.active_count -= 1

      # Two slots of cohort 0 are free now, but the next completion asks only for its own slot.
      expect(slots.cohort_free(0)).to eq(1)
      expect(subject.send(:reserve_completion_claim, tasks[1]).limit).to eq(1)
    end
  end
end
