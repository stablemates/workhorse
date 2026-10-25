# frozen_string_literal: true

require "logger"
require "opentelemetry"
require "spec_helper"

# SM-1704: a heartbeat round that fails before PostgreSQL returns statuses gives no ownership
# verdict. The worker counts it once in workhorse.worker.heartbeat.round_failure, by reason, and
# the task keeps running.
RSpec.describe "Failed heartbeat rounds" do
  heartbeat_class = W::Worker.const_get(:Heartbeat)

  # Raises +outer+ while +inner+ is the current error, so Ruby sets +inner+ as its cause, and
  # returns +outer+.
  def wrapped(outer, inner)
    begin
      raise inner
    rescue
      raise outer
    end
  rescue => e
    e
  end

  def database_error(sqlstate) = W::DatabaseError.new("database error", sqlstate)

  describe "the failure reason" do
    {
      "a round deadline" => -> { heartbeat_class::RoundTimeout.new },
      "a round that expired before its heartbeat statement" => -> { heartbeat_class::RoundExpired.new },
      "statement_timeout" => -> { W::DatabaseError.new("canceling statement due to statement timeout", "57014") },
      "an idle transaction timeout" => -> { W::DatabaseError.new("terminating connection", "25P03") },
      "a round deadline that wraps a connection error" => lambda {
        wrapped(heartbeat_class::RoundTimeout.new, PG::ConnectionBad.new("closed"))
      }
    }.each do |name, error|
      it("reports #{name} as timeout") { expect(W::Telemetry.heartbeat_round_failure_reason(instance_exec(&error))).to eq("timeout") }
    end

    {
      "a closed connection" => -> { PG::ConnectionBad.new("server closed the connection unexpectedly") },
      "a failed send" => -> { PG::UnableToSend.new("no connection to the server") },
      "a socket reset" => -> { Errno::ECONNRESET.new },
      "a DNS failure" => -> { SocketError.new("getaddrinfo: Name or service not known") },
      "a closed stream" => -> { IOError.new("closed stream") },
      "SQLSTATE class 08" => -> { database_error("08006") },
      "a server shutdown" => -> { database_error("57P01") },
      "a database error without a SQLSTATE that wraps a closed connection" => lambda {
        wrapped(database_error(nil), PG::ConnectionBad.new("closed"))
      },
      "a socket timeout" => -> { IO::TimeoutError.new("Blocking operation timed out!") },
      # Under shared_heartbeats: true the round borrows its connection through the pool's +with+.
      "a connection_pool wait that ends at the pool's limit" => lambda {
        ConnectionPool::TimeoutError.new("Waited 5 sec, 0/5 available")
      },
      "a connection_pool that shuts down" => -> { ConnectionPool::PoolShuttingDownError.new },
      # The SDK does not load Sequel or Active Record, so the classifier matches them by name.
      "a Sequel pool wait that ends at the pool's limit" => lambda {
        stub_const("Sequel::PoolTimeout", Class.new(StandardError)).new("timeout: 5.0")
      },
      "an Active Record pool wait that ends at the pool's limit" => lambda {
        base = stub_const("ActiveRecord::ConnectionNotEstablished", Class.new(StandardError))
        stub_const("ActiveRecord::ConnectionTimeoutError", Class.new(base)).new("could not obtain a connection")
      },
      "a wrapped Active Record pool wait" => lambda {
        base = stub_const("ActiveRecord::ConnectionNotEstablished", Class.new(StandardError))
        wrapped(RuntimeError.new("round failed"), stub_const("ActiveRecord::ConnectionTimeoutError", Class.new(base)))
      }
    }.each do |name, error|
      it("reports #{name} as connection") do
        expect(W::Telemetry.heartbeat_round_failure_reason(instance_exec(&error))).to eq("connection")
      end
    end

    {
      "a deadlock" => -> { database_error("40P01") },
      "a wrapped SQLSTATE" => -> { wrapped(RuntimeError.new("round failed"), database_error("42501")) }
    }.each do |name, error|
      it("reports #{name} as database") { expect(W::Telemetry.heartbeat_round_failure_reason(instance_exec(&error))).to eq("database") }
    end

    it "reports an error without a SQLSTATE or a connection error as other" do
      expect(W::Telemetry.heartbeat_round_failure_reason(RuntimeError.new("unexpected"))).to eq("other")
      expect(W::Telemetry.heartbeat_round_failure_reason(nil)).to eq("other")
    end

    it "reports a Timeout::Error that is not the round deadline as other" do
      expect(W::Telemetry.heartbeat_round_failure_reason(Timeout::Error.new("execution expired"))).to eq("other")
    end

    it "reads a cause chain that refers back to itself once" do
      looping = Class.new(StandardError) { def cause = self }.new("loops")
      expect(W::Telemetry.heartbeat_round_failure_reason(looping)).to eq("other")
    end
  end

  describe "a worker" do
    let(:round_failure) { "workhorse.worker.heartbeat.round_failure" }
    let(:verdict_failure) { "workhorse.worker.heartbeat.failure" }

    # Records each instrument with its unit, and each measurement.
    instrument_class = Struct.new(:name, :unit, :measurements) do
      def add(amount, attributes: {}) = measurements << [name, amount, attributes]

      alias_method :record, :add
    end
    meter_class = Class.new do
      def initialize(instruments, measurements)
        @instruments = instruments
        @measurements = measurements
      end

      def create_counter(name, unit: nil, **) = (@instruments[name] = instrument_class.new(name, unit, @measurements))

      alias_method :create_histogram, :create_counter

      define_method(:instrument_class) { instrument_class }
    end
    provider_class = Struct.new(:instruments, :measurements) do
      define_method(:meter) { |*| meter_class.new(instruments, measurements) }
    end

    # Answers as PostgreSQL would. A claim hands out the pending task once. The first heartbeat
    # fails as +fail_round+ says; each later heartbeat accepts every lease.
    pool_class = Class.new(FakeExecutor) do
      attr_accessor :connection_class

      def size = 3

      def with(&) = (connection_class || FakeHeartbeatConnection).lend(&)
    end

    let(:provider) { provider_class.new(Concurrent::Map.new, Concurrent::Array.new) }
    let(:heartbeats) { Concurrent::AtomicFixnum.new }
    let(:completed) { Concurrent::Array.new }
    let(:pending) { [] }
    let(:task_id) { SecureRandom.uuid }
    let(:pool) do
      pool_class.new do |sql, params|
        case sql
        when W::SqlCatalogue::COMPLETE_MANY_AND_CLAIM_V1 then raise W::FastTierUnsupportedError.new(params[4], "claim", nil)
        when W::SqlCatalogue::CLAIM_MANY_V1 then pending.shift(params[2].to_i)
        when W::SqlCatalogue::COMPLETE_V1
          completed << params[0]
          [{"accepted" => "t"}]
        when W::SqlCatalogue::FAIL_V1 then [{"state" => "failed"}]
        when W::SqlCatalogue::HEARTBEAT_MANY_V2
          if heartbeats.increment == 1
            # Executor#rows translates a PG::Error, and the original stays the cause.
            begin
              raise PG::ConnectionBad, "server closed the connection unexpectedly"
            rescue PG::Error => e
              raise W::Executor.translate(e)
            end
          end
          JSON.parse(params[1]).map { |lease| {"task_id" => lease["taskId"], "status" => "accepted"} }
        else []
        end
      end
    end

    def instruments_cache = W::Telemetry.instance_variable_get(:@instruments)

    before do
      allow(W::Telemetry).to receive(:meter_provider).and_return(provider)
      [round_failure, verdict_failure].each { |name| instruments_cache.delete(name) }
      pending << {
        "task_id" => task_id, "task_type" => "round-failure", "priority" => "0", "payload" => "{}",
        "contract_version" => nil, "result_max_bytes" => "1048576", "attempt" => "1", "max_attempts" => "1",
        "fence_token" => "1", "lease_expires_at" => "2099-01-01 00:00:00+00"
      }
    end

    after { [round_failure, verdict_failure].each { |name| instruments_cache.delete(name) } }

    def run_until_three_heartbeats(**options)
      aborted = nil
      subject = W::Worker.new(pool, queues: ["default"], polling_only: true, poll_interval: 0.01,
        disable_registry: true, lease: 1, heartbeat: 0.05, **options)
      subject.handle("round-failure") do |_payload, context|
        deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 3
        sleep 0.01 until heartbeats.value >= 3 || Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline
        aborted = context.cancellation.cancelled?
        {}
      end
      expect(subject.run_once).to be(true)
      aborted
    end

    def expect_one_round_failure(reason)
      expect(provider.instruments.fetch(round_failure).unit).to eq("{round}")
      expect(provider.measurements.select { |name, _, _| name == round_failure })
        .to eq([[round_failure, 1, {"workhorse.heartbeat.failure_reason" => reason}]])
      # A failed round gives no ownership verdict, so the verdict counter stays empty.
      expect(provider.measurements.select { |name, _, _| name == verdict_failure }).to eq([])
    end

    # Review of SM-1704: a later batch that stalls must not delay the count of the round.
    it "counts a failed borrowed batch at once, while a later batch of the round still waits" do
      heartbeat = heartbeat_class.new(nil, dedicated: false)
      members = %w[first second].each_with_index.map do |worker_id, index|
        task = W::ClaimedTask.new(
          id: format("00000000-0000-4000-8000-%012d", index + 1), queue: "default", type: "t", priority: 0,
          payload: {}, contract_version: nil, result_max_bytes: nil, redact_error_details: false,
          trace_context: nil, attempt: 1, max_attempts: 3, retry_policy: nil, deadline_at: nil,
          execution_timeout_ms: nil, attempt_timeout_at: nil, fence_token: 7, lease_expires_at: nil
        )
        heartbeat_class::Member.new(worker_id: worker_id, task: task, lease_ms: 30_000, interval: 0.05,
          logger: Logger.new(IO::NULL), renew: ->(_) {}, settle: ->(_) {}, fail: ->(_) {}, lease_ends_at: -> {})
      end
      release = Concurrent::Event.new
      # Set when batch two has started and waits for +release+.
      second_waits = Concurrent::Event.new
      statements = Concurrent::Array.new
      round = Thread.new do
        heartbeat.send(:send_each, heartbeat.send(:batches, members), Float::INFINITY) do |_sql, params, _timeout|
          statements << params[0]
          raise PG::ConnectionBad, "server closed the connection unexpectedly" if params[0] == "first"

          second_waits.set
          release.wait(5)
          []
        end
      end
      counted = lambda do
        provider.measurements.select { |name, _, _| name == round_failure }
      end
      # Batch one fails before batch two starts, so the count must be there while batch two waits.
      entered = second_waits.wait(2)
      deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 2
      sleep 0.01 until counted.call.any? || Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline
      seen = counted.call.dup
      waiting = statements.to_a
      still_waiting = round.alive? && !release.set?
      release.set
      expect(round.join(5)).not_to be_nil
      expect(entered).to be(true)
      expect(still_waiting).to be(true)
      expect(waiting).to eq(%w[first second])
      expect(seen).to eq([[round_failure, 1, {"workhorse.heartbeat.failure_reason" => "connection"}]])
      expect(counted.call).to eq(seen)
    ensure
      release&.set
    end

    it "counts a failed borrowed round once by reason and completes the task" do
      expect(run_until_three_heartbeats(shared_heartbeats: true)).to be(false)
      expect(heartbeats.value).to be >= 3
      expect(completed).to eq([task_id])
      expect(pool.statements.map(&:first)).not_to include(W::SqlCatalogue::FAIL_V1)
      expect_one_round_failure("connection")
    end

    it "counts a failed round on the dedicated connection once by reason and completes the task" do
      counter = heartbeats
      # The first heartbeat_pool_v1 statement loses its connection; the heartbeat replaces it.
      pool.connection_class = Class.new(FakeHeartbeatConnection) do
        define_method(:get_last_result) do
          kind, = @pending
          raise PG::ConnectionBad, "server closed the connection unexpectedly" if kind == :heartbeat && counter.increment == 1

          super()
        end
      end
      expect(run_until_three_heartbeats).to be(false)
      expect(heartbeats.value).to be >= 3
      expect(completed).to eq([task_id])
      expect(pool.statements.map(&:first)).not_to include(W::SqlCatalogue::FAIL_V1)
      expect_one_round_failure("connection")
    end
  end
end
