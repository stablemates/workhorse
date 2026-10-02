# frozen_string_literal: true

require "connection_pool"

RSpec.describe "Unstorable results against PostgreSQL" do
  include_context "with a scratch database"

  before { @pool = ConnectionPool.new(size: 4, timeout: 5) { ScratchDatabase.connect } }

  after { @pool&.shutdown(&:close) }

  # Each document is valid JSON, which the json cast confirms. The worker's escape scan must agree
  # with PostgreSQL's jsonb cast on it.
  cast_documents = <<~'JSON'.lines(chomp: true)
    "\u0000"
    {"items":["ok",{"note":"a\u0000b"}]}
    {"k\u0000":1}
    "\ud800"
    "\udc00"
    [1,["\ud83dx"]]
    {"\udfff":true}
    "\ude00\ud83d"
    "\ud83d\\ude00"
    "\ud83d\n"
    ["\ud83d","\ude00"]
    {"\ud83d":"\ude00"}
    "\ud83d\ude00"
    "\uD83D\uDE00"
    {"\ud83d\ude00":"\uD83D\uDE00"}
    "😀"
    "\uD800"
    "\uDC00x"
    "\u003c\u003e\u0026"
    "\u00e9\u00E9"
    "\\u0000"
    {"\\ud800":"\\\\ud800"}
    "\\\u0001"
    "\u0001\u001f "
    "é�"
    "🙂"
    "plain"
    {"a":[1,true,null]}
  JSON

  it "refuses exactly the escapes PostgreSQL's jsonb cast refuses" do
    scanner = W::Worker.allocate
    refused = cast_documents.map do |document|
      @connection.exec_params("SELECT $1::text::json", [document])
      begin
        @connection.exec_params("SELECT $1::text::jsonb", [document])
        [document, false]
      rescue PG::UntranslatableCharacter, PG::InvalidTextRepresentation
        [document, true]
      end
    end

    expect(cast_documents.map { |document| [document, scanner.send(:unstorable_escape?, document)] }).to eq(refused)
  end

  it "fails an unstorable result under its retry policy and keeps running" do
    # A custom to_json is the only way to write a surrogate escape; JSON.generate refuses one.
    lone_surrogate = Class.new(Array) { def to_json(*) = '{"k":"\\ud800"}' }.new
    retried = {max_attempts: 2, retry_policy: {"type" => "fixed", "delayMs" => 0}}
    nul = queue.enqueue("nul", {}, **retried).task_id
    surrogate = queue.enqueue("surrogate", {}, **retried).task_id
    valid = queue.enqueue("valid", {}).task_id
    subject = W::Worker.new(@pool, queues: [@queue_name], polling_only: true, poll_interval: 0.01,
      disable_registry: true)
    subject.handle("nul") { "a\u0000b" }
    subject.handle("surrogate") { lone_surrogate }
    subject.handle("valid") { "done" }

    expect { 5.times { subject.run_once } }.not_to raise_error
    {nul => "nul", surrogate => "surrogate"}.each do |id, type|
      row = task_row_state(id)
      expect(row.values_at("state", "attempt")).to eq(["failed", "2"])
      expect(JSON.parse(row["error"]).values_at("name", "message")).to eq(
        ["ArgumentError",
          "#{type} result contains a NUL character or an unpaired surrogate, which PostgreSQL jsonb cannot store"]
      )
    end
    expect(task_row_state(valid).values_at("state", "attempt")).to eq(["succeeded", "1"])
  end

  def task_row_state(task_id)
    @connection.exec_params(<<~SQL, [task_id]).first
      SELECT outcome.state, outcome.current_attempt AS attempt, outcome.error
        FROM workhorse.task_outcome outcome
       WHERE outcome.task_id = $1
    SQL
  end
end
