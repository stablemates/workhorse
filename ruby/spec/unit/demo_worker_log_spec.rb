# frozen_string_literal: true

require "json"
require "stringio"
require "tmpdir"
require_relative "../../examples/demo_worker"

# The demo log file of the Ruby worker, in the record format of the TypeScript demo exporter.
RSpec.describe "Ruby demo worker log file" do
  demo = WorkhorseDemoWorker

  it "needs a directory and a service name" do
    expect(demo.log_file({})).to be_nil
    expect(demo.log_file({"WORKHORSE_DEMO_LOG_DIRECTORY" => "/tmp/x"})).to be_nil
  end

  it "refuses an invalid size" do
    environment = {
      "WORKHORSE_DEMO_LOG_DIRECTORY" => "/tmp/x", "WORKHORSE_DEMO_SERVICE_NAME" => "w",
      "WORKHORSE_DEMO_LOG_MAX_BYTES" => "0"
    }
    expect { demo.log_file(environment) }.to raise_error(ArgumentError, /WORKHORSE_DEMO_LOG_MAX_BYTES/)
  end

  it "writes the SDK events with their names and attributes" do
    Dir.mktmpdir do |directory|
      log_file = demo.log_file(
        "WORKHORSE_DEMO_LOG_DIRECTORY" => directory,
        "WORKHORSE_DEMO_SERVICE_NAME" => "workhorse-demo-worker-ruby",
        "WORKHORSE_DEMO_ENV" => "test env"
      )
      console = StringIO.new
      logger = demo::DemoLogger.new(console, log_file)
      Stablemates::Workhorse::Telemetry.log(logger, :info, "workhorse.task.completed", "Task completed",
        {"workhorse.task.id" => "a", "workhorse.worker.queues" => %w[q1 q2]})
      Stablemates::Workhorse::Telemetry.log(logger, :debug, "workhorse.task.claimed", "Task claimed")

      lines = File.readlines(File.join(directory, "test_env", "workhorse-demo-worker-ruby.ndjson"))
      expect(lines.length).to eq(2)
      record = JSON.parse(lines[0])
      expect(record.keys).to eq(%w[timestamp observedTimestamp severityText severityNumber eventName body
        attributes resource scope])
      expect(record).to include(
        "severityText" => "INFO", "severityNumber" => 9, "eventName" => "workhorse.task.completed",
        "body" => "Task completed",
        "attributes" => {"workhorse.task.id" => "a", "workhorse.worker.queues" => %w[q1 q2]}
      )
      expect(record["timestamp"]).to end_with("Z")
      expect(record["resource"]).to include("service.name" => "workhorse-demo-worker-ruby",
        "deployment.environment.name" => "test env", "telemetry.sdk.language" => "ruby")
      expect(JSON.parse(lines[1])).to include("severityText" => "DEBUG", "eventName" => "workhorse.task.claimed",
        "body" => "Task claimed", "attributes" => {})
      expect(console.string).to include("workhorse.task.completed: Task completed")
      expect(console.string).not_to include("Task claimed")
    end
  end

  it "keeps a message that is not an SDK event as the body" do
    expect(demo::DemoLogger.parse("plain text {x}")).to eq(body: "plain text {x}")
    expect(demo::DemoLogger.parse("workhorse.a.b: body {not json")).to eq(event_name: "workhorse.a.b",
      body: "body {not json")
  end

  it "rotates before the limit" do
    Dir.mktmpdir do |directory|
      path = File.join(directory, "w.ndjson")
      log_file = demo::LogFile.new(path, max_bytes: 400, archives: 2, resource: {})
      12.times { |index| log_file.write(severity: Logger::INFO, body: "record #{index}", scope: "test") }

      expect(Dir.children(directory).sort).to eq(%w[w.ndjson w.ndjson.1 w.ndjson.2])
      Dir.children(directory).each { |name| expect(File.size(File.join(directory, name))).to be <= 400 }
      expect(JSON.parse(File.readlines(path).last)["body"]).to eq("record 11")
    end
  end
end

RSpec.describe "Ruby demo worker log values" do
  it "writes a non-finite number as null" do
    Dir.mktmpdir do |directory|
      path = File.join(directory, "w.ndjson")
      log_file = WorkhorseDemoWorker::LogFile.new(path, max_bytes: 10_000, archives: 1, resource: {})
      log_file.write(severity: Logger::INFO, body: "numbers", scope: "test",
        attributes: {"nan" => Float::NAN, "list" => [Float::INFINITY, 1.5]})

      expect(JSON.parse(File.read(path))["attributes"]).to eq("nan" => nil, "list" => [nil, 1.5])
    end
  end
end
