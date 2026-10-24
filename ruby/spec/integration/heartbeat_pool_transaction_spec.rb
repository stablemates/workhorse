# frozen_string_literal: true

require "connection_pool"
require_relative "../support/delaying_proxy"

# SM-1633: the heartbeat thread of a pool renews the leases of every worker on that pool in one
# transaction for each round. With one transaction for each worker, a round on a slow network
# needed more round trips than the lease allowed, and the idle budget was shorter than one round
# trip.
#
# A heartbeat round with a 2 s interval has a 1.5 s bound. After BEGIN, the settings statement and
# each idle gap of the round get one quarter of the rest, about 355 ms. Each of them includes one
# 80 ms delay of the proxy. So a loaded host can stall each of them by more than 250 ms. With a 1 s
# interval that margin was about 85 ms, which a host stall can use up (SM-1760).
#
# The 6 s lease keeps a lease through one lost round, as the 3 s lease did with a 1 s interval. A
# transaction for each worker still needs 32 round trips, 2.56 s. No round bound of this spec
# allows that.
RSpec.describe "Worker heartbeat transaction for every worker on a pool against PostgreSQL" do
  include_context "with a scratch database"

  def monotonic = Process.clock_gettime(Process::CLOCK_MONOTONIC)

  def wait_until(timeout)
    deadline = monotonic + timeout
    sleep 0.05 until yield || monotonic > deadline
    raise "condition not met within #{timeout} seconds" unless yield
  end

  def succeeded(task_ids)
    @connection.exec_params("SELECT count(*) FROM workhorse.task_outcome WHERE state = 'succeeded' " \
      "AND task_id::text = ANY($1::text[])", [PG::TextEncoder::Array.new.encode(task_ids)]).getvalue(0, 0).to_i
  end

  it "keeps every lease of many workers on a small pool when each round trip takes 80 ms" do
    options = PG::Connection.conninfo_parse(ScratchDatabase.url).to_h { |option| [option[:keyword], option[:val]] }
    proxy = DelayingProxy.start(options["host"] || "localhost", Integer(options["port"] || "5432", 10), 0.08)
    connected = Concurrent::AtomicFixnum.new
    pool = ConnectionPool.new(size: 6, timeout: 30) do
      # The proxy reads the type of each message, so the connection must not use TLS. The spec
      # measures round trips, not the disk: other test databases on the same server can make a WAL
      # flush wait for seconds, so a COMMIT of the workers does not wait for its flush.
      PG.connect(ScratchDatabase.url, host: "127.0.0.1", port: proxy.port, sslmode: "disable",
        options: "-c synchronous_commit=off",
        connect_timeout: ScratchDatabase::CONNECT_TIMEOUT).tap { connected.increment }
    end
    workers = Array.new(8) do
      W::Worker.new(pool, queues: [@queue_name], disable_registry: true, concurrency: 2, lease: 6, heartbeat: 2)
        .handle("sleeps") do
        # Longer than the lease, so only renewals keep it.
        sleep 7
        {}
      end
    end
    runners = workers.map { |worker| Thread.new { worker.run } }
    # The local lease window of an attempt starts when its claim starts. A claim that waits for the
    # start of the workers can thus use up its lease, so the tasks arrive only after the pool has
    # opened every connection.
    wait_until(30) { connected.value == 6 }
    sleep 1
    task_ids = Array.new(32) { queue.enqueue("sleeps", {}).task_id }

    wait_until(60) { succeeded(task_ids) == task_ids.size }

    workers.each(&:stop)
    runners.each { |runner| expect(runner.join(30)).not_to be_nil }
    histories = @connection.exec_params("SELECT task_id::text, array_agg(outcome ORDER BY attempt)::text " \
      "FROM workhorse.attempt_history WHERE task_id::text = ANY($1::text[]) GROUP BY task_id",
      [PG::TextEncoder::Array.new.encode(task_ids)]).values.to_h
    expect(histories.keys).to match_array(task_ids)
    failed = histories.reject { |_, outcomes| outcomes == "{succeeded}" }
    expect(failed).to be_empty, "tasks with an attempt that did not succeed (task id => attempt outcomes): #{failed}"
  ensure
    workers&.each(&:stop)
    runners&.each { |runner| runner.join(5) }
    pool&.shutdown(&:close)
    proxy&.close
  end
end
