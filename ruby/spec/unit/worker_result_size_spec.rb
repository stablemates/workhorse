# frozen_string_literal: true

require "spec_helper"

# PostgreSQL refuses a completion whose result's jsonb text exceeds the task's result_max_bytes.
# The worker measures that text first, so the refusal fails one attempt and never stops the worker.
RSpec.describe W::Worker do
  fast_claim = W::SqlCatalogue::COMPLETE_MANY_AND_CLAIM_V1
  let(:default_limit) { 1_048_576 }

  # Answers as PostgreSQL would. A claim hands out the pending tasks. complete_v1 raises for a
  # result over its task's limit, and complete_many_and_claim_v1 leaves such a result unaccepted.
  # The size check stands in for octet_length(result::jsonb::text). PostgreSQL measured each text
  # in jsonb_sizes, so those cases do not rely on the measure under test; an integration spec holds
  # Values.jsonb_text_bytes to PostgreSQL for the rest.
  pool_class = Class.new(FakeExecutor) do
    attr_accessor :fast, :schemas

    def size = 3

    def with = raise("unit specs never check out a connection")

    def rows(sql, params = [])
      if sql == W::SqlCatalogue::GET_CONTRACT_DEFINITION_V1 && schemas
        return [{"schema" => JSON.generate(schemas.fetch(params.first))}]
      end

      super
    end
  end

  let(:pending) { [] }
  let(:limits) { {} }
  let(:completed) { Concurrent::Array.new }
  let(:pool) do
    pool_class.new do |sql, params|
      case sql
      when fast_claim
        raise W::FastTierUnsupportedError.new(params[4], "claim", nil) unless pool.fast

        results = W::Values.parse_text_array(params[1]).zip(W::Values.parse_text_array(params[3]))
        accepted = results.reject { |id, result| oversized?(id, result) }.map(&:first)
        completed.concat(accepted)
        claimed = pending.shift(params[5].to_i)
        claimed = [{"task_id" => nil}] if claimed.empty?
        [claimed.first.merge("accepted" => W::Values.text_array(accepted, "accepted")), *claimed.drop(1)]
      when W::SqlCatalogue::CLAIM_MANY_V1 then pending.shift(params[2].to_i)
      when W::SqlCatalogue::COMPLETE_V1
        raise W::DatabaseError.new("result exceeds its configured size limit", "P0001") if oversized?(params[0], params[3])

        completed << params[0]
        [{"accepted" => "t"}]
      when W::SqlCatalogue::FAIL_V1 then [{"state" => "failed"}]
      else []
      end
    end
  end

  let(:jsonb_sizes) { {"1e20" => 21, "1E+20" => 21, "1.00000" => 7} }

  def oversized?(id, result) = jsonb_sizes.fetch(result) { W::Values.jsonb_text_bytes(result) } > limits.fetch(id)

  def enqueue(type, limit: default_limit, contract_version: nil)
    id = SecureRandom.uuid
    limits[id] = limit
    pending << {
      "task_id" => id, "task_type" => type, "priority" => "0", "payload" => "{}",
      "contract_version" => contract_version, "result_max_bytes" => limit.to_s, "attempt" => "1",
      "max_attempts" => "3", "fence_token" => "1", "lease_expires_at" => "2099-01-01 00:00:00+00"
    }
    id
  end

  def worker(**options)
    described_class.new(pool, queues: ["default"], polling_only: true, poll_interval: 0.01, disable_registry: true,
      **options)
  end

  def statements(sql) = pool.statements.select { |statement, _| statement == sql }.map(&:last)

  def failures
    statements(W::SqlCatalogue::FAIL_V1).map { |params| [params[0], JSON.parse(params[3])] }
  end

  # Runs the worker until +ids+ completed, then stops it and returns what run returned.
  def run_until_completed(subject, *ids)
    runner = Thread.new { subject.run }
    deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + 5
    until (ids - completed).empty? || !runner.alive?
      raise "tasks #{ids - completed} never completed" if Process.clock_gettime(Process::CLOCK_MONOTONIC) > deadline

      sleep 0.01
    end
    subject.stop
    runner.join(5).value
  end

  def size_failure(type)
    {"name" => "Stablemates::Workhorse::ValueSizeLimitError",
     "message" => "#{type} result exceeds its configured size limit"}
  end

  it "fails an oversized result's attempt, keeps running, and completes the next task" do
    oversized = enqueue("big", limit: 64)
    valid = enqueue("small", limit: 64)
    subject = worker
    subject.handle("big") { "x" * 63 }
    subject.handle("small") { "x" * 62 }

    expect(run_until_completed(subject, valid)).to be_nil
    expect(failures.map(&:first)).to eq([oversized])
    expect(failures.first.last).to include(size_failure("big"))
    expect(statements(W::SqlCatalogue::COMPLETE_V1).map(&:first)).to eq([valid])
    expect(completed).to eq([valid])
  end

  it "measures an uncontracted task against the default limit" do
    over = enqueue("over")
    within = enqueue("within")
    subject = worker
    # A string at the limit, less its quotes, fits; one more byte does not.
    subject.handle("over") { "x" * (default_limit - 1) }
    subject.handle("within") { "x" * (default_limit - 2) }

    expect(run_until_completed(subject, within)).to be_nil
    expect(failures.map(&:first)).to eq([over])
  end

  it "measures a contracted task against its own result limit" do
    pool.schemas = {"contracted" => {"payload" => {}, "result" => {"type" => "array"}}}
    over = enqueue("contracted", limit: 20, contract_version: "1")
    within = enqueue("contracted", limit: 20, contract_version: "1")
    results = {over => [1, 2, 3, 4, 5, 6, 7], within => [1, 2, 3, 4, 5, 6]}
    subject = worker
    subject.handle("contracted") { |_payload, context| results.fetch(context.task.id) }

    # [1, 2, 3, 4, 5, 6] is 18 bytes of jsonb text, though its compact text is 13.
    expect(run_until_completed(subject, within)).to be_nil
    expect(failures.map(&:first)).to eq([over])
    expect(failures.first.last).to include(size_failure("contracted"))
  end

  it "measures the JSON a result serializes to, not the object the handler returned" do
    # An empty Array that serializes as a 63-character string: 2 bytes as an object, 65 as JSON.
    disguised = Class.new(Array) { def to_json(*) = JSON.generate("x" * 63) }
    over = enqueue("disguised", limit: 64)
    within = enqueue("plain", limit: 64)
    subject = worker
    subject.handle("disguised") { disguised.new }
    subject.handle("plain") { "x" * 62 }

    expect(run_until_completed(subject, within)).to be_nil
    expect(failures.map(&:first)).to eq([over])
    expect(failures.first.last).to include(size_failure("disguised"))
  end

  # A custom to_json can write a number JSON.generate never would: an exponent without a sign or in
  # uppercase, or a scale a Float drops.
  {"1e20" => 16, "1E+20" => 16, "1.00000" => 4}.each do |token, limit|
    it "measures the number #{token} as PostgreSQL stores it" do
      number = Class.new(Array) { define_method(:to_json) { |*| token } }
      over = enqueue("number", limit: limit)
      within = enqueue("plain", limit: limit)
      subject = worker
      subject.handle("number") { number.new }
      subject.handle("plain") { 1 }

      expect(run_until_completed(subject, within)).to be_nil
      expect(failures.map(&:first)).to eq([over])
      expect(failures.first.last).to include(size_failure("number"))
      expect(statements(W::SqlCatalogue::COMPLETE_V1).map(&:first)).to eq([within])
    end
  end

  it "measures a result with duplicate keys as PostgreSQL stores it" do
    # Two distinct "a" keys serialize as {"a":…,"a":…}; jsonb keeps the last, which is 29 bytes.
    duplicated = {}.compare_by_identity
    duplicated[+"a"] = "x" * 20
    duplicated[+"a"] = "y" * 20
    within = enqueue("duplicated", limit: 32)
    subject = worker
    subject.handle("duplicated") { duplicated }

    expect(run_until_completed(subject, within)).to be_nil
    expect(failures).to eq([])
  end

  it "fails an oversized batch member alone" do
    over = enqueue("batch", limit: 16)
    within = enqueue("batch", limit: 16)
    subject = worker(concurrency: 2)
    subject.handle_batch("batch", max_size: 2, linger: 1) do |items|
      items.map { |item| {status: :succeeded, result: (item.context.task.id == over) ? 1e+20 : 1e+10} }
    end

    # 1e+20 is five bytes of compact JSON but 21 of jsonb text.
    expect(run_until_completed(subject, within)).to be_nil
    expect(failures.map(&:first)).to eq([over])
    expect(failures.first.last).to include(size_failure("batch"))
  end

  it "keeps an oversized fast-tier result out of the completion batch" do
    pool.fast = true
    over = enqueue("fast", limit: 8)
    within = enqueue("fast", limit: 8)
    subject = worker(concurrency: 2)
    subject.handle("fast") { |_payload, context| (context.task.id == over) ? "é" * 4 : "é" * 3 }

    # "éééé" is ten bytes of UTF-8 text with its quotes.
    expect(run_until_completed(subject, within)).to be_nil
    expect(failures.map(&:first)).to eq([over])
    expect(completed).to eq([within])
    expect(statements(fast_claim).flat_map { |params| W::Values.parse_text_array(params[1]) }).to eq([within])
  end
end
