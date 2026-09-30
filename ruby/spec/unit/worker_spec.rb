# frozen_string_literal: true

require "spec_helper"

RSpec.describe W::Worker do
  pool_class = Class.new(FakeExecutor) do
    attr_accessor :capacity

    def size = capacity || 3

    def with = raise("unit specs never check out a connection")
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
    expect(worker(concurrency: 64).cohorts).to eq(2)
    expect(worker(concurrency: 64, shared_heartbeats: true).cohorts).to eq(3)
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
end
