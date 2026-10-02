# frozen_string_literal: true

require "spec_helper"

# PostgreSQL's jsonb refuses a string or key that holds NUL or a surrogate outside a pair. The worker
# scans each encoded result first, so the refusal fails one attempt and never stops the worker.
RSpec.describe W::Worker do
  fast_claim = W::SqlCatalogue::COMPLETE_MANY_AND_CLAIM_V1

  # Answers as PostgreSQL would. complete_v1 raises for a result jsonb refuses, and
  # complete_many_and_claim_v1 raises for a batch that holds one. Each refused text is listed, so
  # the fake does not rely on the scan under test.
  pool_class = Class.new(FakeExecutor) do
    attr_accessor :fast

    def size = 3

    def with = raise("unit specs never check out a connection")
  end

  # JSON.generate writes NUL as \u0000 and raises for a lone surrogate, so only a custom to_json
  # writes a surrogate escape.
  def writes(text) = Class.new(Array) { define_method(:to_json) { |*| text } }.new

  # The encoded text of each result and the SQLSTATE PostgreSQL's jsonb cast reports for it.
  refused = {
    '"a\u0000b"' => "22P05", '"\ud800"' => "22P02", '["\udc00"]' => "22P02", '{"k":"\ud83dx"}' => "22P02"
  }
  let(:unstorable) do
    {
      "NUL" => "a\u0000b", "an unpaired high surrogate" => writes('"\ud800"'),
      "an unpaired low surrogate" => writes('["\udc00"]'), "a high surrogate before text" => writes('{"k":"\ud83dx"}')
    }
  end
  let(:valid_pair) { writes('"\ud83d\ude00"') }

  let(:pending) { [] }
  let(:completed) { Concurrent::Array.new }
  let(:outage) { nil }
  let(:pool) do
    pool_class.new do |sql, params|
      case sql
      when fast_claim
        raise W::FastTierUnsupportedError.new(params[4], "claim", nil) unless pool.fast

        results = W::Values.parse_text_array(params[3])
        if (code = results.filter_map { |result| refused[result] }.first)
          raise W::DatabaseError.new("unsupported Unicode escape sequence", code)
        end

        completed.concat(W::Values.parse_text_array(params[1]))
        claimed = pending.shift(params[5].to_i)
        claimed = [{"task_id" => nil}] if claimed.empty?
        [claimed.first.merge("accepted" => params[1]), *claimed.drop(1)]
      when W::SqlCatalogue::CLAIM_MANY_V1 then pending.shift(params[2].to_i)
      when W::SqlCatalogue::COMPLETE_V1
        raise outage if outage
        if (code = refused[params[3]])
          raise W::DatabaseError.new("unsupported Unicode escape sequence", code)
        end

        completed << params[0]
        [{"accepted" => "t"}]
      when W::SqlCatalogue::FAIL_V1 then [{"state" => "failed"}]
      else []
      end
    end
  end

  def enqueue(type)
    id = SecureRandom.uuid
    pending << {
      "task_id" => id, "task_type" => type, "priority" => "0", "payload" => "{}", "contract_version" => nil,
      "result_max_bytes" => "1048576", "attempt" => "1", "max_attempts" => "3", "fence_token" => "1",
      "lease_expires_at" => "2099-01-01 00:00:00+00"
    }
    id
  end

  def worker(**options)
    described_class.new(pool, queues: ["default"], polling_only: true, poll_interval: 0.01, disable_registry: true,
      **options)
  end

  def statements(sql) = pool.statements.select { |statement, _| statement == sql }.map(&:last)

  def failures
    statements(W::SqlCatalogue::FAIL_V1).to_h { |params| [params[0], JSON.parse(params[3])] }
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

  def unstorable_failure(type)
    {"name" => "ArgumentError",
     "message" => "#{type} result contains a NUL character or an unpaired surrogate, " \
       "which PostgreSQL jsonb cannot store"}
  end

  # Enqueues one task per unstorable result, then the task whose result is a valid pair.
  def enqueue_results(type)
    results = unstorable.values.to_h { |result| [enqueue(type), result] }
    valid = enqueue(type)
    [results.merge(valid => valid_pair), valid]
  end

  def expect_only_valid_completed(valid, results)
    expect(failures.keys).to match_array(results.keys - [valid])
    failures.each_value { |envelope| expect(envelope).to include(unstorable_failure("unstorable")) }
    expect(completed).to eq([valid])
  end

  it "fails each unstorable result's attempt, keeps running, and completes a valid pair" do
    results, valid = enqueue_results("unstorable")
    subject = worker(concurrency: results.size)
    subject.handle("unstorable") { |_payload, context| results.fetch(context.task.id) }

    expect(run_until_completed(subject, valid)).to be_nil
    expect_only_valid_completed(valid, results)
    expect(statements(W::SqlCatalogue::COMPLETE_V1).map(&:first)).to eq([valid])
  end

  it "fails an unstorable batch member alone" do
    results, valid = enqueue_results("unstorable")
    subject = worker(concurrency: results.size)
    subject.handle_batch("unstorable", max_size: results.size, linger: 1) do |items|
      items.map { |item| {status: :succeeded, result: results.fetch(item.context.task.id)} }
    end

    expect(run_until_completed(subject, valid)).to be_nil
    expect_only_valid_completed(valid, results)
  end

  it "keeps an unstorable fast-tier result out of the completion batch" do
    pool.fast = true
    results, valid = enqueue_results("unstorable")
    subject = worker(concurrency: results.size)
    subject.handle("unstorable") { |_payload, context| results.fetch(context.task.id) }

    expect(run_until_completed(subject, valid)).to be_nil
    expect_only_valid_completed(valid, results)
    expect(statements(fast_claim).flat_map { |params| W::Values.parse_text_array(params[1]) }).to eq([valid])
  end

  context "when the completion statement fails for an operational reason" do
    let(:outage) { W::DatabaseError.new("terminating connection due to administrator command", "57P01") }

    it "still stops the worker and fails no attempt" do
      enqueue("outage")
      subject = worker
      subject.handle("outage") { "done" }

      expect { subject.run }.to raise_error(W::DatabaseError, /administrator command/)
      expect(failures).to eq({})
    end
  end

  describe "the escape scan" do
    def scan(text) = subject.send(:unstorable_escape?, text)

    subject { worker }

    # JSON.generate writes non-ASCII text and < raw, so ordinary text has no escape for the quick
    # check to find. The full scan still accepts a valid surrogate pair.
    it "keeps ordinary text off the full scan" do
      quick_check = described_class.const_get(:UNSTORABLE_ESCAPE_START)
      ["é<b>&amp;", {"ключ" => "値 <a href>"}, "😀", " "].each do |value|
        expect(quick_check.match?(JSON.generate(value))).to be(false)
      end
      ['"\ud83d\ude00"', '"\uD83D\uDE00"'].each do |text|
        expect(quick_check.match?(text)).to be(true)
        expect(scan(text)).to be(false)
      end
      ['"\u0000"', '"\ud800"', '"\uDC00"', '"<<\uD83D"'].each { |text| expect(scan(text)).to be(true) }
    end
  end
end
