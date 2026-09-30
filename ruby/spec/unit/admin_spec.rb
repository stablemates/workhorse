# frozen_string_literal: true

RSpec.describe Stablemates::Workhorse::Admin do
  task = "0190a6f8-0000-7000-8000-000000000001"
  audit = W::AdminAudit.new("operator", "investigating", "request-1")

  def refusal
    executor = FakeExecutor.new
    message = nil
    expect { yield described_class.new(executor) }.to raise_error(ArgumentError) { |error| message = error.message }
    expect(executor.statements).to be_empty, "an invalid request runs no statement"
    message
  end

  it "validates the audit before any statement" do
    expect(refusal { |admin| admin.pause_queue("q", audit: W::AdminAudit.new("", "r", "id")) })
      .to eq("actor must contain between 1 and 200 characters")
    expect(refusal { |admin| admin.pause_queue("q", audit: W::AdminAudit.new("a", "r" * 2001, "id")) })
      .to eq("reason must contain between 1 and 2000 characters")
    expect(refusal { |admin| admin.redrive(task, audit: W::AdminAudit.new("a", "r", "é" * 257)) })
      .to eq("request_id must contain between 1 and 512 UTF-8 bytes")
    expect(refusal { |admin| admin.purge_queue("q", audit: nil) }).to eq("audit must be an AdminAudit")
    expect(refusal { |admin| admin.set_worker_paused("w", "yes", audit: audit) }).to eq("paused must be true or false")
  end

  it "validates page limits" do
    expect(refusal { |admin| admin.list_tasks(limit: 0) }).to eq("list_tasks limit must be an integer between 1 and 1000")
    expect(refusal { |admin| admin.get_task_timeline(task, limit: 1001) })
      .to eq("get_task_timeline limit must be an integer between 1 and 1000")
    expect(refusal { |admin| admin.list_dead_letters(limit: 1.5) })
      .to eq("list_dead_letters limit must be an integer between 1 and 1000")
    expect(refusal { |admin| admin.redrive_many(audit: audit, limit: true) })
      .to eq("redrive_many limit must be an integer between 1 and 1000")
    expect(refusal { |admin| admin.list_signal_waits(limit: 0) }).to eq("external wait limit must be an integer between 1 and 1000")
    expect(refusal { |admin| admin.list_human_waits(limit: 1001) })
      .to eq("external wait limit must be an integer between 1 and 1000")
  end

  it "validates a task query" do
    now = Time.now
    expect(refusal { |admin| admin.list_tasks(created_after: now, created_before: now) })
      .to eq("created_after must be earlier than created_before")
    expect(refusal { |admin| admin.list_tasks(states: %i[ready ready]) }).to eq("states must be unique")
    expect(refusal { |admin| admin.list_tasks(states: %i[running]) }).to eq("states contains an invalid task state")
    projection = ->(**options) { W::TaskPayloadProjection.new(include: true, **options) }
    expect(refusal { |admin| admin.list_tasks(payload: projection.call(max_bytes: 0)) }).to eq("payload max_bytes is out of range")
    expect(refusal { |admin| admin.list_tasks(payload: projection.call(redact_keys: Array.new(51) { |index| "k#{index}" })) })
      .to eq("payload redact_keys must contain at most 50 keys")
    expect(refusal { |admin| admin.list_tasks(payload: projection.call(redact_keys: %w[a a])) })
      .to eq("payload redact_keys must be unique")
    expect(refusal { |admin| admin.list_tasks(payload: projection.call(redact_keys: [""])) })
      .to eq("payload redact_keys must contain strings of 1 to 200 characters")
  end

  it "requires a timeline cursor for the requested task" do
    cursor = W::TaskTimelineCursor.new("0190a6f8-0000-7000-8000-000000000002", "2026-01-01", :event, task)
    expect(refusal { |admin| admin.get_task_timeline(task, cursor: cursor) })
      .to eq("cursor task_id must match the requested task_id")
  end

  it "encodes the task filter and projection" do
    executor = FakeExecutor.new
    after = Time.utc(2026, 1, 1)
    described_class.new(executor).list_tasks(queue: "q", states: %i[failed], created_after: after)

    sql, params = executor.statements.first
    expect(sql).to eq(W::SqlCatalogue::LIST_TASKS)
    expect(JSON.parse(params[0])).to eq({"queue" => "q", "states" => ["failed"],
      "createdAfter" => "2026-01-01T00:00:00.000Z"})
    expect(params[1..4]).to eq(["100", nil, nil, nil])
    expect(JSON.parse(params[5])).to eq({"include" => false, "maxBytes" => 16_384, "redactKeys" => []})
  end

  it "raises UnexpectedStatusError for an unknown redrive status" do
    executor = FakeExecutor.new do
      [{"status" => "exploded", "source_task_id" => task, "target_task_id" => nil, "source_state" => nil,
        "target_state" => nil, "requested_at" => nil}]
    end

    expect { described_class.new(executor).redrive(task, audit: audit) }
      .to raise_error(W::UnexpectedStatusError) { |error| expect(error.status).to eq("exploded") }
  end

  it "refuses an incompatible schema once and caches the refusal" do
    executor = Class.new(W::Executor) do
      attr_reader :calls

      def initialize
        super(nil)
        @calls = 0
      end

      def rows(_sql, _params = [])
        @calls += 1
        []
      end
    end.new
    admin = described_class.new(executor)

    2.times { expect { admin.list_workers }.to raise_error(W::CompatibilityError) }
    expect(executor.calls).to eq(1)
  end
end
