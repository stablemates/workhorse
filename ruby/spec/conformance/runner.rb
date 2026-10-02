# frozen_string_literal: true

require "json"
require "pg"
require "time"
require_relative "database"
require_relative "ledger"
require_relative "matcher"
require_relative "runtime"

module Conformance
  PROTOCOL = File.expand_path("../../../protocol/v1", __dir__)
  # Files in `protocol/v1` that describe fixtures rather than declare them.
  METADATA = %w[manifest.json cron.md governed-surface.json].freeze
  # Fixture files, keyed by the category name the list uses.
  CATEGORIES = %w[
    compatibility contracts cron-occurrences failures interpreter requests runtime scenarios schedules
  ].freeze
  # The categories only the worker runtime can execute.
  RUNTIME_CATEGORIES = %w[failures runtime].freeze
  DATABASE_CATEGORIES = %w[scenarios cron-occurrences requests schedules compatibility].freeze

  # Every fixture each category file declares, in file order.
  class Catalogue
    attr_reader :manifest

    def self.load(directory = PROTOCOL)
      unknown = Dir.children(directory).reject do |name|
        METADATA.include?(name) || CATEGORIES.include?(name.delete_suffix(".json")) && name.end_with?(".json")
      end
      unless unknown.empty?
        raise Failure, "protocol/v1 holds files the Ruby runner does not classify: #{unknown.sort.join(", ")}; " \
          "execute them or name them as metadata"
      end

      fixtures = CATEGORIES.to_h do |category|
        document = JSON.parse(File.read(File.join(directory, "#{category}.json")))
        # `failures.json` wraps its fixtures beside the envelope they share.
        list = (category == "failures") ? document["fixtures"] : document
        raise Failure, "#{category}.json declares no fixture array" unless list.is_a?(Array)

        [category, list]
      end
      new(fixtures, JSON.parse(File.read(File.join(directory, "manifest.json"))))
    end

    def initialize(fixtures, manifest)
      @fixtures = fixtures
      @manifest = manifest
    end

    def category(name) = @fixtures.fetch(name)

    def declared
      @fixtures.flat_map { |category, list| list.map { |fixture| Conformance.key(category, fixture) } }.to_set
    end
  end

  def self.key(category, fixture)
    id = fixture["id"]
    raise Failure, "every fixture has a string id" unless id.is_a?(String)

    "#{category}/#{id}"
  end

  # Execute every protocol/v1 fixture through the Ruby client and reconcile the outcomes with the
  # expected-unsupported list.
  class Runner
    attr_reader :outcomes

    def initialize(catalogue, entries)
      @catalogue = catalogue
      @entries = entries
      @outcomes = {}
    end

    # The disagreements between the fixtures and the list. An empty result is a clean run.
    def run
      each_fixture("interpreter") { |fixture| Runner.run_interpreter(fixture) }
      each_fixture("contracts") { |fixture| Runner.run_contract(fixture) }

      problems = []
      scenarios = ScratchDatabase.extra("protocol_conformance_scenarios")
      if scenarios
        begin
          problems.concat(with_connection(scenarios) { |connection| run_scenarios(connection) })
        ensure
          ScratchDatabase.drop_extra("protocol_conformance_scenarios")
        end
        adapters = ScratchDatabase.extra("protocol_conformance_adapters")
        begin
          run_adapters(adapters)
        ensure
          ScratchDatabase.drop_extra("protocol_conformance_adapters")
        end
        runtime = ScratchDatabase.extra("protocol_conformance_runtime")
        begin
          run_runtime(runtime)
        ensure
          ScratchDatabase.drop_extra("protocol_conformance_runtime")
        end
      else
        (DATABASE_CATEGORIES + RUNTIME_CATEGORIES).each do |category|
          @catalogue.category(category).each do |fixture|
            record(category, fixture, Outcome.skipped("DATABASE_URL_TEST is unset"))
          end
        end
      end
      problems.concat(Ledger.reconcile(@catalogue.declared, @outcomes, @entries))
    end

    # The per-status counts and every fixture that did not pass, for standard error.
    def report
      counts = @outcomes.values.map(&:status).tally.sort.to_h
      lines = ["Ruby protocol conformance: #{counts}"]
      @outcomes.sort.each do |fixture, outcome|
        next if outcome.status == :passed

        lines << "  #{outcome.status.to_s.ljust(11)} #{fixture}: #{outcome.reason}"
      end
      lines.join("\n")
    end

    # ----- contracts ---------------------------------------------------------------------------

    # A contract fixture compiles its schema the way `Queue#sync_contracts` does, then checks each
    # instance's verdict.
    def self.run_contract(fixture)
      schema = begin
        Stablemates::Workhorse::ContractSchema.new(fixture["schema"])
      rescue ArgumentError, Stablemates::Workhorse::Error => e
        return if fixture["schemaError"] == true

        raise Failure, "rejected a valid schema: #{e.message}"
      end
      raise Failure, "compiled a schema the protocol rejects" if fixture["schemaError"] == true

      instances = fixture["instances"]
      raise Failure, "fixture lists no instances" unless instances.is_a?(Array)

      instances.each_with_index do |instance, index|
        expected = instance["valid"]
        raise Failure, "instance states no verdict" unless [true, false].include?(expected)
        raise Failure, "instance #{index}: expected valid = #{expected}" unless schema.valid?(instance["value"]) == expected
      end
    end

    # ----- interpreter -------------------------------------------------------------------------

    def self.run_interpreter(fixture)
      id = fixture["id"].to_s
      references = {}
      steps = fixture["steps"]
      raise Failure, "interpreter fixture has no steps" unless steps.is_a?(Array)

      steps.each do |step|
        location = "#{id}/#{step["id"]}"
        actual = materialize(step["actual"])
        if step["rejects"] == true
          accepted = begin
            Matcher.assert_value(step["expect"], actual, references, location)
            true
          rescue Failure
            false
          end
          raise Failure, "#{location} accepted a value the fixture rejects" if accepted
        else
          Matcher.assert_value(step["expect"], actual, references, location)
        end
        capture(step, actual, references)
      end
      errors = fixture["errors"]
      raise Failure, "interpreter fixture has no errors" unless errors.is_a?(Array)

      errors.each do |error|
        assert_error_value(error["expect"], error["actual"], references, "#{id}/#{error["id"]}")
      end
    end

    # Turn `{"$native" => kind, "value" => text}` into the value a driver would produce, then
    # normalize it the way the scenario decoder does.
    def self.materialize(value)
      case value
      when Array then value.map { |item| materialize(item) }
      when Hash
        return value.transform_values { |item| materialize(item) } unless value.keys.sort == %w[$native value]

        native(value["$native"], value["value"])
      else value
      end
    end

    # The non-finite floats as PostgreSQL spells them. Ruby's Float() does not parse them, and they
    # have no JSON form, so they materialize as nil.
    NON_FINITE = {"NaN" => true, "Infinity" => true, "-Infinity" => true}.freeze

    def self.native(kind, raw)
      return raw if kind == "json"

      text = raw.is_a?(String) ? raw : nil
      known = %w[integer number timestamp uuid].include?(kind)
      raise Failure, "unknown interpreter native value #{Matcher.render(kind)}" unless known
      raise Failure, "native value #{Matcher.render(raw)} is not text" unless text

      case kind
      # PostgreSQL numeric: integral values become integers, as the decoder does.
      when "integer" then Integer(text, 10, exception: false) || Float(text)
      # A non-finite float has no JSON form, so the number matcher rejects it.
      when "number" then NON_FINITE.key?(text) ? nil : Float(text)
      when "timestamp"
        raise Failure, "#{text} is not an RFC 3339 timestamp" unless Matcher.timestamp?(text)

        Matcher.normalize_timestamp(Time.iso8601(text))
      when "uuid"
        compact = text.delete("-")
        raise Failure, "#{text} is not a UUID" unless compact.match?(/\A\h{32}\z/)

        compact.downcase.unpack("a8a4a4a4a12").join("-")
      end
    rescue ArgumentError => e
      raise Failure, e.message
    end

    def self.capture(step, actual, references)
      captures = step["capture"]
      return unless captures.is_a?(Hash)

      captures.each do |name, pointer|
        raise Failure, "capture #{name} has no pointer" unless pointer.is_a?(String)

        references[name] = Matcher.read_pointer(actual, pointer)
      end
    end

    def self.assert_error_value(expected, actual, references, location)
      %w[code message].each do |field|
        next if actual[field] == expected[field]

        raise Failure, "#{location} expected error #{field} #{Matcher.render(expected[field])}, " \
          "received #{Matcher.render(actual[field])}"
      end
      return unless expected.key?("detail")
      raise Failure, "#{location} expected error detail, received none" unless actual.key?("detail")

      Matcher.assert_value(expected["detail"], actual["detail"], references, "#{location}.detail")
    end

    # ----- scenarios ---------------------------------------------------------------------------

    # Run every SQL scenario and return coverage problems. A scenario that fails stops at its first
    # failing step; the next scenario still runs.
    def run_scenarios(connection)
      listed = @entries.map { |entry| entry["fixture"] }.to_set
      coverage = Set.new
      @catalogue.category("scenarios").each do |scenario|
        outcome = attempt { run_scenario(connection, scenario) }
        # A listed scenario keeps the capabilities it declares, so its gap is reported once, by the list.
        if outcome.status == :passed || listed.include?(Conformance.key("scenarios", scenario))
          coverage.merge(Runner.covers(scenario))
        end
        record("scenarios", scenario, outcome)
      end
      problem = Runner.manifest_coverage(@catalogue.manifest, coverage)
      problem ? [problem] : []
    end

    def self.covers(scenario)
      Array(scenario["steps"]).flat_map { |step| Array(step["covers"]) }.grep(String)
    end

    # The coverage problem, or nil when the scenarios cover every capability the manifest names.
    def self.manifest_coverage(manifest, coverage)
      runtime = Array(manifest["runtimeCoverage"]).grep(String).to_set
      missing = Array(manifest["coverage"]).grep(String).reject do |capability|
        runtime.include?(capability) || coverage.include?(capability)
      end
      return nil if missing.empty?

      "SQL protocol fixtures lack coverage: #{missing.join(", ")}"
    end

    def run_scenario(connection, scenario)
      references = {}
      steps = scenario["steps"]
      raise Failure, "scenario has no steps" unless steps.is_a?(Array)

      steps.each { |step| run_step(connection, step, references, "#{scenario["id"]}/#{step["id"]}") }
    end

    def run_step(connection, step, references, location)
      sql = step["sql"]
      raise Failure, "#{location} has no SQL" unless sql.is_a?(String)

      values = step.key?("parameters") ? Matcher.resolve(step["parameters"], references) : []
      raise Failure, "#{location} parameters are not a list: #{Matcher.render(values)}" unless values.is_a?(Array)

      result, error = execute(connection, sql, values, location)
      expected_error = step["error"]
      if error && expected_error
        actual = located(location) { Database.database_error(error) }
        Runner.assert_error_value(expected_error, actual, references, location)
      elsif expected_error
        raise Failure, "#{location} expected error #{Matcher.render(expected_error)}, received #{result.ntuples} rows"
      elsif error
        raise Failure, "#{location} failed: #{Database.describe(error)}"
      else
        actual = located(location) { Database.rows(result) }
        expected = step.dig("expect", "rows") || []
        Matcher.assert_value(expected, actual, references, location)
        Runner.capture(step, actual, references)
      end
    ensure
      result&.clear
    end

    # [result, nil] or [nil, PG::Error]. Preparing is part of the statement: a fixture may expect
    # PostgreSQL to reject it.
    def execute(connection, sql, values, location)
      connection.prepare("", sql)
      description = connection.describe_prepared("")
      bound = located(location) { Database.parameters(description, values) }
      [connection.exec_prepared("", bound), nil]
    rescue PG::Error => e
      [nil, e]
    end

    # ----- adapters ----------------------------------------------------------------------------

    # The failures and runtime fixtures run a real worker, so they share one scratch database.
    def run_runtime(url)
      with_connection(url) do |setup|
        runtime = Runtime.new(url, setup)
        each_fixture("failures") { |fixture| runtime.failure(fixture) }
        @catalogue.category("runtime").each do |fixture|
          gap = Runtime::GAPS[fixture["kind"]]
          record("runtime", fixture, gap ? Outcome.unsupported(gap) : attempt { runtime.run(fixture) })
        end
      end
    end

    def run_adapters(url)
      with_connection(url) do |setup|
        run_cron(setup)
        run_requests(url, setup)
        run_schedules(url, setup)
        # Compatibility rewrites the version tables, so it runs after every other adapter.
        run_compatibility(url, setup)
      end
    end

    CRON = "SELECT occurrence_at FROM workhorse.cron_occurrences_v1($1::text, $2::timestamptz, " \
      "$3::timestamptz, $4::integer, $5::text) occurrence_at"

    def run_cron(connection)
      each_fixture("cron-occurrences") do |fixture|
        limit = fixture["limit"]
        raise Failure, "limit is not an integer" unless limit.is_a?(Integer)

        # A new definition has no previous occurrence, which the fixture writes as null.
        parameters = [fixture["expression"], fixture["lastOccurrenceAt"], fixture["now"], limit.to_s, fixture["timezone"]]
        rows = begin
          connection.exec_params(CRON, parameters).column_values(0)
        rescue PG::Error => e
          raise Failure, Database.describe(e)
        end
        actual = rows.map { |text| Runner.microseconds(Database::TIMESTAMPTZ_DECODER.decode(text)) }
        expected_list = fixture["expected"]
        raise Failure, "expected is not a list" unless expected_list.is_a?(Array)

        expected = expected_list.map { |instant| Runner.microseconds(Time.iso8601(instant.to_s)) }
        next if actual == expected

        raise Failure, "expected occurrences #{expected}, received #{actual} (microseconds since the epoch)"
      end
    end

    def self.microseconds(time) = (time.to_r * 1_000_000).floor

    # Route calls to one SQL function through a wrapper that records its arguments first.
    #
    # The Ruby client runs its statements on the caller's connection, so the runner interposes in
    # the database as the Rust lane does: the real function keeps running, and the runner reads the
    # recorded arguments back.
    def self.record_calls(connection, function)
      overloads = sql(connection) do
        connection.exec_params(<<~SQL, [function]).to_a
          SELECT p.oid::regprocedure::text AS signature, pg_get_function_arguments(p.oid) AS arguments,
                 pg_get_function_result(p.oid) AS result, p.proretset AS returns_set, p.pronargs::integer AS arity
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'workhorse' AND p.proname = $1
        SQL
      end
      raise Failure, "workhorse.#{function} does not exist" if overloads.empty?

      sql(connection) do
        connection.exec("CREATE TABLE IF NOT EXISTS public.conformance_calls (sequence bigserial PRIMARY KEY, " \
          "function_name text NOT NULL, arguments jsonb NOT NULL)")
      end
      overloads.each_with_index do |overload, index|
        signature = overload["signature"]
        inner = "#{function}__recorded_#{index}"
        placeholders = (1..Integer(overload["arity"], 10)).map { |position| "$#{position}" }.join(", ")
        call = (overload["returns_set"] == "t") ? "SELECT * FROM workhorse.#{inner}(#{placeholders})" :
          "SELECT workhorse.#{inner}(#{placeholders})"
        begin
          connection.exec(<<~SQL)
            ALTER FUNCTION #{signature} RENAME TO #{inner};
            CREATE FUNCTION workhorse.#{function}(#{overload["arguments"]}) RETURNS #{overload["result"]} LANGUAGE sql AS $recorded$
              INSERT INTO public.conformance_calls (function_name, arguments)
              VALUES ('#{function}', jsonb_build_array(#{placeholders}));
              #{call};
            $recorded$;
          SQL
        rescue PG::Error => e
          raise Failure, "interpose #{signature}: #{Database.describe(e)}"
        end
      end
      nil
    end

    # The arguments of every recorded call to +function+ since the last read, which it forgets.
    def self.recorded(connection, function)
      rows = sql(connection) do
        connection.exec_params("DELETE FROM public.conformance_calls WHERE function_name = $1 " \
          "RETURNING sequence, arguments", [function]).to_a
      end
      rows.sort_by { |row| Integer(row["sequence"], 10) }.map { |row| JSON.parse(row["arguments"]) }
    end

    def self.sql(connection)
      yield
    rescue PG::Error => e
      raise Failure, Database.describe(e)
    end

    # Translate a fixture's application options into `Queue#enqueue` keywords, refusing any option
    # the adapter does not know, so a new fixture option cannot pass by being ignored.
    def self.enqueue_options(options)
      options.to_h do |name, value|
        case name
        when "queue" then [:queue, value]
        when "priority" then [:priority, value]
        when "concurrencyKey" then [:concurrency_key, value]
        when "budget" then [:budget, value]
        when "maxAttempts" then [:max_attempts, value]
        when "retryPolicy" then [:retry_policy, retry_policy(value)]
        when "executionTimeoutMs" then [:execution_timeout, value / 1000.0]
        when "tags" then [:tags, value]
        when "idempotency"
          fields = {key: value["key"]}
          fields[:scope] = value["scope"] if value.key?("scope")
          fields[:ttl] = value["ttlMs"] / 1000.0 unless value["ttlMs"].nil?
          [:idempotency, Stablemates::Workhorse::Idempotency.new(**fields)]
        else raise Failure, "the adapter does not translate option #{name}"
        end
      end
    end

    def self.retry_policy(value)
      raise Failure, "retryPolicy is neither null nor an object" unless value.nil? || value.is_a?(Hash)

      value
    end

    # A request fixture records the JSON request every client sends to `enqueue_many_v1`, so
    # `Queue#enqueue` passes only when it sends that call with that request.
    def run_requests(url, setup)
      interposed = attempt { Runner.record_calls(setup, "enqueue_many_v1") }
      each_fixture("requests") do |fixture|
        raise Failure, interposed.reason unless interposed.status == :passed

        application = fixture["application"]
        options = Runner.enqueue_options(application["options"] || {})
        with_connection(url) do |connection|
          client_call { Stablemates::Workhorse::Queue.new(connection).enqueue(application["type"], application["payload"], **options) }
        end
        calls = Runner.recorded(setup, "enqueue_many_v1")
        raise Failure, "expected one enqueue_many_v1 call, recorded #{calls.length}" unless calls.length == 1

        Matcher.assert_value([fixture["postgres"]], calls.first[0], {}, "enqueue_many_v1.p_requests")
      ensure
        # A failed attempt may have recorded a call; the next fixture must start clean.
        attempt { Runner.recorded(setup, "enqueue_many_v1") }
      end
    end

    CATCHUP_POLICIES = {"skip" => :skip, "latest" => :latest, "all" => :all}.freeze

    def self.schedule_definition(definition)
      task = definition["task"]
      scheduled = Stablemates::Workhorse::ScheduledTask.new(
        task_type: task["type"], payload: task["payload"], queue: task["queue"], priority: task["priority"],
        concurrency_key: task["concurrencyKey"], max_attempts: task["maxAttempts"],
        retry_policy: retry_policy(task["retryPolicy"])
      )
      catchup = CATCHUP_POLICIES.fetch(definition["catchupPolicy"]) do |policy|
        raise Failure, "unknown catchup policy #{Matcher.render(policy)}"
      end
      Stablemates::Workhorse::ScheduleDefinition.new(
        name: definition["name"], schedule: definition["schedule"], task: scheduled,
        timezone: definition["timezone"], catchup_policy: catchup, enabled: definition["enabled"]
      )
    end

    # The contracts a schedule fixture syncs before its schedules. An omitted limit uses the
    # protocol default.
    def self.task_contracts(contracts)
      contracts.to_h do |task_type, contract|
        versions = contract["versions"].transform_values do |version|
          Stablemates::Workhorse::TaskContractVersion.new(
            payload_schema: version["payloadSchema"], result_schema: version["resultSchema"],
            max_payload_bytes: version["maxPayloadBytes"], max_result_bytes: version["maxResultBytes"],
            sensitive_payload_keys: version.fetch("sensitivePayloadKeys", []),
            sensitive_result_keys: version.fetch("sensitiveResultKeys", [])
          )
        end
        [task_type, Stablemates::Workhorse::TaskTypeContracts.new(current_version: contract["currentVersion"],
          versions: versions)]
      end
    end

    def run_schedules(url, setup)
      interposed = attempt { Runner.record_calls(setup, "sync_schedule_definitions_v2") }
      each_fixture("schedules") do |fixture|
        raise Failure, interposed.reason unless interposed.status == :passed

        namespace = fixture["namespace"]
        prune = fixture["prune"]
        raise Failure, "fixture sets no prune flag" unless [true, false].include?(prune)

        definitions = Array(fixture["application"]).map { |definition| Runner.schedule_definition(definition) }
        with_connection(url) do |connection|
          queue = Stablemates::Workhorse::Queue.new(connection, default_queue: fixture["defaultQueue"])
          contracts = fixture["contracts"]
          queue.sync_contracts(Runner.task_contracts(contracts)) if contracts
          client_call { queue.sync_schedules(namespace, definitions, prune: prune) }
        end
        calls = Runner.recorded(setup, "sync_schedule_definitions_v2")
        unless calls.length == 1
          raise Failure, "expected one sync_schedule_definitions_v2 call, recorded #{calls.length}"
        end

        Matcher.assert_value([namespace, fixture["postgres"], prune], calls.first, {}, "sync_schedule_definitions_v2")
      ensure
        attempt { Runner.recorded(setup, "sync_schedule_definitions_v2") }
      end
    end

    # ----- compatibility -----------------------------------------------------------------------

    # Install the versions a compatibility fixture describes, read them back the way the client
    # does, and compare the verdict and refusal code. A fixture that presents this client's
    # protocol runs through `Queue#assert_compatible`; another protocol runs the same decision
    # directly.
    def run_compatibility(url, setup)
      each_fixture("compatibility") do |fixture|
        installed = fixture["installedSchemaVersion"]
        client_protocol = fixture["clientProtocolVersion"]
        served = fixture["servedProtocolVersions"]
        raise Failure, "fixture lists no served protocols" unless served.is_a?(Array)

        Runner.install_versions(setup, installed, served)
        code = begin
          with_connection(url) { |connection| Runner.refusal(connection, client_protocol) }
        ensure
          Runner.sql(setup) { setup.exec("ALTER SCHEMA workhorse_hidden RENAME TO workhorse") } if installed.nil?
        end
        Runner.compare_refusal(fixture, code)
      end
    end

    # The refusal code as the fixture spells it, or nil when the client may proceed.
    def self.refusal(connection, client_protocol)
      if client_protocol == Stablemates::Workhorse::SqlCatalogue::CLIENT_PROTOCOL_VERSION
        begin
          Stablemates::Workhorse::Queue.new(connection).assert_compatible
          return nil
        rescue Stablemates::Workhorse::CompatibilityError => e
          return e.code.to_s.tr("_", "-")
        end
      end
      compatibility = Stablemates::Workhorse::Compatibility
      installed, served = client_call { compatibility.read_state(Stablemates::Workhorse::Executor.for(connection)) }
      compatibility.check(installed, client_protocol, served)&.to_s&.tr("_", "-")
    end

    def self.compare_refusal(fixture, code)
      expected = fixture["compatible"]
      raise Failure, "fixture states no verdict" unless [true, false].include?(expected)

      refusal = Matcher.render(fixture["refusalCode"])
      if code.nil?
        raise Failure, "accepted; expected refusal #{refusal}" unless expected
      elsif expected
        raise Failure, "refused a compatible installation: #{code}"
      elsif fixture["refusalCode"] != code
        raise Failure, "refused with #{code}; expected #{refusal}"
      end
    end

    def self.install_versions(connection, installed, served)
      sql(connection) do
        connection.exec("DELETE FROM workhorse.schema_version; DELETE FROM workhorse.protocol_version")
        served.each do |version|
          connection.exec_params("INSERT INTO workhorse.protocol_version (version) VALUES ($1)", [version])
        end
        if installed.nil?
          # No installed schema: the client must find no `workhorse` schema at all.
          connection.exec("ALTER SCHEMA workhorse RENAME TO workhorse_hidden")
        else
          connection.exec_params("INSERT INTO workhorse.schema_version (version) VALUES ($1)", [installed])
        end
      end
    end

    # Run a client call, reporting an SDK error the way the other lanes do.
    def self.client_call
      yield
    rescue Stablemates::Workhorse::DatabaseError => e
      raise Failure, "postgres: #{e.message.strip} (#{e.sqlstate})"
    rescue Stablemates::Workhorse::Error, ArgumentError => e
      raise Failure, e.message
    end

    private

    def client_call(&) = Runner.client_call(&)

    def each_fixture(category)
      @catalogue.category(category).each do |fixture|
        record(category, fixture, attempt { yield fixture })
      end
    end

    def attempt
      yield
      Outcome.passed
    rescue Failure => e
      Outcome.failed(e.message)
    end

    def record(category, fixture, outcome)
      @outcomes[Conformance.key(category, fixture)] = outcome
    end

    def located(location)
      yield
    rescue Failure => e
      raise Failure, "#{location}: #{e.message}"
    end

    def with_connection(url)
      connection = PG.connect(url, connect_timeout: ScratchDatabase::CONNECT_TIMEOUT)
      # `CREATE TABLE IF NOT EXISTS` reports a notice on every call after the first.
      connection.set_notice_receiver { nil }
      yield connection
    ensure
      connection&.close
    end
  end
end
