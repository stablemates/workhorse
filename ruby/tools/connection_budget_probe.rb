# frozen_string_literal: true

# Runs the Ruby probe of the connection budget benchmark (SM-1566).
#
# The probe starts W workers on one pool. A task whose payload has +handlerMs+ returns after that
# time; any other task holds its slot until SIGTERM. Every handler returns at SIGTERM, so the stop
# time measures the SDK. +scripts/benchmark-connection-budget.ts+ starts it and reads the
# +WH_BENCH_*+ variables below. Nothing in CI runs it.

require "connection_pool"
require "json"
require "pg"
require "stablemates/workhorse"

def setting(name)
  value = ENV.fetch(name, "")
  abort "#{name} is required" if value.empty?
  value
end

def count(name)
  value = Integer(setting(name), exception: false)
  abort "#{name} must be a positive integer" unless value&.positive?
  value
end

# A positive integer from an optional variable, or nil when the variable is empty.
def optional_count(name)
  ENV.fetch(name, "").empty? ? nil : count(name)
end

OUTPUT = Mutex.new

def emit(event)
  OUTPUT.synchronize do
    $stdout.puts(JSON.generate(event))
    $stdout.flush
  end
end

url = setting("WH_BENCH_DATABASE_URL")
application_name = setting("WH_BENCH_APPLICATION_NAME")
task_type = setting("WH_BENCH_TASK_TYPE")
worker_count = count("WH_BENCH_WORKERS")
poll_ms = optional_count("WH_BENCH_POLL_MS")
shutdown_grace_ms = count("WH_BENCH_SHUTDOWN_GRACE_MS")
# connection_pool opens a connection only when the SDK asks for one, so the count shows its need.
pool = ConnectionPool.new(size: count("WH_BENCH_POOL_SIZE")) do
  PG.connect(url, application_name: application_name)
end
release = Concurrent::Event.new
signals = Thread::Queue.new
# A trap may only push to the queue: Worker#stop takes a mutex, which a trap context refuses.
Signal.trap("TERM") { signals << :term }

workers = Array.new(worker_count) do |index|
  Stablemates::Workhorse::Worker.new(
    pool,
    queues: [setting("WH_BENCH_QUEUE")],
    worker_id: "wh-bench-ruby-#{Process.pid}-#{index}",
    concurrency: count("WH_BENCH_CONCURRENCY"),
    heartbeat: count("WH_BENCH_HEARTBEAT_MS") / 1000.0,
    lease: count("WH_BENCH_LEASE_MS") / 1000.0,
    # nil keeps the default polling interval.
    poll_interval: poll_ms && poll_ms / 1000.0,
    shutdown_grace: shutdown_grace_ms / 1000.0
  ).handle(task_type) do |payload, context|
    handler_ms = payload.is_a?(Hash) ? payload["handlerMs"] : nil
    if handler_ms
      # The handler returns after its time, when the probe stops, or when the worker cancels the
      # attempt.
      deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + (handler_ms / 1000.0)
      until release.set? || context.cancellation.cancelled?
        remaining = deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC)
        break unless remaining.positive?

        release.wait([remaining, 0.05].min)
      end
    else
      # The handler holds its slot until the probe stops or the worker cancels the attempt.
      release.wait(0.05) until release.set? || context.cancellation.cancelled?
    end
    nil
  end
end
threads = workers.each_with_index.map do |worker, index|
  Thread.new do
    worker.run
  rescue => error
    emit(event: "worker_error", worker: index, error: error.full_message(highlight: false))
  end
end
emit(event: "started", sdk: "ruby", workers: worker_count, pollMs: poll_ms,
  shutdownGraceMs: shutdown_grace_ms, grace: "shutdown_grace")

# The pool state, seen from inside the process. +available+ counts the idle connections and the
# connections the pool has not opened yet, so the pool has opened size - available + idle.
# connection_pool counts no waiters, so "waiting" is null.
reporter = Thread.new do
  loop do
    checked_out = pool.size - pool.available
    emit(event: "pool", total: checked_out + pool.idle, idle: pool.idle,
      checkedOut: checked_out, waiting: nil, max: pool.size)
    sleep 0.25
  end
end

signals.pop
reporter.kill
reporter.join
# Stop claims first, then let the handlers return.
workers.each(&:stop)
release.set
threads.each(&:join)
pool.shutdown(&:close)
emit(event: "stopped")
