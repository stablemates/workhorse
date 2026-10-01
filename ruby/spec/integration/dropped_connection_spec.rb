# frozen_string_literal: true

require "connection_pool"

# PostgreSQL ends a backend when it restarts or an operator terminates it. A pooled connection to
# that backend never recovers, so the executor discards it and the pool reconnects.
RSpec.describe "A connection PostgreSQL dropped" do
  include_context "with a scratch database"

  def terminate(connection)
    pid = connection.backend_pid
    @connection.exec_params("SELECT pg_terminate_backend($1)", [pid])
    sleep 0.01 while @connection.exec_params("SELECT 1 FROM pg_stat_activity WHERE pid = $1", [pid]).ntuples.positive?
  end

  it "is replaced in a ConnectionPool, so the next enqueue succeeds" do
    pool = ConnectionPool.new(size: 1, timeout: 5) { ScratchDatabase.connect }
    expect(queue(pool).enqueue("t", {}).outcome).to eq(:accepted)
    dropped = pool.with { |connection| connection }
    terminate(dropped)

    expect { queue(pool).enqueue("t", {}) }.to raise_error(W::DatabaseError)
    expect(dropped.finished?).to be(true)
    expect(queue(pool).enqueue("t", {}).outcome).to eq(:accepted)
    expect(pool.with { |connection| connection }).not_to equal(dropped)
    expect(task_count).to eq(2)
  ensure
    pool&.shutdown { |connection| connection.close unless connection.finished? }
  end

  it "is never closed when the caller owns it" do
    owned = ScratchDatabase.connect
    expect(queue(owned).enqueue("t", {}).outcome).to eq(:accepted)
    terminate(owned)

    expect { queue(owned).enqueue("t", {}) }.to raise_error(W::DatabaseError)
    expect(owned.finished?).to be(false)
  ensure
    owned&.close
  end
end
