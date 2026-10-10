# frozen_string_literal: true

# Serves the Ruby queues of the hosted dashboard demo at https://demo.workhorse.run, plus the queue
# every demo language shares, so the dashboard has live Ruby work to show.
#
# Documentation: https://workhorse.run/docs/dashboard
require "connection_pool"
require "pg"
require "securerandom"
require "socket"
require "stablemates/workhorse"

module WorkhorseDemoWorker
  LANGUAGE_TASK_TYPE = "demo.language-worker"
  SHARED_TASK_TYPE = "demo.shared-worker"
  RUBY_QUEUE = "demo-ruby"
  RUBY_FAST_QUEUE = "demo-ruby-fast"
  SHARED_QUEUE = "demo-shared"
  SCHEDULE_NAMESPACE = "workhorse-demo"
  FAST_TIER_SCHEDULE_NAMESPACE = "workhorse-demo-fast-tier"
  WORKER_CONCURRENCY = 3
  DEFAULT_POLL_MS = 15_000
  SCHEMA_RETRY_SECONDS = 0.5

  module_function

  def database_url(environment = ENV)
    value = environment["DATABASE_URL_PRIMARY"]
    raise ArgumentError, "DATABASE_URL_PRIMARY is required" if value.nil? || value.empty?

    value
  end

  # Reads +WORKHORSE_WORKER_POLL_MS+ in seconds; zero leaves the SDK default in place.
  def poll_interval(environment = ENV)
    value = environment["WORKHORSE_WORKER_POLL_MS"]
    milliseconds = (value.nil? || value.empty?) ? DEFAULT_POLL_MS : Integer(value, 10, exception: false)
    unless milliseconds.is_a?(Integer) && milliseconds >= 0
      raise ArgumentError, "WORKHORSE_WORKER_POLL_MS must be a non-negative integer"
    end

    milliseconds.zero? ? nil : milliseconds / 1000.0
  end

  # Only the development demo waits for a missing schema; production refuses at once.
  def waits_for_schema?(environment = ENV)
    mode = environment["WORKHORSE_DEMO_MODE"]
    mode = "production" if mode.nil? || mode.empty?
    unless %w[development production].include?(mode)
      raise ArgumentError, "WORKHORSE_DEMO_MODE must be either development or production"
    end

    mode == "development"
  end

  # Waits while the demo server has not installed the schema yet.
  #
  # In development the server installs the schema on first start, so a worker that starts beside it
  # can see an empty database. Every other compatibility refusal fails at once. A Queue caches its
  # refusal, so each check builds a new one.
  def wait_for_schema(pool, retry_seconds: SCHEMA_RETRY_SECONDS)
    logged = false
    loop do
      Stablemates::Workhorse::Queue.new(pool).assert_compatible
      return
    rescue Stablemates::Workhorse::CompatibilityError => e
      raise unless e.code == :schema_not_installed

      unless logged
        $stdout.puts("Waiting for the demo server to install the Workhorse schema")
        $stdout.flush
        logged = true
      end
      sleep(retry_seconds)
    end
  end

  def language_task(payload, context)
    unless payload.is_a?(Hash) && payload["language"] == "ruby"
      raise ArgumentError, "Ruby worker received a task for another language"
    end

    {"language" => "ruby", "runtime" => "ruby", "attempt" => context.task.attempt}
  end

  def shared_task(payload, context)
    unless payload.is_a?(Hash) && payload["source"].is_a?(String)
      raise ArgumentError, "Shared worker requires a source"
    end

    {"source" => payload["source"], "runtime" => "ruby", "attempt" => context.task.attempt}
  end

  def worker_id
    hostname = Socket.gethostname.gsub(/[^A-Za-z0-9._-]/, "-")
    hostname = "unknown-host" if hostname.empty?
    "demo-ruby-#{hostname}-#{Process.pid}-#{SecureRandom.hex(4)}"
  end

  # Each handler slot, the heartbeat, the notification listener, and the dispatch loop hold a
  # connection at once.
  def connection_pool(url)
    ConnectionPool.new(size: WORKER_CONCURRENCY + 4, timeout: 5) { PG.connect(url) }
  end

  # Builds the worker that serves the Ruby queue, the fast-tier Ruby queue, and the shared queue.
  def build_worker(pool, poll_interval:, worker_id: self.worker_id)
    Stablemates::Workhorse::Worker.new(pool,
      queues: [RUBY_QUEUE, SHARED_QUEUE, RUBY_FAST_QUEUE],
      worker_id: worker_id,
      concurrency: WORKER_CONCURRENCY,
      poll_interval: poll_interval,
      schedule_namespaces: [SCHEDULE_NAMESPACE, FAST_TIER_SCHEDULE_NAMESPACE],
      maintenance_interval: 1,
      registry_interval: 0.25,
      shutdown_grace: 25)
      .handle(LANGUAGE_TASK_TYPE) { |payload, context| language_task(payload, context) }
      .handle(SHARED_TASK_TYPE) { |payload, context| shared_task(payload, context) }
  end

  def main
    poll = poll_interval
    waits = waits_for_schema?
    pool = connection_pool(database_url)
    wait_for_schema(pool) if waits
    Stablemates::Workhorse.run_worker_process(build_worker(pool, poll_interval: poll))
  end
end

WorkhorseDemoWorker.main if $PROGRAM_NAME == __FILE__
