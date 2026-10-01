# frozen_string_literal: true

require "connection_pool"

RSpec.describe "Result size limits against PostgreSQL" do
  include_context "with a scratch database"

  before { @pool = ConnectionPool.new(size: 4, timeout: 5) { ScratchDatabase.connect } }

  after { @pool&.shutdown(&:close) }

  it "measures each value as octet_length of its jsonb text" do
    corpus = [
      nil, true, false, 0, -0.0, 1.5, -2.5e-10, 1.23e-20, 1e+20, 9.99e+300, 5e-324, 2**70, -(2**63),
      "", "é€😀", "\u0001\n\t\"\\\u007f/\u2028", [], {}, [1, [2, [3, []]]],
      {"a" => {"b" => [1, "é", nil]}, "ü" => {}, "" => 0.1}
    ]
    # A custom to_json can write these, and jsonb keeps the scale each token states.
    texts = corpus.map { |value| W::Values.json(value) } +
      %w[1e20 1E+20 1.00000 0.5e1 1.5E-3 -0e5 0.00 -1.50e1 120E-1 0.001e3] + ['{"a":1,"a":2.50}']
    measured = texts.map do |text|
      Integer(@connection.exec_params("SELECT octet_length($1::jsonb::text)", [text]).getvalue(0, 0), 10)
    end

    expect(texts.map { |text| W::Values.jsonb_text_bytes(text) }).to eq(measured)
  end

  it "fails the attempt of a result whose jsonb text exceeds the default limit and keeps running" do
    oversized = queue.enqueue("big", {}, max_attempts: 1).task_id
    valid = queue.enqueue("small", {}).task_id
    subject = W::Worker.new(@pool, queues: [@queue_name], polling_only: true, poll_interval: 0.01,
      disable_registry: true)
    # 400,000 ones are 800,001 bytes of compact JSON but 1,200,000 bytes of jsonb text.
    subject.handle("big") { [1] * 400_000 }
    subject.handle("small") { "done" }

    expect { 2.times { subject.run_once } }.not_to raise_error
    big = task_row_state(oversized)
    expect(big["state"]).to eq("failed")
    expect(JSON.parse(big["error"]).values_at("name", "message"))
      .to eq(["Stablemates::Workhorse::ValueSizeLimitError", "big result exceeds its configured size limit"])
    expect(task_row_state(valid)["state"]).to eq("succeeded")
  end

  def task_row_state(task_id)
    @connection.exec_params(<<~SQL, [task_id]).first
      SELECT COALESCE(outcome.state, runtime.state) AS state, COALESCE(outcome.error, runtime.error) AS error
        FROM workhorse.task task
        LEFT JOIN workhorse.task_runtime runtime ON runtime.task_id = task.id
        LEFT JOIN workhorse.task_outcome outcome ON outcome.task_id = task.id
       WHERE task.id = $1
    SQL
  end
end
