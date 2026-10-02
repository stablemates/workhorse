# frozen_string_literal: true

require "open3"
require_relative "../../examples/sequel"

RSpec.describe "Sequel native PostgreSQL transactional enqueue" do
  include_context "with a scratch database"

  before do
    @database = Sequel.connect(ScratchDatabase.url, max_connections: 2)
    @database.create_table?(:sequel_orders) do
      String :id, primary_key: true
      String :email, null: false
    end
    @order_id = SecureRandom.uuid
  end

  after { @database&.disconnect }

  def orders(database = @database, server = :default)
    database[:sequel_orders].server(server)
  end

  def write_order(database = @database, server = :default)
    orders(database, server).insert(id: @order_id, email: "ada@example.com")
  end

  def observed_order(connection = @connection)
    connection.exec_params("SELECT * FROM sequel_orders WHERE id = $1", [@order_id]).first
  end

  def identity(connection)
    connection.exec("SELECT pg_backend_pid() AS pid, txid_current() AS xid").first
  end

  def enqueue_order(database = @database, server = :default)
    SequelExample.enqueue_order(database, order_id: @order_id, email: "ada@example.com",
      queue_name: @queue_name, server: server)
  end

  def example_diagnostics(stderr)
    stderr.lines.grep_v(
      %r{/(?:bundler-[^/]+/lib/bundler/rubygems_ext\.rb:\d+: warning: already initialized constant Gem::Platform::[A-Z0-9_]+|rubygems/platform\.rb:\d+: warning: previous definition of [A-Z0-9_]+ was here)$}
    ).join
  end

  it "executes the published recipe and commits the business row and task together" do
    result = enqueue_order
    expect(result.outcome).to eq(:accepted)
    expect(result.task_id).to match(/\A\h{8}-\h{4}-\h{4}-\h{4}-\h{12}\z/)
    expect(observed_order.fetch("email")).to eq("ada@example.com")
    expect(JSON.parse(task_row(result.task_id).fetch("payload"))).to eq(
      "orderId" => @order_id, "email" => "ada@example.com"
    )
  end

  it "uses the dataset's physical backend and transaction without exposing either write before commit" do
    result = nil
    @database.transaction do |connection|
      expect(connection).to be_a(PG::Connection)
      dataset_identity = @database.fetch("SELECT pg_backend_pid() AS pid, txid_current() AS xid").first
      expect(identity(connection).transform_values(&:to_i)).to eq(dataset_identity.transform_keys(&:to_s))
      expect(connection.backend_pid).not_to eq(@connection.backend_pid)
      write_order
      calls = []
      allow(connection).to receive(:exec_params).and_wrap_original do |original, *arguments|
        calls << identity(connection)
        original.call(*arguments)
      end
      result = queue(connection).enqueue("order.accepted", {"orderId" => @order_id})
      expect(calls).not_to be_empty
      expect(calls.uniq).to eq([dataset_identity.transform_keys(&:to_s).transform_values(&:to_s)])
      expect(orders.where(id: @order_id).count).to eq(1)
      expect(task_count(connection)).to eq(1)
      expect(observed_order).to be_nil
      expect(task_count).to eq(0)
    end
    expect(observed_order).not_to be_nil
    expect(task_row(result.task_id)).not_to be_nil
  end

  it "rolls both recipe writes back when the outer transaction fails" do
    expect do
      @database.transaction do
        enqueue_order
        raise "application rejected the order"
      end
    end.to raise_error(RuntimeError, "application rejected the order")
    expect(observed_order).to be_nil
    expect(task_count).to eq(0)
  end

  it "rolls both writes back for Sequel::Rollback" do
    @database.transaction do
      enqueue_order
      raise Sequel::Rollback
    end
    expect(observed_order).to be_nil
    expect(task_count).to eq(0)
  end

  it "rolls back an inner savepoint and preserves the outer writes on the same connection" do
    outer_result = nil
    @database.transaction do |outer_connection|
      write_order
      outer_result = queue(outer_connection).enqueue("outer", {})
      @database.transaction(savepoint: true) do |inner_connection|
        expect(inner_connection).to equal(outer_connection)
        orders.insert(id: "inner-#{@order_id}", email: "inner@example.com")
        queue(inner_connection).enqueue("inner", {})
        raise Sequel::Rollback
      end
      expect(orders.where(id: "inner-#{@order_id}").count).to eq(0)
      expect(task_count(outer_connection)).to eq(1)
      expect(task_count).to eq(0)
    end
    expect(observed_order).not_to be_nil
    expect(task_row(outer_result.task_id)).not_to be_nil
    expect(task_count).to eq(1)
  end

  it "does not make released savepoint writes durable before the outer commit" do
    @database.transaction do |outer_connection|
      @database.transaction(savepoint: true) do |inner_connection|
        expect(inner_connection).to equal(outer_connection)
        enqueue_order
      end
      expect(task_count(outer_connection)).to eq(1)
      expect(observed_order).to be_nil
      expect(task_count).to eq(0)
      raise Sequel::Rollback
    end
    expect(observed_order).to be_nil
    expect(task_count).to eq(0)
  end

  it "leaves transaction, savepoint, checkout and connection ownership to Sequel" do
    @database.transaction do |connection|
      RSpec::Mocks.with_temporary_scope do
        expect(@database.pool).not_to receive(:release)
        expect(connection).not_to receive(:close)
        expect(connection).not_to receive(:finish)
        expect(connection).not_to receive(:reset)
        expect(connection).not_to receive(:transaction)
        expect(connection).not_to receive(:exec)
        expect(connection).not_to receive(:async_exec)
        expect(connection).not_to receive(:execute)
        expect(connection).to receive(:exec_params).at_least(:once).and_wrap_original do |original, sql, *arguments|
          expect(sql).not_to match(/\b(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i)
          original.call(sql, *arguments)
        end
        queue(connection).enqueue("owned", {})
        expect(connection.transaction_status).to eq(PG::PQTRANS_INTRANS)
        expect(connection.finished?).to be(false)
      end
      write_order
    end
    expect(observed_order).not_to be_nil
    expect(task_count).to eq(1)
  end

  it "preserves custom PG type maps, returns typed enqueue values and clears its PG results" do
    @database.transaction do |connection|
      query_map = PG::BasicTypeMapForQueries.new(connection)
      result_map = PG::BasicTypeMapForResults.new(connection)
      connection.type_map_for_queries = query_map
      connection.type_map_for_results = result_map
      results = []
      allow(connection).to receive(:exec_params).and_wrap_original do |original, *arguments|
        result = original.call(*arguments)
        results << result
        result
      end
      payload = {"unicode" => "雪☃", "nil" => nil, "integer" => 42, "boolean" => true, "nested" => [1, {"x" => "y"}]}
      result = queue(connection).enqueue("typed", payload)
      expect(result.outcome).to eq(:accepted)
      expect(result.task_id).to be_a(String)
      expect(connection.type_map_for_queries).to equal(query_map)
      expect(connection.type_map_for_results).to equal(result_map)
      expect(results).not_to be_empty
      expect(results).to all(be_cleared)
      expect(orders.insert(id: @order_id, email: "雪@example.com")).not_to be_nil
      expect(orders.where(id: @order_id).get(:email)).to eq("雪@example.com")
      @task_id = result.task_id
      @payload = payload
    end
    expect(JSON.parse(task_row(@task_id).fetch("payload"))).to eq(@payload)
  end

  it "preserves structured P1001 details and lets Sequel roll back an aborted transaction" do
    retained = W::Idempotency.new(key: "#{@queue_name}-retained")
    first = queue.enqueue("retained", {"value" => 1}, idempotency: retained)
    expect do
      @database.transaction do |connection|
        write_order
        begin
          queue(connection).enqueue("retained", {"value" => 2}, idempotency: retained)
        rescue W::EnqueueIdempotencyConflictError => error
          expect(error.details).to include("existingTaskId" => first.task_id)
          expect(error.details.fetch("conflictingFields")).to include("payload")
          expect(error.cause.result.error_field(PG::PG_DIAG_SQLSTATE)).to eq("P1001")
          expect(connection.transaction_status).to eq(PG::PQTRANS_INERROR)
          raise
        end
      end
    end.to raise_error(W::EnqueueIdempotencyConflictError)
    expect(observed_order).to be_nil
    expect(task_count).to eq(1)
    expect(enqueue_order.outcome).to eq(:accepted)
  end

  it "can recover a Workhorse SQL error by rolling back a Sequel savepoint" do
    retained = W::Idempotency.new(key: "#{@queue_name}-retained")
    queue.enqueue("retained", {"value" => 1}, idempotency: retained)
    @database.transaction do |connection|
      write_order
      expect do
        @database.transaction(savepoint: true) do |inner_connection|
          queue(inner_connection).enqueue("retained", {"value" => 2}, idempotency: retained)
        end
      end.to raise_error(W::EnqueueIdempotencyConflictError)
      expect(connection.transaction_status).to eq(PG::PQTRANS_INTRANS)
      queue(connection).enqueue("after.savepoint", {})
    end
    expect(observed_order).not_to be_nil
    expect(task_count).to eq(2)
  end

  it "preserves ordinary SQLSTATE and rolls back the business write" do
    expect do
      @database.transaction do |connection|
        write_order
        records = queue(connection)
        records.assert_compatible
        connection.exec(<<~SQL)
          CREATE FUNCTION pg_temp.sequel_reject_task() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'test rejection' USING ERRCODE = '23514'; END $$;
          CREATE TRIGGER sequel_reject_task BEFORE INSERT ON workhorse.task
            FOR EACH ROW EXECUTE FUNCTION pg_temp.sequel_reject_task();
        SQL
        records.enqueue("rejected", {})
      end
    end.to raise_error(W::DatabaseError) { |error| expect(error.sqlstate).to eq("23514") }
    expect(observed_order).to be_nil
    expect(task_count).to eq(0)
  end

  it "binds the yielded connection and matching dataset to the selected server/shard" do
    @database.disconnect
    shard_url = ScratchDatabase.extra("sequel-shard")
    observer = PG.connect(shard_url)
    observer.exec("CREATE TABLE sequel_orders (id text PRIMARY KEY, email text NOT NULL)")
    @database = Sequel.connect(ScratchDatabase.url, servers: {orders: {database: observer.db}})
    @database.transaction(server: :orders) do |connection|
      expect(connection.db).not_to eq(@connection.db)
      enqueue_order(@database, :orders)
      expect(orders(@database, :orders).where(id: @order_id).count).to eq(1)
      expect(task_count(connection)).to eq(1)
      expect(observed_order(observer)).to be_nil
      expect(task_count(observer)).to eq(0)
      expect(orders.where(id: @order_id).count).to eq(0)
    end
    expect(observed_order(observer)).not_to be_nil
    expect(task_count(observer)).to eq(1)
    expect(observed_order).to be_nil
    expect(task_count).to eq(0)
  ensure
    observer&.close
    @database.disconnect
    ScratchDatabase.drop_extra("sequel-shard")
  end

  it "does not turn a database or dataset into a supported PG executor" do
    expect { queue(@database) }.to raise_error(ArgumentError, /executor/)
    expect { queue(orders).enqueue("not.a.connection", {}) }.to raise_error(ArgumentError)
  end

  it "does not extend the yielded connection's lifetime beyond Sequel's checkout" do
    @database.transaction do |connection|
      queue(connection).enqueue("within.lifetime", {})
      @borrowed = connection
      @escaped_queue = queue(connection)
    end
    expect(@borrowed.finished?).to be(false)
    @database.disconnect
    expect(@borrowed.finished?).to be(true)
    expect { @escaped_queue.enqueue("outside.lifetime", {}) }.to raise_error(W::DatabaseError)
    expect(task_count).to eq(1)
  end

  it "requires owner-directed disconnect when a raw Workhorse transport error escapes Sequel's wrappers" do
    expect do
      @database.transaction do |connection|
        @broken = connection
        write_order
        records = queue(connection)
        records.assert_compatible
        @connection.exec_params("SELECT pg_terminate_backend($1)", [connection.backend_pid])
        RSpec::Mocks.with_temporary_scope do
          expect(connection).not_to receive(:close)
          records.enqueue("disconnected", {})
        end
      end
    end.to raise_error(W::DatabaseError) { |error| expect(error.cause).to be_a(PG::Error) }
    expect(@broken.finished?).to be(false)
    expect(observed_order).to be_nil
    expect(task_count).to eq(0)
    @database.disconnect
    expect(@broken.finished?).to be(true)
    expect(enqueue_order.outcome).to eq(:accepted)
  end

  it "lets Sequel detect a broken connection during commit and replace it" do
    expect do
      @database.transaction do |connection|
        write_order
        records = queue(connection)
        records.assert_compatible
        @connection.exec_params("SELECT pg_terminate_backend($1)", [connection.backend_pid])
        expect(connection).not_to receive(:close)
        expect do
          records.enqueue("disconnected", {})
        end.to raise_error(W::DatabaseError)
        expect(connection.finished?).to be(false)
      end
    end.to raise_error(Sequel::DatabaseDisconnectError)
    expect(observed_order).to be_nil
    expect(task_count).to eq(0)
    expect(enqueue_order.outcome).to eq(:accepted)
  end

  it "runs the standalone example against an installed scratch schema" do
    stdout, stderr, status = Open3.capture3({"WORKHORSE_DATABASE_URL" => ScratchDatabase.url},
      "bundle", "exec", "ruby", "-Ilib", "examples/sequel.rb", chdir: File.expand_path("../..", __dir__))
    expect([status.exitstatus, example_diagnostics(stderr)]).to eq([0, ""])
    task_id = stdout.strip
    expect(task_id).to match(/\A\h{8}-\h{4}-\h{4}-\h{4}-\h{12}\z/)
    payload = JSON.parse(task_row(task_id).fetch("payload"))
    expect(orders.where(id: payload.fetch("orderId")).get(:email)).to eq("ada@example.com")
  end

  it "excludes only Bundler's RubyGems platform redefinition warnings from the child diagnostics" do
    tooling = <<~OUTPUT
      /ruby/gems/bundler-2.6.9/lib/bundler/rubygems_ext.rb:64: warning: already initialized constant Gem::Platform::JAVA
      /ruby/rubygems/platform.rb:279: warning: previous definition of JAVA was here
    OUTPUT
    application = <<~OUTPUT
      examples/sequel.rb:12: warning: already initialized constant Gem::Platform::JAVA
      /ruby/rubygems/platform.rb:280: warning: another warning
      /ruby/gems/bundler-2.6.9/lib/bundler/rubygems_ext.rb:65: error: toolchain failed
    OUTPUT
    expect(example_diagnostics(tooling + application)).to eq(application)
  end
end
