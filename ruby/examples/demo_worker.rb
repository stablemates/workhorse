# frozen_string_literal: true

# Serves the Ruby queues of the hosted dashboard demo at https://demo.workhorse.run, plus the queue
# every demo language shares, so the dashboard has live Ruby work to show.
#
# Documentation: https://workhorse.run/docs/dashboard
require "connection_pool"
require "fileutils"
require "json"
require "logger"
require "pg"
require "securerandom"
require "socket"
require "stablemates/workhorse"
require "time"

module WorkhorseDemoWorker
  LANGUAGE_TASK_TYPE = "demo.language-worker"
  SHARED_TASK_TYPE = "demo.shared-worker"
  RUBY_QUEUE = "demo-ruby"
  RUBY_FAST_QUEUE = "demo-ruby-fast"
  SHARED_QUEUE = "demo-shared"
  SCHEDULE_NAMESPACE = "workhorse-demo"
  FAST_TIER_SCHEDULE_NAMESPACE = "workhorse-demo-fast-tier"
  WORKER_CONCURRENCY = 6
  DEFAULT_POLL_MS = 15_000
  SCHEMA_RETRY_SECONDS = 0.5
  DEFAULT_LOG_MAX_BYTES = 10 * 1_024 * 1_024
  DEFAULT_LOG_ARCHIVES = 5
  # The OpenTelemetry severity text and number of each Logger level.
  SEVERITIES = {
    Logger::DEBUG => ["DEBUG", 5], Logger::INFO => ["INFO", 9], Logger::WARN => ["WARN", 13],
    Logger::ERROR => ["ERROR", 17], Logger::FATAL => ["FATAL", 21], Logger::UNKNOWN => ["FATAL", 21]
  }.freeze

  # Writes demo log records as NDJSON, in the format of +typescript/demo/file-log-exporter.cjs+.
  #
  # The file rotates before a record would take it past +max_bytes+, and keeps +archives+ numbered
  # archives. A write that fails reports once to standard error and never reaches the worker.
  class LogFile
    attr_reader :path

    def initialize(path, max_bytes:, archives:, resource:)
      @path = path
      @max_bytes = max_bytes
      @archives = archives
      @resource = resource
      @lock = Mutex.new
      @failed = false
    end

    def write(severity:, body:, scope:, event_name: nil, attributes: {}, time: Time.now)
      text, number = SEVERITIES.fetch(severity, SEVERITIES[Logger::INFO])
      record = {
        "timestamp" => LogFile.timestamp(time), "observedTimestamp" => LogFile.timestamp(Time.now),
        "severityText" => text, "severityNumber" => number
      }
      record["eventName"] = event_name unless event_name.nil?
      record.merge!("body" => body, "attributes" => attributes, "resource" => @resource, "scope" => {"name" => scope})
      line = "#{JSON.generate(LogFile.finite(record))}\n"
      @lock.synchronize { append(line) }
    rescue => e
      unless @failed
        @failed = true
        Kernel.warn("Could not write the demo log file #{@path}: #{e.message}")
      end
    end

    def self.timestamp(time) = time.utc.iso8601(3).sub("+00:00", "Z")

    # +value+ with each NaN or infinite number replaced by nil, as +JSON.stringify+ writes it.
    def self.finite(value)
      case value
      when Float then value.finite? ? value : nil
      when Hash then value.transform_values { |member| finite(member) }
      when Array then value.map { |member| finite(member) }
      else value
      end
    end

    private

    def append(line)
      FileUtils.mkdir_p(File.dirname(@path))
      size = File.exist?(@path) ? File.size(@path) : 0
      rotate if size.positive? && size + line.bytesize > @max_bytes
      File.open(@path, "ab") { |file| file.write(line) }
    end

    def rotate
      FileUtils.rm_f("#{@path}.#{@archives}")
      (@archives - 1).downto(1) do |index|
        File.rename("#{@path}.#{index}", "#{@path}.#{index + 1}") if File.exist?("#{@path}.#{index}")
      end
      File.rename(@path, "#{@path}.1")
    end
  end

  # The Logger that the demo gives the SDK. It prints info and above, and writes every level to the
  # log file. The SDK logs one event as +"<event name>: <body> <attributes JSON>"+, so the file record
  # gets the event name and the attributes back from that text.
  class DemoLogger < Logger
    EVENT_PATTERN = /\A(workhorse\.[a-z0-9_.]+): (.*)\z/m

    def initialize(io, log_file)
      super(io, level: Logger::INFO, progname: "workhorse-demo-worker-ruby")
      @log_file = log_file
    end

    def add(severity, message = nil, progname = nil, &block)
      severity ||= Logger::UNKNOWN
      if message.nil?
        if block
          message = block.call
        else
          message = progname
          progname = nil
        end
      end
      @log_file&.write(severity: severity, scope: progname || self.progname, **DemoLogger.parse(message.to_s))
      super(severity, message, progname)
    end

    def self.parse(message)
      match = EVENT_PATTERN.match(message)
      return {body: message} if match.nil?

      text = match[2]
      split = text.index(' {"') || (text.start_with?("{") ? -1 : nil)
      if split
        begin
          attributes = JSON.parse(text[(split + 1)..])
          return {event_name: match[1], body: text[0, [split, 0].max], attributes: attributes} if attributes.is_a?(Hash)
        rescue JSON::ParserError
          nil
        end
      end
      {event_name: match[1], body: text}
    end
  end

  module_function

  def safe_path_segment(value) = value.gsub(/[^a-zA-Z0-9._-]/, "_")[0, 100].then { |safe| safe.empty? ? "unknown" : safe }

  def positive_integer(environment, name, fallback)
    value = environment[name]
    return fallback if value.nil?

    parsed = Integer(value, 10, exception: false)
    raise ArgumentError, "#{name} must be a positive integer" unless parsed.is_a?(Integer) && parsed >= 1

    parsed
  end

  # The log file of this worker, or nil when the launcher names no log directory or no service name.
  def log_file(environment = ENV)
    directory = environment["WORKHORSE_DEMO_LOG_DIRECTORY"]
    service = environment["WORKHORSE_DEMO_SERVICE_NAME"]
    return nil if directory.nil? || directory.empty? || service.nil? || service.empty?

    deployment = environment["WORKHORSE_DEMO_ENV"]
    deployment = "development" if deployment.nil? || deployment.empty?
    LogFile.new(
      File.join(File.expand_path(directory), safe_path_segment(deployment), "#{safe_path_segment(service)}.ndjson"),
      max_bytes: positive_integer(environment, "WORKHORSE_DEMO_LOG_MAX_BYTES", DEFAULT_LOG_MAX_BYTES),
      archives: positive_integer(environment, "WORKHORSE_DEMO_LOG_ARCHIVES", DEFAULT_LOG_ARCHIVES),
      resource: {
        "service.name" => service, "deployment.environment.name" => deployment,
        "deployment.environment" => deployment, "host.name" => Socket.gethostname,
        "process.pid" => Process.pid, "telemetry.sdk.language" => "ruby"
      }
    )
  end

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
  def build_worker(pool, poll_interval:, worker_id: self.worker_id, logger: nil)
    Stablemates::Workhorse::Worker.new(pool,
      logger: logger,
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
    $stdout.sync = true
    logger = DemoLogger.new($stdout, log_file)
    poll = poll_interval
    waits = waits_for_schema?
    pool = connection_pool(database_url)
    wait_for_schema(pool) if waits
    Stablemates::Workhorse.run_worker_process(build_worker(pool, poll_interval: poll, logger: logger))
  end
end

WorkhorseDemoWorker.main if $PROGRAM_NAME == __FILE__
