# frozen_string_literal: true

module Stablemates
  module Workhorse
    # Submits and controls tasks through the executor it holds.
    #
    # Every call runs on the connection the executor yields. When that connection holds the
    # caller's transaction, the call commits and rolls back with it: the SDK never opens, commits,
    # or rolls back a transaction of its own.
    class Queue
      DEFAULT_MAX_ATTEMPTS = 25
      DEFAULT_IDEMPOTENCY_TTL_MS = 86_400_000
      MAX_TASK_DEPENDENCIES = 100
      MAX_EXTERNAL_VALUE_BYTES = 65_536
      OUTCOMES = %w[accepted replayed replaced non_replaceable coalesced].freeze
      NON_REPLACEABLE_REASONS = %w[incompatible_key_mode not_pending window_elapsed_pending].freeze
      DEPENDENCY_POLICIES = %i[release cancel fail].freeze
      DEBOUNCE_SCHEDULES = %i[reset preserve].freeze
      CATCHUP_POLICIES = %i[skip latest all].freeze
      CANCEL_STATUSES = %i[canceled cancel_requested already_terminal not_found].freeze
      TASK_STATES = %i[blocked scheduled ready active succeeded failed canceled].freeze
      SIGNAL_STATUSES = %i[delivered duplicate not_waiting already_delivered stale not_found].freeze
      HUMAN_WAIT_STATUSES = %i[completed duplicate not_waiting already_completed stale not_found].freeze
      # Times one fenced write is sent at most when PostgreSQL rolls it back as a deadlock victim.
      FENCED_WRITE_DEADLOCK_ATTEMPTS = 3
      # The protocol's bounds, checked here so an invalid request raises before any statement.
      MAX_DURATION_MS = 31_536_000_000
      MAX_RATE_INTERVAL_MS = 86_400_000
      MAX_POLICY_VALUE = 1_000_000
      MAX_POLICY_DEFINITIONS = 10_000
      MAX_NAME_BYTES = 256
      MAX_KEY_BYTES = 512
      MAX_TAGS = 20
      MAX_TAG_LENGTH = 100
      RETRY_POLICY_FIELDS = {
        "fixed" => %w[delayMs],
        "exponential" => %w[initialDelayMs multiplier maxDelayMs],
        "decorrelated-jitter" => %w[baseDelayMs maxDelayMs]
      }.freeze
      private_constant :DEFAULT_MAX_ATTEMPTS, :DEFAULT_IDEMPOTENCY_TTL_MS, :MAX_TASK_DEPENDENCIES,
        :MAX_EXTERNAL_VALUE_BYTES, :OUTCOMES, :NON_REPLACEABLE_REASONS, :DEPENDENCY_POLICIES,
        :DEBOUNCE_SCHEDULES, :CATCHUP_POLICIES, :CANCEL_STATUSES, :TASK_STATES,
        :SIGNAL_STATUSES, :HUMAN_WAIT_STATUSES, :FENCED_WRITE_DEADLOCK_ATTEMPTS, :MAX_DURATION_MS,
        :MAX_RATE_INTERVAL_MS, :MAX_POLICY_VALUE, :MAX_POLICY_DEFINITIONS, :MAX_NAME_BYTES,
        :MAX_KEY_BYTES, :MAX_TAGS, :MAX_TAG_LENGTH, :RETRY_POLICY_FIELDS

      attr_reader :default_queue

      def initialize(executor, default_queue: "default")
        raise ArgumentError, "default queue must be a non-empty String" unless
          default_queue.is_a?(String) && !default_queue.empty?

        @executor = Executor.for(executor)
        @default_queue = default_queue
        @lock = Mutex.new
        @compatibility = nil
        @contracts_enabled = false
        @contracts = {}
      end

      # Runs the startup compatibility check once. A refusal is cached; a driver error is not.
      def assert_compatible
        code = @lock.synchronize do
          @compatibility = [Compatibility.evaluate(@executor)] if @compatibility.nil?
          @compatibility.first
        end
        raise CompatibilityError, code if code
      end

      # Submits one task.
      def enqueue(task_type, payload, **)
        enqueue_many([EnqueueRequest.new(task_type: task_type, payload: payload, **)]).first
      end

      # Submits one atomic batch and returns PostgreSQL's results in request order.
      def enqueue_many(requests)
        raise ArgumentError, "requests must be an Array of EnqueueRequest" unless
          requests.is_a?(Array) && requests.all?(EnqueueRequest)
        return [] if requests.empty?
        raise ArgumentError, "enqueue batch exceeds the shared limit" if
          requests.length > SqlCatalogue::MAX_ENQUEUE_BATCH_SIZE

        2.times do
          rows = enqueue_attempt(requests)
          task_types = contract_mismatch(rows)
          return enqueue_results(rows, requests.length) if task_types.nil?

          task_types.each do |task_type|
            contract = Contracts.load(@executor, task_type)
            @lock.synchronize { @contracts[task_type] = contract }
          end
        end
        raise ContractPolicyChangedError
      end

      # Requests cancellation. An active task stops at its next PostgreSQL-owned checkpoint.
      def cancel(task_id, requested_by:, reason: nil)
        task_id = Values.task_id(task_id)
        optional_string(requested_by, "requested by")
        optional_string(reason, "reason")
        assert_compatible
        row = exactly_one(@executor.rows(SqlCatalogue::CANCEL_V1, [task_id, requested_by, reason]), "cancel_v1")
        CancelResult.new(
          status: status(:cancel, row.fetch("status"), CANCEL_STATUSES),
          task_id: task_id,
          state: row.fetch("state") && status(:cancel, row.fetch("state"), TASK_STATES),
          current_attempt: Values.parse_integer(row.fetch("current_attempt")),
          requested_at: Values.parse_time(row.fetch("requested_at")),
          requested_by: row.fetch("requested_by"),
          reason: row.fetch("reason"),
          finished_at: Values.parse_time(row.fetch("finished_at"))
        )
      end

      # Delivers a named signal to a task waiting for it.
      def send_signal(task_id, name, payload, idempotency_key:, requested_by:)
        task_id = Values.task_id(task_id)
        document = validate_delivery("signal", "signal payload", name, payload, idempotency_key, requested_by)
        row = deliver(SqlCatalogue::SEND_SIGNAL_V1, "send_signal_v1", task_id, name, document, idempotency_key,
          requested_by)
        raise SignalIdempotencyConflictError.new(task_id, name) if row.fetch("status") == "conflict"

        SignalDeliveryResult.new(
          status: status(:send_signal, row.fetch("status"), SIGNAL_STATUSES),
          task_id: task_id,
          name: name,
          payload: Values.parse_json(row.fetch("payload")),
          delivered_at: Values.parse_time(row.fetch("delivered_at")),
          delivered_by: row.fetch("delivered_by")
        )
      end

      # Records a human decision for a task waiting on it.
      def complete_human_wait(task_id, name, result, idempotency_key:, requested_by:)
        task_id = Values.task_id(task_id)
        document = validate_delivery("human wait", "human wait result", name, result, idempotency_key,
          requested_by)
        row = deliver(SqlCatalogue::COMPLETE_HUMAN_WAIT_V1, "complete_human_wait_v1", task_id, name, document,
          idempotency_key, requested_by)
        raise HumanWaitIdempotencyConflictError.new(task_id, name) if row.fetch("status") == "conflict"

        HumanWaitCompletionResult.new(
          status: status(:complete_human_wait, row.fetch("status"), HUMAN_WAIT_STATUSES),
          task_id: task_id,
          name: name,
          payload: Values.parse_json(row.fetch("result")),
          completed_at: Values.parse_time(row.fetch("completed_at")),
          completed_by: row.fetch("completed_by")
        )
      end

      # PostgreSQL's queue health snapshot over the last day, as a Hash.
      def health
        assert_compatible
        since = Values.timestamp(Time.now - 86_400, "since")
        row = exactly_one(@executor.rows(SqlCatalogue::QUEUE_HEALTH_V1, [since]), "queue_health_v1")
        snapshot = Values.parse_json(row.fetch("snapshot"))
        raise ArgumentError, "workhorse.queue_health_v1 returned a non-object snapshot" unless snapshot.is_a?(Hash)

        snapshot
      end

      # Makes +schedules+ the namespace's schedules. +prune+ removes the rest.
      def sync_schedules(namespace, schedules, prune: true)
        required_string(namespace, "namespace")
        raise ArgumentError, "schedules must be an Array of ScheduleDefinition" unless
          schedules.is_a?(Array) && schedules.all?(ScheduleDefinition)

        document = schedules.each_with_index.map do |definition, index|
          schedule_document(definition)
        rescue ArgumentError => e
          raise ArgumentError, "schedule definition #{index + 1}: invalid schedule definition: #{e.message}"
        end
        params = [namespace, Values.json(document), boolean(prune, "prune").to_s]
        assert_compatible
        @executor.rows(SqlCatalogue::SYNC_SCHEDULE_DEFINITIONS_V2, params)
        nil
      end

      # Makes +contracts+, a Hash of task type to TaskTypeContracts, PostgreSQL's contract
      # definitions, and validates later enqueues against them.
      def sync_contracts(contracts)
        document = Values.json(Contracts.document(contracts), "contracts")
        assert_compatible
        @executor.rows(SqlCatalogue::SYNC_CONTRACT_DEFINITIONS_V1, [document])
        @lock.synchronize do
          @contracts.clear
          @contracts_enabled = true
        end
        nil
      end

      # Makes +definitions+ the namespace's concurrency policies and returns the stored policies.
      # +prune+ removes the namespace's other policies.
      def sync_concurrency_policies(namespace, definitions, prune: true)
        document = sync_document(definitions, ConcurrencyPolicyDefinition, "concurrency policy", :queue) do |definition|
          max_active = integer(definition.max_active, 1..MAX_POLICY_VALUE, "max active")
          per_key = definition.max_active_per_key
          {"queue" => definition.queue, "maxActive" => max_active,
           "maxActivePerKey" => per_key && integer(per_key, 1..max_active, "max active per key")}
        end
        rows = fenced_write(SqlCatalogue::SYNC_CONCURRENCY_POLICIES_V1, sync_params(namespace, document, prune))
        rows.map { |row| Policies.concurrency_policy(row) }
      end

      # Makes +definitions+ the namespace's rate limit policies and returns the stored policies.
      # +prune+ removes the namespace's other policies.
      def sync_rate_limit_policies(namespace, definitions, prune: true)
        document = sync_document(definitions, RateLimitPolicyDefinition, "rate limit policy", :queue) do |definition|
          {"queue" => definition.queue, "rate" => rate_limit_document(definition.rate, "rate"),
           "perKey" => definition.per_key && rate_limit_document(definition.per_key, "per key")}
        end
        rows = @executor.rows(SqlCatalogue::SYNC_RATE_LIMIT_POLICIES_V1, sync_params(namespace, document, prune))
        rows.map { |row| Policies.rate_limit_policy(row) }
      end

      # Makes +definitions+ the namespace's budgets and returns the stored budgets. +prune+
      # removes the namespace's other budgets.
      def sync_budgets(namespace, definitions, prune: true)
        document = sync_document(definitions, BudgetDefinition, "budget", :name) do |definition|
          raise ArgumentError, "budget requires max active, rate, or both" if
            definition.max_active.nil? && definition.rate.nil?

          {"name" => definition.name,
           "maxActive" => definition.max_active && integer(definition.max_active, 1..MAX_POLICY_VALUE, "max active"),
           "rate" => definition.rate && rate_limit_document(definition.rate, "rate")}
        end
        rows = @executor.rows(SqlCatalogue::SYNC_BUDGETS_V1, sync_params(namespace, document, prune))
        rows.map { |row| Policies.budget(row) }
      end

      # The concurrency policies of +queues+, or of every queue when +queues+ is nil or empty.
      def list_concurrency_policies(queues: nil)
        list(SqlCatalogue::LIST_CONCURRENCY_POLICIES, queues, "queues").map { |row| Policies.concurrency_policy(row) }
      end

      # The rate limit policies of +queues+, or of every queue when +queues+ is nil or empty.
      def list_rate_limit_policies(queues: nil)
        list(SqlCatalogue::LIST_RATE_LIMIT_POLICIES, queues, "queues").map { |row| Policies.rate_limit_policy(row) }
      end

      # The budgets named in +names+, or every budget when +names+ is nil or empty.
      def list_budgets(names: nil)
        list(SqlCatalogue::LIST_BUDGETS, names, "names").map { |row| Policies.budget(row) }
      end

      private

      def enqueue_attempt(requests)
        now = Time.now
        inputs = requests.each_with_index.map do |request, index|
          serialize_request(request, now)
        rescue ArgumentError => e
          raise ArgumentError, "enqueue request #{index + 1}: #{e.message}"
        end
        assert_compatible
        inputs.zip(requests) { |input, request| apply_contract(input, request) }
        @executor.rows(SqlCatalogue::ENQUEUE_MANY_V1, [JSON.generate(inputs)])
      end

      def serialize_request(request, now)
        begin
          validate_options(request)
        rescue ArgumentError => e
          raise ArgumentError, "invalid enqueue options: #{e.message}"
        end
        Values.check_json(request.payload, "payload")
        input = task_input(request)
        keyed = request.idempotency || request.debounce || request.throttle
        input["runAt"] = Values.timestamp(request.run_at || now, "run at") if request.run_at || !keyed
        input["deadline"] = request.deadline && Values.timestamp(request.deadline, "deadline")
        input["budget"] = optional_bytes(request.budget, MAX_NAME_BYTES, "budget")
        timeout = request.execution_timeout &&
          Values.milliseconds(request.execution_timeout, "execution timeout", 0..MAX_DURATION_MS)
        input["executionTimeoutMs"] = timeout&.zero? ? nil : timeout
        input["prerequisiteTaskId"] = nil
        input["dependencies"] = request.dependencies && dependencies_document(request.dependencies)
        input["tags"] = tags(request.tags)
        input["idempotency"] = idempotency_document(request.idempotency) if request.idempotency
        input["debounce"] = debounce_document(request.debounce) if request.debounce
        input["throttle"] = throttle_document(request.throttle) if request.throttle
        input
      end

      def validate_options(request)
        keyed = [request.idempotency, request.debounce, request.throttle].compact
        raise ArgumentError, "cannot combine idempotency, debounce, or throttle" if keyed.length > 1
        if request.debounce && request.run_at
          raise ArgumentError, "debounced enqueue uses its PostgreSQL-owned window instead of run at"
        end
        return if request.dependencies.nil?

        raise ArgumentError, "cannot combine debounce or throttle with dependencies" if
          request.debounce || request.throttle
        raise ArgumentError, "dependencies must be a Dependencies" unless request.dependencies.is_a?(Dependencies)

        ids = request.dependencies.prerequisite_task_ids
        raise ArgumentError, "dependencies must contain unique prerequisite task IDs" unless ids.is_a?(Array)

        ids = ids.map { |id| Values.task_id(id, "prerequisite task ID") }
        raise ArgumentError, "dependencies must contain unique prerequisite task IDs" if
          ids.empty? || ids.uniq.length != ids.length
        raise ArgumentError, "dependencies accepts at most 100 prerequisite task IDs" if
          ids.length > MAX_TASK_DEPENDENCIES
      end

      # The fields an enqueued or scheduled task shares, from an EnqueueRequest or a ScheduledTask.
      # A nil or zero +max_attempts+ takes the default.
      def task_input(task)
        max_attempts = task.max_attempts
        {
          "queue" => optional_bytes(task.queue, MAX_NAME_BYTES, "queue") || @default_queue,
          "type" => required_string(task.task_type, "task type"),
          "payload" => task.payload,
          "priority" => task.priority.nil? ? 0 : integer(task.priority, 0..100, "priority"),
          "concurrencyKey" => optional_bytes(task.concurrency_key, MAX_NAME_BYTES, "concurrency key"),
          "maxAttempts" => (max_attempts.nil? || max_attempts == 0) ? DEFAULT_MAX_ATTEMPTS :
            integer(max_attempts, 1..100, "max attempts"),
          "retryPolicy" => retry_policy(task.retry_policy),
          "contractVersion" => nil,
          "payloadMaxBytes" => SqlCatalogue::DEFAULT_TASK_VALUE_MAX_BYTES,
          "resultMaxBytes" => SqlCatalogue::DEFAULT_TASK_VALUE_MAX_BYTES,
          "sensitivePayloadKeys" => [],
          "sensitiveResultKeys" => []
        }
      end

      def dependencies_document(dependencies)
        {
          "prerequisiteTaskIds" => dependencies.prerequisite_task_ids
            .map { |id| Values.task_id(id, "prerequisite task ID") }.sort,
          "onSuccess" => choice(dependencies.on_success, DEPENDENCY_POLICIES, "on success"),
          "onFailure" => choice(dependencies.on_failure, DEPENDENCY_POLICIES, "on failure"),
          "onCancellation" => choice(dependencies.on_cancellation, DEPENDENCY_POLICIES, "on cancellation")
        }
      end

      def idempotency_document(idempotency)
        raise ArgumentError, "idempotency must be an Idempotency" unless idempotency.is_a?(Idempotency)

        ttl = Values.milliseconds(idempotency.ttl, "idempotency TTL", 0..MAX_DURATION_MS)
        {
          "key" => required_bytes(idempotency.key, MAX_KEY_BYTES, "idempotency key"),
          "scope" => scope(idempotency.scope),
          "ttlMs" => ttl.zero? ? DEFAULT_IDEMPOTENCY_TTL_MS : ttl
        }
      end

      def debounce_document(debounce)
        raise ArgumentError, "debounce must be a Debounce" unless debounce.is_a?(Debounce)

        {
          "key" => required_bytes(debounce.key, MAX_KEY_BYTES, "debounce key"),
          "scope" => scope(debounce.scope),
          "windowMs" => Values.milliseconds(debounce.window, "debounce window", 1..MAX_DURATION_MS),
          "schedule" => choice(debounce.schedule, DEBOUNCE_SCHEDULES, "debounce schedule")
        }
      end

      def throttle_document(throttle)
        raise ArgumentError, "throttle must be a Throttle" unless throttle.is_a?(Throttle)

        {
          "key" => required_bytes(throttle.key, MAX_KEY_BYTES, "throttle key"),
          "scope" => scope(throttle.scope),
          "windowMs" => Values.milliseconds(throttle.window, "throttle window", 1..MAX_DURATION_MS)
        }
      end

      def schedule_document(definition)
        task = definition.task
        raise ArgumentError, "task must be a ScheduledTask" unless task.is_a?(ScheduledTask)

        Values.check_json(task.payload, "payload")
        task_input(task).merge(
          "name" => required_string(definition.name, "name"),
          "schedule" => required_string(definition.schedule, "schedule"),
          "timezone" => required_string(definition.timezone, "timezone"),
          "catchupPolicy" => choice(definition.catchup_policy, CATCHUP_POLICIES, "catchup policy"),
          "enabled" => boolean(definition.enabled, "enabled")
        )
      end

      # Validates a contracted payload and stamps the contract fields PostgreSQL enforces.
      def apply_contract(input, request)
        task_type = request.task_type
        known, contract, enabled = @lock.synchronize do
          [@contracts.key?(task_type), @contracts[task_type], @contracts_enabled]
        end
        if !known && enabled
          contract = Contracts.load(@executor, task_type)
          @lock.synchronize { @contracts[task_type] = contract }
        end
        return if contract.nil?
        raise ContractValidationError.new(task_type, contract.version) unless contract.schema.valid?(request.payload)

        input["contractVersion"] = contract.version
        input["payloadMaxBytes"] = contract.payload_max_bytes
        input["resultMaxBytes"] = contract.result_max_bytes
        input["sensitivePayloadKeys"] = contract.payload_redact_keys
        input["sensitiveResultKeys"] = contract.result_redact_keys
      end

      # The task types PostgreSQL named when a batch carried a stale contract, or nil.
      def contract_mismatch(rows)
        row = rows.find { |candidate| candidate["outcome"] == "contract_mismatch" }
        return nil if row.nil?

        detail = begin
          JSON.parse(row["reason"] || "")
        rescue JSON::ParserError
          nil
        end
        task_types = detail.is_a?(Hash) ? detail["taskTypes"] : nil
        raise invalid_result unless task_types.is_a?(Array) && task_types.all?(String)

        task_types
      end

      def enqueue_results(rows, count)
        raise invalid_result unless rows.length == count

        results = Array.new(count)
        rows.each do |row|
          index = Integer(row.fetch("ordinal"), 10) - 1
          raise invalid_result unless index.between?(0, count - 1) && results[index].nil?

          results[index] = enqueue_result(row)
        end
        results
      end

      def enqueue_result(row)
        outcome = row.fetch("outcome")
        reason = row.fetch("reason")
        raise UnexpectedStatusError.new(:enqueue, outcome) unless OUTCOMES.include?(outcome)
        raise invalid_result unless
          (outcome == "non_replaceable") ? NON_REPLACEABLE_REASONS.include?(reason) : reason.nil?

        EnqueueResult.new(task_id: row.fetch("task_id"), outcome: outcome.to_sym)
      end

      def invalid_result = ArgumentError.new("PostgreSQL returned an invalid enqueue result")

      def validate_delivery(label, value_label, name, value, idempotency_key, requested_by)
        unless name.is_a?(String) && name.strip == name && name.length.between?(1, 200)
          raise ArgumentError, "#{label} name must contain between 1 and 200 characters without surrounding whitespace"
        end

        document = Values.json(value, value_label)
        raise ArgumentError, "#{value_label} must be at most 65536 bytes of JSON" if
          document.bytesize > MAX_EXTERNAL_VALUE_BYTES
        unless idempotency_key.is_a?(String) && idempotency_key.bytesize.between?(1, 512)
          raise ArgumentError, "#{label} idempotency key must contain between 1 and 512 UTF-8 bytes"
        end
        unless requested_by.is_a?(String) && requested_by.length.between?(1, 200)
          raise ArgumentError, "#{label} requested by must contain between 1 and 200 characters"
        end

        document
      end

      def deliver(statement, function, task_id, name, document, idempotency_key, requested_by)
        assert_compatible
        exactly_one(@executor.rows(statement, [task_id, name, document, idempotency_key, requested_by]), function)
      end

      # The JSON array a policy sync sends, one object per definition the block encodes. Each
      # definition's +name+ attribute must be unique.
      def sync_document(definitions, type, label, name)
        raise ArgumentError, "definitions must be an Array of #{type.name.split("::").last}" unless
          definitions.is_a?(Array) && definitions.all?(type)
        raise ArgumentError, "#{label} definitions exceed the limit of #{MAX_POLICY_DEFINITIONS}" if
          definitions.length > MAX_POLICY_DEFINITIONS

        document = definitions.each_with_index.map do |definition, index|
          required_bytes(definition.public_send(name), MAX_NAME_BYTES, name.to_s)
          yield definition
        rescue ArgumentError => e
          raise ArgumentError, "#{label} definition #{index + 1}: #{e.message}"
        end
        names = definitions.map(&name)
        raise ArgumentError, "#{label} #{name} names must be unique" unless names.uniq.length == names.length

        Values.json(document, "#{label} definitions")
      end

      def sync_params(namespace, document, prune)
        required_bytes(namespace, MAX_NAME_BYTES, "namespace")
        params = [namespace, document, boolean(prune, "prune").to_s]
        assert_compatible
        params
      end

      def rate_limit_document(rate, label)
        raise ArgumentError, "#{label} must be a RateLimit" unless rate.is_a?(RateLimit)

        {
          "limit" => integer(rate.limit, 1..MAX_POLICY_VALUE, "#{label} limit"),
          "intervalMs" => Values.milliseconds(rate.interval, "#{label} interval", 1..MAX_RATE_INTERVAL_MS),
          "burst" => integer(rate.burst, 1..MAX_POLICY_VALUE, "#{label} burst")
        }
      end

      # +policy+ after checking the shape and bounds PostgreSQL's retry policy accepts.
      def retry_policy(policy)
        return nil if policy.nil?
        raise ArgumentError, "retry policy must be a Hash" unless policy.is_a?(Hash)

        Values.check_json(policy, "retry policy")
        type = policy["type"]
        fields = RETRY_POLICY_FIELDS[type] or
          raise ArgumentError, "retry policy type must be fixed, exponential, or decorrelated-jitter"
        raise ArgumentError, "#{type} retry policy requires exactly type, #{fields.join(", ")}" unless
          policy.keys.sort == [*fields, "type"].sort

        fields.each do |field|
          range = (field == "multiplier") ? 1..100 : 0..MAX_DURATION_MS
          value = policy[field]
          raise ArgumentError, "retry policy #{field} must be an integer between #{range.begin} and #{range.end}" unless
            whole?(value) && range.cover?(value)
        end
        floor = policy["initialDelayMs"] || policy["baseDelayMs"]
        raise ArgumentError, "retry policy maxDelayMs must be at least #{floor}" if floor && policy["maxDelayMs"] < floor

        policy
      end

      def whole?(value) = value.is_a?(Integer) || (value.is_a?(Float) && value == value.floor)

      def integer(value, range, label)
        raise ArgumentError, "#{label} must be an Integer between #{range.begin} and #{range.end}" unless
          value.is_a?(Integer) && range.cover?(value)

        value
      end

      # Sends a fenced write, and sends it again when PostgreSQL chose it as a deadlock victim.
      #
      # PostgreSQL rolls back the whole statement, and a resend writes the same complete desired
      # set. A deadlock aborts a caller-owned transaction, so a resend there fails with 25P02, and
      # the caller gets the original deadlock instead.
      def fenced_write(statement, params)
        deadlock = nil
        attempt = 1
        begin
          @executor.rows(statement, params)
        rescue DatabaseError => e
          raise deadlock if deadlock && e.sqlstate == "25P02"
          raise if attempt >= FENCED_WRITE_DEADLOCK_ATTEMPTS || e.sqlstate != "40P01"

          deadlock = e
          attempt += 1
          retry
        end
      end

      def list(statement, names, label)
        @executor.rows(statement, [Values.text_array(names || [], label)])
      end

      def exactly_one(rows, function)
        return rows.first if rows.one?

        raise ArgumentError, "workhorse.#{function} returned #{rows.length} rows; expected one"
      end

      def status(operation, text, known)
        value = text.to_sym
        raise UnexpectedStatusError.new(operation, text) unless known.include?(value)

        value
      end

      def tags(values)
        return [] if values.nil?
        unless values.is_a?(Array) && values.length <= MAX_TAGS &&
            values.all? { |tag| tag.is_a?(String) && tag.length.between?(1, MAX_TAG_LENGTH) }
          raise ArgumentError, "tags must be an Array of at most #{MAX_TAGS} Strings of 1 to #{MAX_TAG_LENGTH} characters"
        end

        values
      end

      def choice(value, allowed, label)
        raise ArgumentError, "#{label} must be one of #{allowed.map(&:inspect).join(", ")}" unless
          allowed.include?(value)

        value.to_s
      end

      def boolean(value, label)
        raise ArgumentError, "#{label} must be true or false" unless [true, false].include?(value)

        value
      end

      def scope(value) = optional_bytes(value, MAX_NAME_BYTES, "scope") || "default"

      def non_empty(value) = (value.nil? || value.empty?) ? nil : value

      def required_string(value, label)
        raise ArgumentError, "#{label} must be a non-empty String" unless value.is_a?(String) && !value.empty?

        value
      end

      def optional_string(value, label)
        raise ArgumentError, "#{label} must be a String" unless value.nil? || value.is_a?(String)

        value
      end

      def required_bytes(value, max, label)
        raise ArgumentError, "#{label} must contain between 1 and #{max} UTF-8 bytes" unless
          value.is_a?(String) && value.bytesize.between?(1, max)

        value
      end

      # +value+, or nil when it is nil or empty. A String longer than +max+ UTF-8 bytes raises.
      def optional_bytes(value, max, label)
        value = non_empty(optional_string(value, label))
        raise ArgumentError, "#{label} must contain at most #{max} UTF-8 bytes" if value && value.bytesize > max

        value
      end
    end
  end
end
