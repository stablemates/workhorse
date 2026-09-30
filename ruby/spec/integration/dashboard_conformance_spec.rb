# frozen_string_literal: true

require "json"
require "stringio"

# Replays the shared dashboard/v1 HTTP fixtures against the Rack host.
RSpec.describe "Dashboard against the dashboard/v1 conformance fixtures" do
  fixture = JSON.parse(File.read(File.expand_path("../../../dashboard/v1/conformance.json", __dir__)))
  harness = fixture.fetch("harness")
  host_name = harness.fetch("origin").delete_prefix("http://")
  uuid = /\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z/i
  timestamp = /\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})\z/

  before do
    reason = ScratchDatabase.skip_reason
    skip(reason) if reason
  end

  define_method(:resolve) do |value, references|
    case value
    when Array then value.map { |item| resolve(item, references) }
    when Hash
      next references.fetch(value["$ref"]) if value.keys == ["$ref"]

      value.transform_values { |item| resolve(item, references) }
    else value
    end
  end

  define_method(:read_pointer) do |value, pointer|
    pointer.split(".").reduce(value) { |current, segment| current.is_a?(Array) ? current[Integer(segment, 10)] : current.fetch(segment) }
  end

  define_method(:assert_value) do |expected, actual, references, location|
    case expected
    when Hash
      if expected.key?("$ref")
        expect(actual).to eq(references.fetch(expected["$ref"])), location
      elsif expected.key?("$type")
        kind = expected["$type"]
        accepted = case kind
        when "any" then true
        when "uuid" then actual.is_a?(String) && uuid.match?(actual)
        when "timestamp" then actual.is_a?(String) && timestamp.match?(actual) && !Time.iso8601(actual).nil?
        when "string" then actual.is_a?(String)
        when "integer" then actual.is_a?(Integer)
        when "number" then (actual.is_a?(Integer) || actual.is_a?(Float)) && actual.to_f.finite?
        when "boolean" then actual == true || actual == false
        end
        expect(accepted).to be(true), "#{location} expected #{kind}, received #{actual.inspect}"
      else
        expect(actual).to be_a(Hash), location
        expect(actual.keys).to match_array(expected.keys), location
        expected.each { |key, value| assert_value(value, actual[key], references, "#{location}.#{key}") }
      end
    when Array
      expect(actual).to be_a(Array), location
      expect(actual.length).to eq(expected.length), location
      expected.each_with_index { |value, index| assert_value(value, actual[index], references, "#{location}[#{index}]") }
    else
      expect(actual).to eq(expected), location
    end
  end

  # Runs one seed statement and returns its rows as JSON values.
  define_method(:execute_step) do |connection, step, references|
    parameters = step.fetch("parameters", []).map do |value|
      value = resolve(value, references)
      case value
      when Hash, Array then JSON.generate(value)
      when nil then nil
      else value.to_s
      end
    end
    rows = connection.exec_params("WITH step AS (#{step.fetch("sql")}) SELECT to_jsonb(step)::text AS row FROM step",
      parameters).map { |row| JSON.parse(row.fetch("row")) }
    assert_value(step.dig("expect", "rows") || [], rows, references, "seed/#{step.fetch("id")}")
    step.fetch("capture", {}).each { |name, pointer| references[name] = read_pointer(rows, pointer) }
  end

  define_method(:request) do |host, exchange, references|
    body = JSON.generate(resolve(exchange.fetch("request"), references))
    origin = exchange.fetch("origin", "same")
    env = {
      "REQUEST_METHOD" => exchange.fetch("method", "POST"),
      "SCRIPT_NAME" => "",
      "PATH_INFO" => "/workhorse/rpc/dashboard/#{exchange.fetch("procedure")}",
      "rack.url_scheme" => "http",
      "HTTP_HOST" => (exchange["host"] == "foreign") ? "attacker.conformance.test" : host_name,
      "CONTENT_LENGTH" => body.bytesize.to_s,
      "CONTENT_TYPE" => "application/json",
      "rack.input" => StringIO.new(body)
    }
    env["HTTP_ORIGIN"] = (origin == "same") ? harness.fetch("origin") : harness.fetch("crossOrigin") unless origin == "none"
    status, headers, chunks = host.call(env)
    expect(headers["content-type"]).to eq("application/json; charset=utf-8")
    [status, JSON.parse(chunks.join)]
  end

  define_method(:exchange!) do |host, exchange, references|
    status, body = request(host, exchange, references)
    expect(status).to eq(exchange.dig("expect", "status")), "#{exchange["id"]}: #{body}"
    assert_value(exchange.dig("expect", "body"), body, references, exchange.fetch("id"))
    exchange.fetch("capture", {}).each { |name, pointer| references[name] = read_pointer(body, pointer) }
  end

  it "answers every shared exchange and reports the policies behind a queue" do
    # The fixture counts rows database-wide, so the exchanges run on a database of their own.
    connection = PG.connect(ScratchDatabase.extra("dashboard_conformance"))
    connection.set_notice_processor { |_notice| nil }
    begin
      references = {}
      fixture.fetch("scenarios").first.fetch("seed").each { |step| execute_step(connection, step, references) }

      options = {
        authorize: ->(_env) { W::Dashboard::Principal.new(harness.fetch("authenticatedActor")) },
        path: harness.fetch("basePath"),
        environment: harness.fetch("environment"),
        configured_workers: harness.fetch("configuredWorkers"),
        maintenance_loops: harness.fetch("maintenanceLoops"),
        allowed_hosts: [host_name]
      }
      host = W::Dashboard.new(connection, **options,
        enqueue_test: lambda { |input, _actor|
          queue = W::Queue.new(connection, default_queue: "conformance-demo")
          {"taskId" => queue.enqueue("conformance.demo-#{input.fetch("kind")}", {},
            priority: input.fetch("priority", 0)).task_id}
        },
        set_schedule_paused: lambda { |input, actor|
          row = connection.exec_params("SELECT workhorse.set_schedule_paused_v1($1, $2, $3, $4, $5) AS paused",
            [input.fetch("namespace"), input.fetch("name"), input.fetch("paused").to_s, actor,
              "Dashboard operator request"]).first
          {"paused" => row.fetch("paused") == "t"}
        })
      read_only_host = W::Dashboard.new(connection, **options, read_only: true)

      fixture.fetch("scenarios").drop(1).each do |scenario|
        scenario.fetch("exchanges").each do |exchange|
          exchange!((exchange["mode"] == "read-only") ? read_only_host : host, exchange, references)
        end
      end

      connection.exec(<<~SQL)
        INSERT INTO workhorse.concurrency_policy(queue_name,namespace,max_active,max_active_per_key)
          VALUES ('conformance-demo','dashboard-test',7,2)
          ON CONFLICT(queue_name) DO UPDATE SET namespace=excluded.namespace,
            max_active=excluded.max_active,max_active_per_key=excluded.max_active_per_key;
        INSERT INTO workhorse.rate_limit_policy(queue_name,namespace,rate_limit,rate_interval_ms,rate_burst,
            per_key_limit,per_key_interval_ms,per_key_burst)
          VALUES ('conformance-demo','dashboard-test',10,1000,12,3,2000,4)
          ON CONFLICT(queue_name) DO UPDATE SET namespace=excluded.namespace,
            rate_limit=excluded.rate_limit,rate_interval_ms=excluded.rate_interval_ms,
            rate_burst=excluded.rate_burst,per_key_limit=excluded.per_key_limit,
            per_key_interval_ms=excluded.per_key_interval_ms,per_key_burst=excluded.per_key_burst;
        INSERT INTO workhorse.admission_shard(queue_name,shard,tokens,refilled_at)
          VALUES ('conformance-demo',0,0.5,clock_timestamp()+interval '1 hour')
          ON CONFLICT(queue_name,shard) DO UPDATE SET tokens=excluded.tokens,refilled_at=excluded.refilled_at;
      SQL
      task = connection.exec(<<~SQL).first
        SELECT task.id,runtime.current_attempt FROM workhorse.dashboard_task_v1 task
          JOIN workhorse.dashboard_task_runtime_v1 runtime ON runtime.task_id=task.id
         WHERE task.queue_name='conformance-demo' ORDER BY task.created_at LIMIT 1
      SQL
      expect(task).not_to be_nil
      connection.exec_params(<<~SQL, [task.fetch("id"), task.fetch("current_attempt")])
        INSERT INTO workhorse.task_event(task_id,attempt,event_type,details)
          VALUES ($1::uuid,$2::integer,'batch_dispatched',jsonb_build_object(
            'batch_id','dashboard-semantic-batch','members',jsonb_build_array(
              jsonb_build_object('task_id',$1::uuid,'attempt',$2::integer))))
      SQL

      # Outlast the queue health cache, so the next read sees the policies.
      sleep 3.1
      _, queues = request(host, {"procedure" => "queues", "request" => {"json" => nil}}, references)
      demo = queues.dig("json", "queues").find { |row| row["queue"] == "conformance-demo" }
      expect(demo.dig("concurrencyPolicy", "maxActive")).to eq(7)
      expect(demo.dig("concurrencyPolicy", "maxActivePerKey")).to eq(2)
      expect(demo.dig("rateLimitPolicy", "rate")).to eq({"limit" => 10, "intervalMs" => 1000, "burst" => 12})
      expect(demo.dig("rateLimitPolicy", "availableTokens")).to eq(0.5)

      _, detail = request(host, {"procedure" => "taskDetail", "request" => {"json" => {"id" => task.fetch("id")}}},
        references)
      expect(detail.dig("json", "concurrencyPolicy", "maxActive")).to eq(7)
      expect(detail.dig("json", "batchExecutions", 0, "id")).to eq("dashboard-semantic-batch")

      connection.exec(<<~SQL)
        WITH task AS (
          INSERT INTO workhorse.task(queue_name,task_type,payload,max_attempts)
          VALUES ('conformance-demo','conformance.retry-summary','{}',3) RETURNING id
        ) INSERT INTO workhorse.task_runtime(task_id,queue_name,state,current_attempt,run_at)
          SELECT id,'conformance-demo','scheduled',2,clock_timestamp()+interval '30 seconds' FROM task
      SQL
      status, system = request(host, {"procedure" => "system", "request" => {"json" => {"window" => "1h"}}},
        references)
      expect(status).to eq(200), system.inspect
      expect(system.dig("json", "retryStorm", "buckets", 0, "count")).to be >= 1
      expect(system.dig("json", "retryStorm", "topTypes", 0, "count")).to be >= 1
    ensure
      connection.close
      ScratchDatabase.drop_extra("dashboard_conformance")
    end
  end
end
